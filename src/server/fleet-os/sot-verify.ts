/**
 * Systems-of-record verification for Gmail Sent and Google Calendar.
 * Attempted is not completed: a send/create stays unverified until the
 * message or event exists in the proof store (memory in tests, MCP/API in prod).
 */

export type GmailSentProof = {
  messageId: string
  identity: string
  to: string
  subject?: string
  at: number
}

export type CalendarEventProof = {
  eventId: string
  calendarId: string
  identity: string
  title: string
  at: number
}

export type GmailSentStore = {
  append(event: GmailSentProof): void
  find(query: { messageId?: string; identity?: string; to?: string }): GmailSentProof | null
  all(): GmailSentProof[]
}

export type CalendarEventStore = {
  append(event: CalendarEventProof): void
  find(query: { eventId?: string; identity?: string; title?: string }): CalendarEventProof | null
  all(): CalendarEventProof[]
}

export class MemoryGmailSentStore implements GmailSentStore {
  private events: GmailSentProof[] = []

  constructor(seed: GmailSentProof[] = []) {
    this.events = [...seed]
  }

  append(event: GmailSentProof): void {
    if (this.find({ messageId: event.messageId })) return
    this.events.push(event)
  }

  find(query: { messageId?: string; identity?: string; to?: string }): GmailSentProof | null {
    return this.events.find((event) => {
      if (query.messageId && event.messageId !== query.messageId) return false
      if (query.identity && event.identity !== query.identity) return false
      if (query.to && event.to !== query.to) return false
      return true
    }) ?? null
  }

  all(): GmailSentProof[] {
    return [...this.events]
  }
}

export class MemoryCalendarStore implements CalendarEventStore {
  private events: CalendarEventProof[] = []

  constructor(seed: CalendarEventProof[] = []) {
    this.events = [...seed]
  }

  append(event: CalendarEventProof): void {
    if (this.find({ eventId: event.eventId })) return
    this.events.push(event)
  }

  find(query: { eventId?: string; identity?: string; title?: string }): CalendarEventProof | null {
    return this.events.find((event) => {
      if (query.eventId && event.eventId !== query.eventId) return false
      if (query.identity && event.identity !== query.identity) return false
      if (query.title && event.title !== query.title) return false
      return true
    }) ?? null
  }

  all(): CalendarEventProof[] {
    return [...this.events]
  }
}

export function alreadyEmailed(store: GmailSentStore, identity: string, to: string): boolean {
  return Boolean(store.find({ identity, to }))
}

export function alreadyScheduled(store: CalendarEventStore, identity: string, title: string): boolean {
  return Boolean(store.find({ identity, title }))
}

export function verifyGmailSend(
  store: GmailSentStore,
  input: { messageId?: string; identity?: string; to?: string },
): { ok: boolean; event: GmailSentProof | null; reason: string } {
  const event = input.messageId
    ? store.find({ messageId: input.messageId })
    : store.find({ identity: input.identity, to: input.to })
  if (!event) return { ok: false, event: null, reason: 'Message not found in Gmail Sent.' }
  return { ok: true, event, reason: 'Gmail send verified in Sent.' }
}

export function verifyCalendarCreate(
  store: CalendarEventStore,
  input: { eventId?: string; identity?: string; title?: string },
): { ok: boolean; event: CalendarEventProof | null; reason: string } {
  const event = input.eventId
    ? store.find({ eventId: input.eventId })
    : store.find({ identity: input.identity, title: input.title })
  if (!event) return { ok: false, event: null, reason: 'Calendar event not found.' }
  return { ok: true, event, reason: 'Calendar event verified.' }
}
