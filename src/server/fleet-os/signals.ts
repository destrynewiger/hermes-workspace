export type SignalSource =
  | 'sumble'
  | 'amplemarket'
  | 'research'
  | 'linkedin'
  | 'x'
  | 'google-trends'
  | 'job-posting'
  | 'funding'
  | 'common-room'
  | 'apollo'
  | 'attio'
  | 'inbox'
  | 'calendar'
  | 'granola'
  | 'website'
  | 'luma'
  | 'other'

export type SignalRecord = {
  id: string
  source: SignalSource | string
  type: string
  entityKey: string | null
  company: string | null
  person: string | null
  strength: number
  summary: string
  raw: Record<string, unknown>
  at: number
  relevant: boolean
  alreadyKnown: boolean
  suggestedAction: string | null
}

export function normalizeSignal(input: {
  source: string
  type?: string
  entityKey?: string | null
  company?: string | null
  person?: string | null
  summary?: string
  strength?: number
  payload?: Record<string, unknown>
  at?: number
}): SignalRecord {
  const payload = input.payload ?? {}
  const summary = (input.summary
    ?? (typeof payload.signal === 'string' ? payload.signal : null)
    ?? (typeof payload.summary === 'string' ? payload.summary : null)
    ?? `${input.source} signal`).toString()
  const strength = clamp(input.strength ?? inferStrength(input.source, summary, payload), 0, 1)
  const company = input.company ?? str(payload.company)
  const person = input.person ?? str(payload.person) ?? str(payload.name)
  const entityKey = input.entityKey ?? str(payload.entityKey) ?? (company ? `company:${slug(company)}` : person ? `person:${slug(person)}` : null)
  const relevant = strength >= 0.35 && !/unrelated|spam|noise/i.test(summary)
  return {
    id: `sig_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    source: input.source,
    type: input.type ?? str(payload.type) ?? 'detected',
    entityKey,
    company,
    person,
    strength,
    summary,
    raw: payload,
    at: input.at ?? Date.now(),
    relevant,
    alreadyKnown: Boolean(payload.alreadyKnown),
    suggestedAction: relevant ? suggestAction(summary, strength) : null,
  }
}

export function suggestAction(summary: string, strength: number): string | null {
  const text = summary.toLowerCase()
  if (/multi-cloud|migrat|warehouse|data.?platform|etl|pipeline/.test(text)) {
    return strength >= 0.7 ? 'account.research' : 'enrich.run'
  }
  if (/hired|job change|joined|left /.test(text)) return 'relationship.path'
  if (/funding|raised|series /.test(text)) return 'account.research'
  if (/booked|calendar invite/.test(text)) return 'meeting.brief'
  if (/replied|inbound|demo request|interested/.test(text)) return 'email.draft'
  if (/rsvp|dinner|event|waitlist/.test(text)) return 'campaign.define'
  return strength >= 0.6 ? 'account.research' : null
}

function inferStrength(source: string, summary: string, payload: Record<string, unknown>): number {
  let score = 0.4
  if (source === 'research' || source === 'amplemarket' || source === 'sumble' || source === 'common-room' || source === 'website') score += 0.15
  if (source === 'inbox' || source === 'granola') score += 0.25
  if (/multi-cloud|migrat|warehouse|hiring.*infra|vp .*eng/.test(summary.toLowerCase())) score += 0.25
  if (typeof payload.strength === 'number') score = payload.strength
  return clamp(score, 0, 1)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}
