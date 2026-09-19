/**
 * Normalize Gmail / Unibox / Amplemarket inbox threads into Fleet OS events.
 * Classifies noise (OOO, newsletters) vs prospect replies vs Luma waitlist/RSVP.
 */

const INTERNAL_DOMAINS = ['byteport.com', 'byteport.io', 'rootly.com']

export type InboxThreadInput = {
  id: string
  source?: 'gmail' | 'unibox' | 'amplemarket' | 'inbox'
  from?: string
  fromName?: string
  to?: string
  subject?: string
  snippet?: string
  labels?: string[]
  direction?: 'inbound' | 'outbound'
}

export type InboxClassification =
  | 'noise'
  | 'luma_rsvp'
  | 'prospect_replied'
  | 'booked'
  | 'outbound'

export type ClassifiedInboxThread = {
  thread: InboxThreadInput
  classification: InboxClassification
  reason: string
  person?: string
  email?: string
  toEmail?: string
  company?: string
  eventName?: string
  guestStatus?: string
}

function emailFrom(value?: string): string | undefined {
  if (!value) return undefined
  const match = value.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return match?.[0]?.toLowerCase()
}

function domainOf(email?: string): string {
  return (email ?? '').split('@')[1] ?? ''
}

function isInternalEmail(email?: string): boolean {
  return INTERNAL_DOMAINS.includes(domainOf(email))
}

function haystack(thread: InboxThreadInput): string {
  return [thread.subject, thread.snippet, thread.from, thread.fromName, thread.to, ...(thread.labels ?? [])]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function detectLuma(thread: InboxThreadInput, text: string): {
  person?: string
  email?: string
  eventName?: string
  guestStatus: string
} | null {
  const personText = `${thread.snippet ?? ''}`.toLowerCase()
  const follower = personText.match(/new follower\s+([a-z]+(?:\s+[a-z]+)?)\s*\(([^)\s]+@[^)\s]+)\)/i)
  const registered = personText.match(/([a-z]+(?:\s+[a-z]+)?)\s+registered for your event/i)
    ?? personText.match(/([a-z]+(?:\s+[a-z]+)?)\s+has registered/i)
  const workEmail = text.match(/work email\s+([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})/i)
  const looksLuma = /lu\.ma|luma-mail|waitlist|new follower|registered for/.test(text)
  if (!looksLuma && !follower) return null
  const from = emailFrom(thread.from)
  const lumaSender = Boolean(from && (from.endsWith('luma-mail.com') || from === 'team@byteport.com' || from === 'luma@byteport.com'))
  if (!lumaSender && !/lu\.ma|waitlist entry|registered for your event|new follower/.test(text)) return null
  const person = follower?.[1]?.trim()
    || registered?.[1]?.trim()
    || thread.fromName
  const email = follower?.[2]?.toLowerCase()
    || workEmail?.[1]?.toLowerCase()
    || (!isInternalEmail(from) ? from : undefined)
  const eventName = thread.subject?.replace(/^new waitlist entry for\s+/i, '').replace(/^re:\s*/i, '').trim()
    || 'Luma event'
  const guestStatus = /waitlist/.test(text) ? 'waitlist' : /follower/.test(text) ? 'follower' : 'registered'
  return { person, email, eventName, guestStatus }
}

export function classifyInboxThread(thread: InboxThreadInput): ClassifiedInboxThread {
  const fromEmail = emailFrom(thread.from)
  const toEmail = emailFrom(thread.to)
  const person = thread.fromName?.trim() || (fromEmail ? fromEmail.split('@')[0] : undefined)
  const text = haystack(thread)
  const labels = (thread.labels ?? []).map((label) => label.toUpperCase())

  if (thread.direction === 'outbound' || (labels.includes('SENT') && isInternalEmail(fromEmail))) {
    return {
      thread,
      classification: 'outbound',
      reason: 'Outbound thread is recorded as a suppression, not a new signal.',
      email: fromEmail,
      toEmail,
      person,
    }
  }

  const luma = detectLuma(thread, text)
  if (luma) {
    return {
      thread,
      classification: 'luma_rsvp',
      reason: 'Luma waitlist, registration, or follower notice.',
      email: luma.email,
      person: luma.person,
      eventName: luma.eventName,
      guestStatus: luma.guestStatus,
    }
  }

  if (/out of office|ooo\b|automatic reply|autoreply|on vacation|maternity leave/.test(text)) {
    return { thread, classification: 'noise', reason: 'Out-of-office / auto-reply.', email: fromEmail, person }
  }

  if (/unsubscribe|view in browser|this newsletter|noreply@|no-reply@|mailer-daemon|do[- ]not[- ]reply/.test(text)) {
    return { thread, classification: 'noise', reason: 'Newsletter or no-reply.', email: fromEmail, person }
  }

  if (isInternalEmail(fromEmail)) {
    return { thread, classification: 'noise', reason: 'Internal sender.', email: fromEmail, person }
  }

  if (/\bbooked\b|calendar invite|chat soon|looking forward to (our|the) (call|chat|dinner)/.test(text)) {
    return { thread, classification: 'booked', reason: 'Prospect confirmed a meeting.', email: fromEmail, person }
  }

  return {
    thread,
    classification: 'prospect_replied',
    reason: 'Inbound message from an external sender.',
    email: fromEmail,
    person,
  }
}

export function inboxThreadsToFleetEvents(
  threads: InboxThreadInput[],
): {
  events: Array<{ type: string; source: string; payload: Record<string, unknown> }>
  skipped: ClassifiedInboxThread[]
  classified: ClassifiedInboxThread[]
} {
  const classified = threads.map(classifyInboxThread)
  const skipped: ClassifiedInboxThread[] = []
  const events: Array<{ type: string; source: string; payload: Record<string, unknown> }> = []

  for (const item of classified) {
    if (item.classification === 'noise' || item.classification === 'outbound') {
      skipped.push(item)
      continue
    }
    const source = item.thread.source ?? 'inbox'
    const entityKey = item.email
      ? `person:${item.email}`
      : item.person
        ? `person:${item.person.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`
        : `thread:${item.thread.id}`
    const subject = item.thread.subject ?? ''
    const snippet = item.thread.snippet ?? ''

    if (item.classification === 'luma_rsvp') {
      const status = item.guestStatus ?? (/waitlist/.test(haystack(item.thread)) ? 'waitlist' : 'registered')
      events.push({
        type: 'luma.rsvp',
        source: 'luma',
        payload: {
          eventName: item.eventName ?? (subject.replace(/^re:\s*/i, '') || 'Luma event'),
          guest: { email: item.email, name: item.person, status },
          guests: [{ email: item.email, name: item.person, status }],
          rawType: `email.${status}`,
          threadId: item.thread.id,
          inboxSource: source,
        },
      })
      continue
    }

    const intent = item.classification === 'booked' ? 'booked' : 'replied'
    const signal = item.classification === 'booked'
      ? `${item.person ?? item.email ?? 'Prospect'} booked / confirmed. ${subject}`.trim()
      : `${item.person ?? item.email ?? 'Prospect'} replied: ${subject || snippet}`.trim()

    events.push({
      type: 'inbox.reply',
      source,
      payload: {
        threadId: item.thread.id,
        person: item.person,
        email: item.email,
        company: item.company,
        subject,
        snippet: snippet.slice(0, 500),
        intent,
        signal,
        strength: item.classification === 'booked' ? 0.95 : 0.85,
        entityKey,
      },
    })
  }

  return { events, skipped, classified }
}
