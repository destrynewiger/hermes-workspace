#!/usr/bin/env node
/**
 * Refresh durable Attio + Gmail/Calendar proof caches from an agent that has MCP access.
 *
 * Usage (payload files written by the agent after MCP calls):
 *   pnpm fleet-refresh-sot --attio data/attio-refresh.json --sot data/mcp-sot-refresh.json
 *
 * Or apply inline defaults already on disk:
 *   pnpm fleet-refresh-sot --prove
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { upsertAttioLiveSnapshot, loadAttioLiveSnapshot } from './attio-cache'
import { upsertMcpSotSnapshot, loadMcpSotSnapshot } from './mcp-sot-cache'
import { reconcileAgainstLiveAttio } from './attio-live'
import { verifyGmailSend, verifyCalendarCreate } from './sot-verify'
import { storesFromMcpSotSnapshot } from './mcp-sot-cache'

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return undefined
}

async function main() {
  const attioPath = arg('attio')
  const sotPath = arg('sot')
  const prove = process.argv.includes('--prove')

  let attio = loadAttioLiveSnapshot()
  if (attioPath && existsSync(attioPath)) {
    const payload = JSON.parse(readFileSync(attioPath, 'utf8')) as {
      companies?: Array<{ recordId: string; name: string; domain?: string }>
      people?: Array<{ recordId: string; name: string; email?: string; linkedinUrl?: string; companyKey?: string }>
      workspace?: string
      source?: string
    }
    attio = upsertAttioLiveSnapshot({
      companies: payload.companies,
      people: payload.people,
      workspace: payload.workspace,
      source: payload.source ?? 'attio-mcp-refresh',
    })
  }

  let sot = loadMcpSotSnapshot()
  if (sotPath && existsSync(sotPath)) {
    const payload = JSON.parse(readFileSync(sotPath, 'utf8')) as {
      gmailSent?: Array<{ messageId: string; identity: string; to: string; subject?: string; at: number }>
      calendarEvents?: Array<{ eventId: string; calendarId: string; identity: string; title: string; at: number }>
      source?: string
    }
    sot = upsertMcpSotSnapshot({
      gmailSent: payload.gmailSent,
      calendarEvents: payload.calendarEvents,
      source: payload.source ?? 'mcp-sot-refresh',
    })
  }

  const report: Record<string, unknown> = {
    attioPeople: attio?.people.length ?? 0,
    attioCompanies: attio?.companies.length ?? 0,
    attioSource: attio?.source,
    gmailProofs: sot?.gmailSent.length ?? 0,
    calendarProofs: sot?.calendarEvents.length ?? 0,
  }

  if (prove) {
    const reconcile = await reconcileAgainstLiveAttio([
      { key: 'person:alex', name: 'Alex Newiger', email: 'alex@byteport.com', company: 'Byteport' },
      { key: 'person:jayram', name: 'Jayram Palamadai', email: 'jayram@byteport.com', company: 'Byteport' },
    ])
    const { gmailSent, calendarEvents } = storesFromMcpSotSnapshot()
    const sampleMail = sot?.gmailSent[0]
    const sampleCal = sot?.calendarEvents[0]
    report.prove = {
      attioMode: reconcile.mode,
      existing: reconcile.existing,
      attioIds: reconcile.attioIds,
      verified: reconcile.verified,
      gmail: sampleMail
        ? verifyGmailSend(gmailSent, { messageId: sampleMail.messageId })
        : { ok: false, reason: 'no gmail proofs' },
      calendar: sampleCal
        ? verifyCalendarCreate(calendarEvents, { eventId: sampleCal.eventId })
        : { ok: false, reason: 'no calendar proofs' },
    }
  }

  const outPath = arg('out')
  if (outPath) writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
