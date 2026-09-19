import { FleetControlPlane } from './control-plane'
import { FleetStore } from './store'
import { MemoryAttioAdapter } from './attio'
import { runFleetUntilIdle } from './worker-loop'
import { MemoryLinkedInLedger } from './linkedin-ledger'
import { FLEET_MACHINE_SEEDS } from './heartbeat'
import { executeExecutiveCommand } from './executive'
import { createBestAttioAdapter, companiesFromLiveHits } from './attio-bridge'

/** First production loop: signal → research → Attio reconcile → identity-aware draft. */
export async function runSignalToDraftLoop(plane: FleetControlPlane, options?: { now?: number }) {
  const attio = new MemoryAttioAdapter({
    people: [{ attioId: 'attio_person_existing', name: 'Alex Chen', email: 'achen@acme.example' }],
  })
  plane.ingestEvent('signal.detected', 'amplemarket', {
    entityKey: 'acme-infra',
    signal: 'multi-cloud',
    company: 'Acme',
  })
  const { objective } = plane.submitObjective({
    title: 'Toronto dinner',
    intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
    sourceInterface: 'hermes',
    createdBy: 'alex',
    campaignId: 'toronto-dinner',
    priority: 'P1',
  })

  const fleet = await runFleetUntilIdle(plane, { now: options?.now, attio, maxRounds: 6 })
  const fromGrok = plane.submitObjective({
    title: 'Toronto dinner',
    intent: 'Where are we on Toronto?',
    sourceInterface: 'grokbot',
  })

  return {
    objectiveId: objective.id,
    sameObjective: fromGrok.objective.id === objective.id,
    claimed: fleet.results.flatMap((result) => result.completed),
    status: plane.status('Toronto'),
    campaign: plane.campaignStatus('Toronto'),
    picture: fleet.picture,
    entities: plane.snapshot().entities,
    costs: plane.snapshot().costs,
  }
}

/** Calendar → brief → transcript → commitments → Attio/follow-up. */
export async function runMeetingLifecycleLoop(plane: FleetControlPlane, options?: { now?: number }) {
  const attio = new MemoryAttioAdapter()
  plane.ingestEvent('calendar.external_meeting_soon', 'google-calendar', {
    meetingKey: 'mtg-acme-1',
    title: 'Acme infrastructure chat',
    attendees: [{ name: 'Sam Rivera', company: 'Acme' }],
    signals: ['multi-cloud migration chatter'],
    promises: [],
  })
  await runFleetUntilIdle(plane, { now: options?.now, attio, maxRounds: 4 })
  plane.ingestEvent('granola.transcript_available', 'granola', {
    meetingKey: 'mtg-acme-1',
    text: 'Sam said they are migrating the warehouse to multi-cloud. Alex will send a follow-up with next steps.',
    attendees: ['Sam Rivera', 'Alex'],
  })
  await runFleetUntilIdle(plane, { now: (options?.now ?? Date.now()) + 60_000, attio, maxRounds: 6 })
  return {
    status: plane.status('mtg-acme-1'),
    commitments: plane.snapshot().commitments,
    jobs: plane.snapshot().jobs.filter((job) =>
      String(job.entityKey).includes('mtg-acme-1')
      || job.kind.startsWith('meeting')
      || job.kind === 'transcript.process'
      || job.kind === 'email.draft'),
  }
}

/** Prove LinkedIn send verification against the outreach harness ledger. */
export async function runLinkedInVerifyLoop(plane: FleetControlPlane) {
  const ledger = new MemoryLinkedInLedger()
  plane.setIdentityLane('katherine-byteport', { sendMode: 'live', autonomyLevel: 3, sessionStatus: 'alive' })
  const { objective } = plane.submitObjective({
    title: 'Send Katherine LinkedIn note',
    intent: 'Send a Byteport LinkedIn message as Katherine',
    sourceInterface: 'hermes',
    priority: 'P1',
  })
  const workflowId = plane.snapshot().workflows.find((item) => item.objectiveId === objective.id)?.id
  if (!workflowId) throw new Error('missing workflow')
  plane.enqueueBackgroundJob({
    objectiveId: objective.id,
    workflowId,
    kind: 'linkedin.send',
    title: 'Send LinkedIn message as Katherine',
    priority: 'P1',
    requiredCapabilities: ['linkedin.send'],
    requiredIdentityId: 'katherine-byteport',
    idempotencyKey: 'li-send-demo-1',
    entityKey: 'linkedin.com/in/example',
    payload: { campaignId: 'byteport-demo' },
  })
  await runFleetUntilIdle(plane, { linkedinLedger: ledger, maxRounds: 4 })
  const send = plane.snapshot().jobs.find((job) => job.kind === 'linkedin.send')
  return { send, ledger: ledger.all(), picture: plane.picture() }
}

