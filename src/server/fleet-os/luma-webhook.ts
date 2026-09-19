/**
 * Normalize Luma webhook / RSVP payloads into Fleet OS `luma.rsvp` events.
 * Luma payloads vary by version; accept the common shapes without requiring
 * the control plane to know Luma's wire format.
 */

export type LumaGuest = {
  email?: string
  name?: string
  status?: string
  company?: string
}

export type NormalizedLumaRsvp = {
  type: 'luma.rsvp'
  source: 'luma'
  payload: {
    campaignId?: string
    objectiveId?: string
    eventId?: string
    eventName?: string
    rsvps?: number
    guest?: LumaGuest
    guests?: LumaGuest[]
    rawType?: string
  }
  idempotencyKey: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function guestFrom(value: unknown): LumaGuest | null {
  const record = asRecord(value)
  if (!record) return null
  const email = typeof record.email === 'string' ? record.email
    : typeof record.user_email === 'string' ? record.user_email
    : typeof asRecord(record.user)?.email === 'string' ? String(asRecord(record.user)!.email)
    : undefined
  const name = typeof record.name === 'string' ? record.name
    : typeof record.user_name === 'string' ? record.user_name
    : typeof asRecord(record.user)?.name === 'string' ? String(asRecord(record.user)!.name)
    : undefined
  const status = typeof record.status === 'string' ? record.status
    : typeof record.approval_status === 'string' ? record.approval_status
    : undefined
  const company = typeof record.company === 'string' ? record.company : undefined
  if (!email && !name) return null
  return { email, name, status, company }
}

function isRsvpLike(type: string, guest: LumaGuest | null): boolean {
  const t = type.toLowerCase()
  if (/rsvp|guest\.(added|approved|registered)|registration|ticket/.test(t)) return true
  if (guest?.status && /approved|registered|going|yes|confirmed/i.test(guest.status)) return true
  return false
}

/**
 * Accept Luma webhook JSON (or a thin proxy wrapper) and return a Fleet event
 * contract, or null when the payload is not an RSVP-class event.
 */
export function normalizeLumaWebhook(
  body: unknown,
  hints?: { campaignId?: string; objectiveId?: string; eventName?: string },
): NormalizedLumaRsvp | null {
  const root = asRecord(body)
  if (!root) return null

  const data = asRecord(root.data) ?? root
  const type = String(root.type ?? root.event_type ?? data.type ?? 'luma.unknown')
  const event = asRecord(data.event) ?? asRecord(root.event) ?? asRecord(data.calendar_event)
  const guest = guestFrom(data.guest ?? data.user ?? root.guest ?? data)
  const guests = Array.isArray(data.guests)
    ? data.guests.map(guestFrom).filter((item): item is LumaGuest => Boolean(item))
    : guest ? [guest] : []

  if (!isRsvpLike(type, guest) && typeof root.rsvps !== 'number' && !hints?.campaignId) {
    return null
  }

  const eventId = typeof data.event_id === 'string' ? data.event_id
    : typeof event?.api_id === 'string' ? event.api_id
    : typeof event?.id === 'string' ? event.id
    : typeof root.eventId === 'string' ? root.eventId
    : undefined
  const eventName = hints?.eventName
    ?? (typeof event?.name === 'string' ? event.name : undefined)
    ?? (typeof data.event_name === 'string' ? data.event_name : undefined)
    ?? (typeof root.eventName === 'string' ? root.eventName : undefined)

  const rsvps = typeof root.rsvps === 'number' ? root.rsvps
    : typeof data.rsvp_count === 'number' ? data.rsvp_count
    : typeof data.guest_count === 'number' ? data.guest_count
    : undefined

  const campaignId = hints?.campaignId
    ?? (typeof root.campaignId === 'string' ? root.campaignId : undefined)
    ?? (typeof data.campaign_id === 'string' ? data.campaign_id : undefined)
  const objectiveId = hints?.objectiveId
    ?? (typeof root.objectiveId === 'string' ? root.objectiveId : undefined)

  const guestKey = guest?.email ?? guest?.name ?? eventId ?? type
  const idempotencyKey = `luma.rsvp:${eventId ?? campaignId ?? 'unknown'}:${guestKey}:${type}`

  return {
    type: 'luma.rsvp',
    source: 'luma',
    payload: {
      campaignId,
      objectiveId,
      eventId,
      eventName,
      rsvps,
      guest: guest ?? undefined,
      guests: guests.length ? guests : undefined,
      rawType: type,
    },
    idempotencyKey,
  }
}

/** Resolve which Fleet campaign an RSVP advances when Luma does not send campaignId. */
export function resolveCampaignForLuma(
  campaigns: Array<{ id: string; title: string; objectiveId: string; geography: string | null }>,
  payload: NormalizedLumaRsvp['payload'],
): string | null {
  if (payload.campaignId && campaigns.some((item) => item.id === payload.campaignId)) {
    return payload.campaignId
  }
  const needle = (payload.eventName ?? '').toLowerCase()
  if (needle) {
    const byName = campaigns.find((item) =>
      item.title.toLowerCase().includes(needle)
      || needle.includes(item.title.toLowerCase())
      || (item.geography && needle.includes(item.geography.toLowerCase())),
    )
    if (byName) return byName.id
  }
  if (payload.objectiveId) {
    const byObjective = campaigns.find((item) => item.objectiveId === payload.objectiveId)
    if (byObjective) return byObjective.id
  }
  // Dinner/event campaigns: prefer geography tokens from event name.
  for (const geo of ['toronto', 'nyc', 'new york', 'sf', 'san francisco', 'london']) {
    if (needle.includes(geo)) {
      const match = campaigns.find((item) =>
        item.geography?.toLowerCase() === geo
        || item.title.toLowerCase().includes(geo),
      )
      if (match) return match.id
    }
  }
  return campaigns.length === 1 ? campaigns[0].id : null
}
