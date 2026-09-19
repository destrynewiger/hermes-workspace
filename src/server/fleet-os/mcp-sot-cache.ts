/**
 * Seedable proof caches for Gmail Sent and Google Calendar.
 * Cloud agents refresh these from MCP; workers verify email.send / calendar.create
 * against the durable cache when live API keys are unavailable.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CalendarEventProof, GmailSentProof } from './sot-verify'
import { MemoryCalendarStore, MemoryGmailSentStore } from './sot-verify'

export type McpSotSnapshot = {
  fetchedAt: string
  source: string
  gmailSent: GmailSentProof[]
  calendarEvents: CalendarEventProof[]
}

function packageDataDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), 'data')
}

export function defaultMcpSotSnapshotPath(): string {
  return process.env.FLEET_MCP_SOT_SNAPSHOT
    ?? path.join(packageDataDir(), 'mcp-sot-snapshot.json')
}

export function loadMcpSotSnapshot(filePath = defaultMcpSotSnapshotPath()): McpSotSnapshot | null {
  if (!existsSync(filePath)) return null
  try {
    const raw = JSON.parse(readFileSync(filePath, 'utf8')) as McpSotSnapshot
    if (!Array.isArray(raw.gmailSent) || !Array.isArray(raw.calendarEvents)) return null
    return raw
  } catch {
    return null
  }
}

export function saveMcpSotSnapshot(
  snapshot: McpSotSnapshot,
  filePath = defaultMcpSotSnapshotPath(),
): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  writeFileSync(filePath, JSON.stringify(snapshot, null, 2) + '\n', 'utf8')
}

export function upsertMcpSotSnapshot(input: {
  gmailSent?: GmailSentProof[]
  calendarEvents?: CalendarEventProof[]
  source?: string
  filePath?: string
}): McpSotSnapshot {
  const filePath = input.filePath ?? defaultMcpSotSnapshotPath()
  const prior = loadMcpSotSnapshot(filePath) ?? {
    fetchedAt: new Date(0).toISOString(),
    source: 'empty',
    gmailSent: [],
    calendarEvents: [],
  }
  const gmailSent = [...prior.gmailSent]
  for (const item of input.gmailSent ?? []) {
    const idx = gmailSent.findIndex((row) => row.messageId === item.messageId)
    if (idx >= 0) gmailSent[idx] = { ...gmailSent[idx], ...item }
    else gmailSent.push(item)
  }
  const calendarEvents = [...prior.calendarEvents]
  for (const item of input.calendarEvents ?? []) {
    const idx = calendarEvents.findIndex((row) => row.eventId === item.eventId)
    if (idx >= 0) calendarEvents[idx] = { ...calendarEvents[idx], ...item }
    else calendarEvents.push(item)
  }
  const next: McpSotSnapshot = {
    fetchedAt: new Date().toISOString(),
    source: input.source ?? prior.source,
    gmailSent,
    calendarEvents,
  }
  saveMcpSotSnapshot(next, filePath)
  return next
}

/** Build in-memory proof stores from the durable MCP snapshot. */
export function storesFromMcpSotSnapshot(filePath = defaultMcpSotSnapshotPath()): {
  gmailSent: MemoryGmailSentStore
  calendarEvents: MemoryCalendarStore
  snapshot: McpSotSnapshot | null
} {
  const snapshot = loadMcpSotSnapshot(filePath)
  return {
    gmailSent: new MemoryGmailSentStore(snapshot?.gmailSent ?? []),
    calendarEvents: new MemoryCalendarStore(snapshot?.calendarEvents ?? []),
    snapshot,
  }
}

/** Map Gmail search_threads hits into Sent proofs. */
export function gmailProofsFromMcpThreads(threads: Array<{
  id?: string
  messages?: Array<{
    id?: string
    sender?: string
    toRecipients?: string[]
    subject?: string
    date?: string
    labelIds?: string[]
  }>
}>, identity = 'alex-gmail'): GmailSentProof[] {
  const proofs: GmailSentProof[] = []
  for (const thread of threads) {
    for (const message of thread.messages ?? []) {
      const labels = message.labelIds ?? []
      if (!labels.includes('SENT')) continue
      const messageId = message.id ?? thread.id
      const to = message.toRecipients?.[0]
      if (!messageId || !to) continue
      proofs.push({
        messageId,
        identity,
        to,
        subject: message.subject,
        at: message.date ? Date.parse(message.date) || Date.now() : Date.now(),
      })
    }
  }
  return proofs
}

/** Map Calendar search_events hits into calendar proofs. */
export function calendarProofsFromMcpEvents(events: Array<{
  id?: string
  summary?: string
  creator?: { email?: string; self?: boolean }
  organizer?: { email?: string; self?: boolean }
  created?: string
  updated?: string
}>, identity = 'alex-calendar', calendarId = 'primary'): CalendarEventProof[] {
  const proofs: CalendarEventProof[] = []
  for (const event of events) {
    if (!event.id || !event.summary) continue
    proofs.push({
      eventId: event.id,
      calendarId,
      identity,
      title: event.summary,
      at: Date.parse(event.updated ?? event.created ?? '') || Date.now(),
    })
  }
  return proofs
}