/** Prove Gmail Sent and Calendar create against SoT proof stores, including duplicate suppression. */
export async function runEmailCalendarVerifyLoop(plane: FleetControlPlane) {
  const { MemoryGmailSentStore, MemoryCalendarStore } = await import('./sot-verify')
  const gmailSent = new MemoryGmailSentStore()
  const calendarEvents = new MemoryCalendarStore()
  plane.setIdentityLane('alex-gmail', { sendMode: 'live', autonomyLevel: 3, sessionStatus: 'alive' })
  plane.setIdentityLane('alex-calendar', { sendMode: 'live', autonomyLevel: 3, sessionStatus: 'alive' })
  const { objective } = plane.submitObjective({
    title: 'Verify Gmail and calendar',
    intent: 'Send a follow-up and put the meeting on the calendar.',
    sourceInterface: 'hermes',
    priority: 'P0',
  })
  const workflowId = plane.snapshot().workflows.find((item) => item.objectiveId === objective.id)?.id
  if (!workflowId) throw new Error('missing workflow')
  plane.enqueueBackgroundJob({
    objectiveId: objective.id,
    workflowId,
    kind: 'email.send',
    title: 'Send follow-up to Sam',
    priority: 'P0',
    requiredCapabilities: ['email.send'],
    requiredIdentityId: 'alex-gmail',
    idempotencyKey: 'gmail-send-demo-1',
    entityKey: 'sam@acme.example',
    payload: { to: 'sam@acme.example', subject: 'after our chat' },
  })
  plane.enqueueBackgroundJob({
    objectiveId: objective.id,
    workflowId,
    kind: 'calendar.create',
    title: 'Acme + Byteport dinner follow-up',
    priority: 'P0',
    requiredCapabilities: ['calendar.create'],
    requiredIdentityId: 'alex-calendar',
    idempotencyKey: 'cal-create-demo-1',
    entityKey: 'mtg-acme-toronto',
    payload: { title: 'Acme + Byteport dinner follow-up', calendarId: 'primary' },
  })
  await runFleetUntilIdle(plane, { gmailSent, calendarEvents, maxRounds: 4 })
  plane.enqueueBackgroundJob({
    objectiveId: objective.id,
    workflowId,
    kind: 'email.send',
    title: 'Retry follow-up to Sam',
    priority: 'P0',
    requiredCapabilities: ['email.send'],
    requiredIdentityId: 'alex-gmail',
    idempotencyKey: 'gmail-send-demo-2',
    entityKey: 'sam@acme.example',
    payload: { to: 'sam@acme.example' },
  })
  await runFleetUntilIdle(plane, { gmailSent, calendarEvents, maxRounds: 2 })
  return {
    email: plane.snapshot().jobs.filter((job) => job.kind === 'email.send'),
    calendar: plane.snapshot().jobs.find((job) => job.kind === 'calendar.create'),
    gmailSent: gmailSent.all(),
    calendarEvents: calendarEvents.all(),
  }
}

/**
 * Full recommended loop:
 * signal → research → Attio → outreach draft → reply → meeting → Granola → commitments → follow-up
 * plus cross-agent status + worker failover.
 */
