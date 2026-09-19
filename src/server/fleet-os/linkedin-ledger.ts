import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'node:fs'
import path from 'node:path'
import { fleetOsHome } from './store'

/** LinkedIn outreach harness ledger event (see linkedin-outreach-harness/references/ledger.md). */
export type LinkedInLedgerEvent = {
  id: string
  ts: string
  identity: string
  principal: string
  campaign: string
  prospect_key: string
  action: 'connect' | 'message' | 'post' | 'follow' | 'skip' | 'hold'
  copy_hash: string
  platform: string
  runner: string
  result: 'staged' | 'sent' | 'skipped' | 'held' | 'failed'
  reason?: string
}

export type LinkedInLedger = {
  append(event: LinkedInLedgerEvent): void
  find(query: {
    identity?: string
    prospect_key?: string
    action?: string
    result?: string
    externalRef?: string
  }): LinkedInLedgerEvent | null
  all(): LinkedInLedgerEvent[]
}

export class MemoryLinkedInLedger implements LinkedInLedger {
  private events: LinkedInLedgerEvent[] = []

  constructor(seed: LinkedInLedgerEvent[] = []) {
    this.events = [...seed]
  }

  append(event: LinkedInLedgerEvent): void {
    this.events.push(event)
  }

  find(query: {
    identity?: string
    prospect_key?: string
    action?: string
    result?: string
    externalRef?: string
  }): LinkedInLedgerEvent | null {
    return this.events.find((event) => {
      if (query.externalRef && event.id !== query.externalRef) return false
      if (query.identity && event.identity !== query.identity) return false
      if (query.prospect_key && event.prospect_key !== query.prospect_key) return false
      if (query.action && event.action !== query.action) return false
      if (query.result && event.result !== query.result) return false
      return true
    }) ?? null
  }

  all(): LinkedInLedgerEvent[] {
    return [...this.events]
  }
}

export class FileLinkedInLedger implements LinkedInLedger {
  constructor(private readonly filePath: string) {
    mkdirSync(path.dirname(filePath), { recursive: true })
    if (!existsSync(filePath)) appendFileSync(filePath, '')
  }

  append(event: LinkedInLedgerEvent): void {
    appendFileSync(this.filePath, JSON.stringify(event) + '\n')
  }

  all(): LinkedInLedgerEvent[] {
    const raw = readFileSync(this.filePath, 'utf-8').trim()
    if (!raw) return []
    return raw.split('\n').map((line) => JSON.parse(line) as LinkedInLedgerEvent)
  }

  find(query: {
    identity?: string
    prospect_key?: string
    action?: string
    result?: string
    externalRef?: string
  }): LinkedInLedgerEvent | null {
    return new MemoryLinkedInLedger(this.all()).find(query)
  }
}

export function defaultLinkedInLedgerPath(): string {
  return process.env.FLEET_LINKEDIN_LEDGER
    ?? path.join(fleetOsHome(), 'linkedin-ledger.jsonl')
}

export function openLinkedInLedger(filePath = defaultLinkedInLedgerPath()): FileLinkedInLedger {
  return new FileLinkedInLedger(filePath)
}

/** Append harness ledger events without duplicating ids. */
export function ingestLinkedInLedgerEvents(
  events: LinkedInLedgerEvent[],
  ledger: LinkedInLedger = openLinkedInLedger(),
): { appended: number; skipped: number; total: number } {
  const existing = new Set(ledger.all().map((item) => item.id))
  let appended = 0
  let skipped = 0
  for (const event of events) {
    if (!event.id) {
      skipped += 1
      continue
    }
    if (existing.has(event.id)) {
      skipped += 1
      continue
    }
    ledger.append(event)
    existing.add(event.id)
    appended += 1
  }
  return { appended, skipped, total: existing.size }
}

export function alreadyTouched(
  ledger: LinkedInLedger,
  identity: string,
  prospectKey: string,
  action: LinkedInLedgerEvent['action'],
): boolean {
  const hit = ledger.find({ identity, prospect_key: prospectKey, action })
  return Boolean(hit && (hit.result === 'sent' || hit.result === 'staged'))
}

export function verifyLinkedInSend(
  ledger: LinkedInLedger,
  input: { externalRef?: string; identity?: string; prospect_key?: string; action?: string },
): { ok: boolean; event: LinkedInLedgerEvent | null; reason: string } {
  const event = input.externalRef
    ? ledger.find({ externalRef: input.externalRef })
    : ledger.find({
      identity: input.identity,
      prospect_key: input.prospect_key,
      action: input.action,
      result: 'sent',
    })
  if (!event) return { ok: false, event: null, reason: 'No ledger event proves the LinkedIn send.' }
  if (event.result !== 'sent') return { ok: false, event, reason: `Ledger result is ${event.result}, not sent.` }
  return { ok: true, event, reason: 'LinkedIn send verified in outreach ledger.' }
}
