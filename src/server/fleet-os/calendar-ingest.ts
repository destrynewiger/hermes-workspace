/**
 * Normalize Google Calendar / MCP calendar events into Fleet OS meeting events.
 */

export type CalendarAttendee = {
  email?: string
  displayName?: string
  self?: boolean
  responseStatus?: string
}

export type CalendarEventInput = {
  id?: string
  summary?: string
  description?: string
  start?: { dateTime?: string; date?: string }
  end?: { dateTime?: string; date?: string }
  attendees?: CalendarAttendee[]
  location?: string
  htmlLink?: string
}

const INTERNAL_DOMAINS = ['byteport.com', 'byteport.io']

export function isExternalAttendee(attendee: CalendarAttendee): boolean {
  if (attendee.self) return false
  const email = (attendee.email ?? '').toLowerCase()
  if (!email) return false
  const domain = email.split('@')[1] ?? ''
  if (INTERNAL_DOMAINS.includes(domain)) return false
  if (email.includes('lu.ma') || email.startsWith('calendar-invite@')) return false
  return true
}

export function calendarEventIsExternal(event: CalendarEventInput): boolean {
  return (event.attendees ?? []).some(isExternalAttendee)
}

export function calendarEventsToFleetEvents(
  events: CalendarEventInput[],
  options?: { onlyExternal?: boolean },
): Array<{ type: string; source: string; payload: Record<string, unknown> }> {
  const onlyExternal = options?.onlyExternal !== false
  const out: Array<{ type: string; source: string; payload: Record<string, unknown> }> = []
  for (const event of events) {
    const meetingKey = event.id
    if (!meetingKey) continue
    if (onlyExternal && !calendarEventIsExternal(event)) continue
    const external = (event.attendees ?? []).filter(isExternalAttendee)
    const title = event.summary?.trim() || 'External meeting'
    if (/^internal notes\s*\|/i.test(title) && external.length === 0) continue
    out.push({
      type: 'calendar.external_meeting_soon',
      source: 'google-calendar',
      payload: {
        meetingKey,
        title,
        start: event.start?.dateTime ?? event.start?.date ?? null,
        end: event.end?.dateTime ?? event.end?.date ?? null,
        location: event.location ?? null,
        htmlLink: event.htmlLink ?? null,
        attendees: (event.attendees ?? []).map((item) => ({
          email: item.email,
          name: item.displayName ?? item.email,
          external: isExternalAttendee(item),
        })),
        externalAttendees: external.map((item) => item.email ?? item.displayName),
        description: event.description?.slice(0, 500) ?? null,
      },
    })
  }
  return out
}
