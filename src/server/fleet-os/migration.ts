/**
 * Migration map: existing GTM automations → Fleet OS events/jobs.
 * Do not rebuild working systems. Register them as workers that report into
 * the shared control plane.
 */

export type LegacyAutomation = {
  id: string
  name: string
  repo: string
  entrypoint: string
  kind: 'cron' | 'cli' | 'workflow' | 'skill'
  fleetEvent?: string
  fleetJobKind?: string
  requiredCapabilities: string[]
  autonomy: 0 | 1 | 2 | 3 | 4
  status: 'reuse' | 'wrap' | 'deprecate'
  notes: string
}

/** Canonical inventory of known working GTM motions to migrate behind Fleet OS. */
export const LEGACY_AUTOMATIONS: LegacyAutomation[] = [
  {
    id: 'gtm-sumble-monitor',
    name: 'Sumble watchlist monitor',
    repo: 'gtm-command-center',
    entrypoint: 'src/jobs/sumbleMonitor.js',
    kind: 'cron',
    fleetEvent: 'signal.detected',
    fleetJobKind: 'account.research',
    requiredCapabilities: ['research', 'attio'],
    autonomy: 1,
    status: 'deprecate',
    notes: 'Sumble is unpaid. Do not call the Sumble API. Use Duo + page/Google research instead.',
  },
  {
    id: 'gtm-account-signal-monitor',
    name: 'Amplemarket Duo + page/Google research monitor',
    repo: 'gtm-command-center',
    entrypoint: 'src/jobs/sumbleMonitor.js',
    kind: 'cron',
    fleetEvent: 'signal.detected',
    fleetJobKind: 'account.research',
    requiredCapabilities: ['research', 'attio'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Pull watched Duo leads plus page_view / google_research / scrape. Emit normalized signals into Fleet OS.',
  },
  {
    id: 'gtm-seed-planned-outreach',
    name: 'Planned outreach seed buckets',
    repo: 'gtm-command-center',
    entrypoint: 'scripts/seed-planned-outreach.js',
    kind: 'cli',
    fleetJobKind: 'campaign.define',
    requiredCapabilities: ['campaign.define', 'research'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Seed remains a one-shot CLI; campaign objectives and gap jobs live in Fleet OS.',
  },
  {
    id: 'byteport-daily-brief',
    name: 'Byteport Hermes daily brief',
    repo: 'byteport-hermes',
    entrypoint: 'src/workflows/daily-brief.ts',
    kind: 'workflow',
    fleetJobKind: 'meeting.brief_tomorrow',
    requiredCapabilities: ['research', 'attio'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Brief generation stays in byteport-hermes; Fleet OS owns scheduling and follow-up jobs.',
  },
  {
    id: 'amplemarket-apollo-signals',
    name: 'Amplemarket / Apollo lead signals',
    repo: 'fleet-os',
    entrypoint: 'POST signal-ingest',
    kind: 'workflow',
    fleetEvent: 'signal.detected',
    fleetJobKind: 'account.research',
    requiredCapabilities: ['research', 'attio'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Normalize Duo/Apollo hits via signal-ingest; do not rebuild Amplemarket/Apollo UIs.',
  },
  {
    id: 'google-calendar-meetings',
    name: 'Google Calendar external meetings',
    repo: 'fleet-os',
    entrypoint: 'POST calendar-ingest',
    kind: 'workflow',
    fleetEvent: 'calendar.external_meeting_soon',
    fleetJobKind: 'meeting.brief',
    requiredCapabilities: ['meeting.brief', 'calendar'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Ingest calendar events via HTTP calendar-ingest; external attendees create briefing jobs automatically.',
  },
  {
    id: 'granola-transcripts',
    name: 'Granola meeting transcripts',
    repo: 'fleet-os',
    entrypoint: 'POST granola-ingest',
    kind: 'workflow',
    fleetEvent: 'granola.transcript_available',
    fleetJobKind: 'transcript.process',
    requiredCapabilities: ['transcript.process'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Ingest Granola notes/transcripts via HTTP granola-ingest; Fleet OS extracts commitments and queues follow-up.',
  },
  {
    id: 'gmail-unibox-inbox',
    name: 'Gmail / Unibox inbound replies',
    repo: 'fleet-os',
    entrypoint: 'POST inbox-ingest',
    kind: 'workflow',
    fleetEvent: 'inbox.reply',
    fleetJobKind: 'email.draft',
    requiredCapabilities: ['email.draft'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Classify inbound Gmail/Unibox; OOO and newsletters are discarded; replies and bookings become events.',
  },
  {
    id: 'luma-events',
    name: 'Luma RSVP and waitlist',
    repo: 'fleet-os',
    entrypoint: 'POST luma / inbox-ingest luma_rsvp',
    kind: 'workflow',
    fleetEvent: 'luma.rsvp',
    fleetJobKind: 'campaign.define',
    requiredCapabilities: ['campaign.define'],
    autonomy: 1,
    status: 'wrap',
    notes: 'Keep Luma as the event product; webhooks and waitlist emails both advance campaign RSVP counts.',
  },
  {
    id: 'linkedin-outreach-harness',
    name: 'LinkedIn send chain',
    repo: 'destrynewiger',
    entrypoint: '.claude/skills/linkedin-outreach-harness',
    kind: 'skill',
    fleetJobKind: 'linkedin.send',
    requiredCapabilities: ['linkedin.send'],
    autonomy: 2,
    status: 'reuse',
    notes: 'Identity→session→copy→cadence→stage→ledger stays canonical; Fleet OS verifies against the ledger.',
  },
  {
    id: 'agentic-os-ledger',
    name: 'Agentic OS event ledger',
    repo: 'agentic-os',
    entrypoint: 'server/lib/event-ledger.js',
    kind: 'workflow',
    fleetEvent: 'job.completed',
    requiredCapabilities: ['coordination'],
    autonomy: 1,
    status: 'reuse',
    notes: 'Do not replace. Fleet OS appends via agentic-ledger bridge / FLEET_LEDGER_PATH.',
  },
]

export type MigrationPlan = {
  reuse: LegacyAutomation[]
  wrap: LegacyAutomation[]
  deprecate: LegacyAutomation[]
  nextActions: string[]
}

export function buildMigrationPlan(automations: LegacyAutomation[] = LEGACY_AUTOMATIONS): MigrationPlan {
  return {
    reuse: automations.filter((item) => item.status === 'reuse'),
    wrap: automations.filter((item) => item.status === 'wrap'),
    deprecate: automations.filter((item) => item.status === 'deprecate'),
    nextActions: [
      'Run Duo + page/Google research through POST { action: "duo-ingest" } or { action: "signal-ingest", source: "research" }. Do not use a Sumble API key.',
      'Create dinner/campaign objectives in Fleet OS; keep seed-planned-outreach as a targeting helper only.',
      'Schedule daily-brief as a P1 background job after calendar.external_meeting_soon drains.',
      'Point Oakland FLEET_LEDGER_PATH at the agentic-os SQLite WAL.',
      'Keep LinkedIn harness ledger as the verification SoT for linkedin.send.',
      'POST inbox-ingest for Gmail/Unibox replies; Luma waitlist emails become luma.rsvp.',
      'Import coworker LinkedIn identities from harness.yaml; do not invent a second identity list.',
    ],
  }
}

/** Turn a daily-brief completion into a Fleet OS event (shared picture). */
export function dailyBriefToFleetEvent(report: {
  asOf: string
  briefId: string
  changeCount?: number
  recommendationCount?: number
  headline?: string
}): { type: string; source: string; payload: Record<string, unknown> } {
  return {
    type: 'job.completed',
    source: 'byteport-hermes',
    payload: {
      kind: 'meeting.brief_tomorrow',
      asOf: report.asOf,
      briefId: report.briefId,
      changeCount: report.changeCount ?? 0,
      recommendationCount: report.recommendationCount ?? 0,
      headline: report.headline,
      signal: `Daily brief ready for ${report.asOf}`,
    },
  }
}

/** Turn watchlist monitor output into Fleet OS signal events (no private queue). Sumble API is unpaid. */
export function accountSignalMonitorToFleetEvents(summary: {
  researched?: number
  newSignals?: number
  domains?: string[]
  signals?: Array<{ company?: string; detail?: string; kind?: string; method?: string }>
  duoLeads?: Array<Record<string, unknown>>
}): Array<{ type: string; source: string; payload: Record<string, unknown> }> {
  const events: Array<{ type: string; source: string; payload: Record<string, unknown> }> = []
  for (const signal of summary.signals ?? []) {
    events.push({
      type: 'signal.detected',
      source: 'research',
      payload: {
        company: signal.company,
        signal: signal.detail ?? signal.kind ?? 'account research signal',
        method: signal.method ?? 'page_view',
        strength: 0.8,
        entityKey: signal.company ? `company:${signal.company.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` : null,
      },
    })
  }
  if (!events.length && (summary.newSignals ?? 0) > 0) {
    events.push({
      type: 'signal.detected',
      source: 'research',
      payload: {
        signal: `Watchlist research found ${summary.newSignals} new incident-stack signals across ${summary.researched ?? 0} accounts`,
        strength: 0.7,
        method: 'page_view',
      },
    })
  }
  return events
}

/** @deprecated Sumble unpaid. Alias that remaps to research-sourced events. */
export function sumbleMonitorToFleetEvents(summary: {
  researched?: number
  newSignals?: number
  domains?: string[]
  signals?: Array<{ company?: string; detail?: string; kind?: string }>
}): Array<{ type: string; source: string; payload: Record<string, unknown> }> {
  return accountSignalMonitorToFleetEvents(summary)
}
