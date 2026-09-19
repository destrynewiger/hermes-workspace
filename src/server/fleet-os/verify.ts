import type { JobRecord } from './types'

export type EvidenceItem = { kind: string; reference: string; verified: boolean }

export type VerificationResult = {
  ok: boolean
  state: 'verified' | 'unverified' | 'not_required'
  evidence: EvidenceItem[]
  reason: string
}

const EXTERNAL_KINDS = new Set([
  'linkedin.send',
  'email.send',
  'attio.update',
  'attio.reconcile',
  'calendar.create',
])

export function requiresVerification(kind: string): boolean {
  return EXTERNAL_KINDS.has(kind) || kind.endsWith('.send') || kind.endsWith('.update')
}

export function verifyJobResult(job: Pick<JobRecord, 'kind' | 'result' | 'evidence'>, options?: {
  attioLookup?: (attioId: string) => boolean
  sentLookup?: (reference: string) => boolean
  calendarLookup?: (eventId: string) => boolean
}): VerificationResult {
  if (!requiresVerification(job.kind)) {
    return {
      ok: true,
      state: 'not_required',
      evidence: job.evidence ?? [],
      reason: 'Internal work does not require external verification.',
    }
  }

  const evidence = [...(job.evidence ?? [])]
  const result = job.result ?? {}

  if (job.kind === 'attio.reconcile' || job.kind === 'attio.update') {
    const ids = Array.isArray(result.attioIds)
      ? result.attioIds.filter((id): id is string => typeof id === 'string')
      : typeof result.attioId === 'string'
        ? [result.attioId]
        : []
    if (!ids.length) {
      return { ok: false, state: 'unverified', evidence, reason: 'Attio result missing attioIds.' }
    }
    const lookup = options?.attioLookup ?? (() => true)
    const missing = ids.filter((id) => !lookup(id))
    if (missing.length) {
      return { ok: false, state: 'unverified', evidence, reason: `Attio ids not found: ${missing.join(', ')}` }
    }
    evidence.push({ kind: 'attio', reference: ids.join(','), verified: true })
    return { ok: true, state: 'verified', evidence, reason: 'Attio records verified.' }
  }

  if (job.kind === 'linkedin.send' || job.kind === 'email.send') {
    const ref = typeof result.externalRef === 'string'
      ? result.externalRef
      : typeof result.messageId === 'string'
        ? result.messageId
        : null
    if (!ref) {
      return { ok: false, state: 'unverified', evidence, reason: 'Send result missing externalRef/messageId.' }
    }
    const lookup = options?.sentLookup ?? (() => false)
    if (!lookup(ref) && !evidence.some((item) => item.verified && item.reference === ref)) {
      return { ok: false, state: 'unverified', evidence, reason: 'External send not found in Sent/ledger.' }
    }
    evidence.push({ kind: job.kind, reference: ref, verified: true })
    return { ok: true, state: 'verified', evidence, reason: 'External send verified.' }
  }

  if (job.kind === 'calendar.create') {
    const eventId = typeof result.eventId === 'string' ? result.eventId : null
    if (!eventId) {
      return { ok: false, state: 'unverified', evidence, reason: 'Calendar result missing eventId.' }
    }
    const lookup = options?.calendarLookup ?? (() => false)
    if (!lookup(eventId) && !evidence.some((item) => item.verified && item.reference === eventId)) {
      return { ok: false, state: 'unverified', evidence, reason: 'Calendar event not found on the calendar.' }
    }
    evidence.push({ kind: 'calendar', reference: eventId, verified: true })
    return { ok: true, state: 'verified', evidence, reason: 'Calendar event verified.' }
  }

  if (evidence.some((item) => item.verified)) {
    return { ok: true, state: 'verified', evidence, reason: 'Caller supplied verified evidence.' }
  }
  return { ok: false, state: 'unverified', evidence, reason: 'No verified evidence for external effect.' }
}