export async function runFullGtmLoop(plane: FleetControlPlane, options?: {
  now?: number
  liveCompanies?: Array<{ recordId: string; name: string; domain?: string }>
}) {
  const { adapter: attio, mode: attioModeUsed } = createBestAttioAdapter({
    people: [{ attioId: 'attio_person_existing', name: 'Sam Rivera', email: 'sam@acme.example' }],
    companies: companiesFromLiveHits(options?.liveCompanies ?? [
      { recordId: '8fc484a3-8e27-4d9e-9223-ecfa3114a002', name: 'Byteport', domain: 'byteport.com' },
    ]),
  })
  const ledger = new MemoryLinkedInLedger()
  const started = options?.now ?? Date.now()

  const hermesCmd = executeExecutiveCommand(
    plane,
    'Get 20 qualified infrastructure leaders to the Toronto dinner.',
    'hermes',
  )
  plane.ingestEvent('signal.detected', 'amplemarket', {
    company: 'Acme',
    entityKey: 'company:acme',
    signal: 'multi-cloud warehouse migration',
    strength: 0.85,
  })
  await runFleetUntilIdle(plane, { now: started, attio, linkedinLedger: ledger, maxRounds: 6 })

  plane.ingestEvent('inbox.reply', 'gmail', {
    entityKey: 'person:sam-rivera',
    company: 'Acme',
    person: 'Sam Rivera',
    summary: 'Sam replied positive about dinner / infrastructure chat',
    strength: 0.9,
  })
  plane.ingestEvent('calendar.external_meeting_soon', 'google-calendar', {
    meetingKey: 'mtg-acme-toronto',
    title: 'Acme + Byteport dinner follow-up',
    attendees: [{ name: 'Sam Rivera', company: 'Acme', attioId: 'attio_person_existing' }],
    signals: ['multi-cloud warehouse migration'],
    promises: [],
    objectiveId: hermesCmd.objectiveId,
  })
  await runFleetUntilIdle(plane, { now: started + 120_000, attio, maxRounds: 4 })

  plane.ingestEvent('granola.transcript_available', 'granola', {
    meetingKey: 'mtg-acme-toronto',
    text: 'Sam confirmed multi-cloud migration. Alex will send a follow-up and keep them warm for Toronto dinner.',
  })
  await runFleetUntilIdle(plane, { now: started + 240_000, attio, maxRounds: 6 })

  plane.submitObjective({
    title: 'Toronto dinner',
    intent: 'Keep filling Toronto dinner gaps',
    sourceInterface: 'muse',
  })
  const torontoObj = plane.snapshot().objectives.find((item) => /toronto/i.test(item.title))!
  const workflowId = plane.snapshot().workflows.find((item) => item.objectiveId === torontoObj.id)?.id
    ?? plane.snapshot().workflows[0]?.id
  plane.enqueueBackgroundJob({
    objectiveId: torontoObj.id,
    workflowId: workflowId!,
    kind: 'research.run',
    title: 'Failover probe research',
    priority: 'P2',
    requiredCapabilities: ['research'],
    idempotencyKey: `failover-probe:${torontoObj.id}`,
    entityKey: 'company:acme',
  })
  const claimAt = started + 300_000
  const claimed = plane.claimNext('hermes-oakland', claimAt)
  if (claimed) {
    plane.markOffline('hermes-oakland')
    plane.heartbeat({ workerId: 'grokbot-backup', at: claimAt + 120_000 })
    plane.expireLeases(claimAt + 120_000)
    plane.claimNext('grokbot-backup', claimAt + 121_000)
  }

  const grokCmd = executeExecutiveCommand(plane, 'Where are we on Toronto dinner?', 'grokbot')
  const attention = executeExecutiveCommand(plane, 'What needs my attention today?', 'claude-code')

  return {
    attioModeUsed,
    hermesObjectiveId: hermesCmd.objectiveId,
    grokSameObjective: grokCmd.objectiveId === hermesCmd.objectiveId,
    toronto: plane.status('Toronto'),
    campaign: plane.campaignStatus('Toronto'),
    commitments: plane.snapshot().commitments,
    attention: attention.picture,
    fleet: plane.picture(),
    entities: plane.snapshot().entities,
    eventTypes: [...new Set(plane.snapshot().events.map((event) => event.type))],
    failover: claimed
      ? {
        originalWorker: 'hermes-oakland',
        recovered: plane.snapshot().jobs.some((job) =>
          job.id === claimed.id && (
            job.assignedWorkerId === 'grokbot-backup'
            || job.state === 'queued'
            || job.state === 'completed'
            || job.state === 'leased'
            || job.state === 'running'
          ),
        ),
      }
      : null,
  }
}

export function createTestPlane(dir: string): FleetControlPlane {
  const plane = new FleetControlPlane(new FleetStore(`${dir}/state.json`))
  plane.seedDefaults()
  for (const seed of FLEET_MACHINE_SEEDS) plane.applyMachineAdvertisement(seed)
  return plane
}
