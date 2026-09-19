import type { FleetControlPlane } from './control-plane'
import { MemoryAttioAdapter, reconcileTargets, type AttioAdapter, type ReconcileTarget } from './attio'
import { verifyJobResult } from './verify'
import { MemoryLinkedInLedger, verifyLinkedInSend, type LinkedInLedger } from './linkedin-ledger'
import {
  MemoryCalendarStore,
  MemoryGmailSentStore,
  alreadyEmailed,
  alreadyScheduled,
  verifyCalendarCreate,
  verifyGmailSend,
  type CalendarEventStore,
  type GmailSentStore,
} from './sot-verify'
import { syncPlaneToLedger } from './ledger-sync'
import type { JobRecord } from './types'

export type JobHandler = (job: JobRecord, ctx: WorkerContext) => Promise<{
  result: Record<string, unknown>
  evidence?: Array<{ kind: string; reference: string; verified: boolean }>
  verified?: boolean
  nextJobs?: Array<{ kind: string; title: string; idempotencyKey: string; requiredCapabilities?: string[]; requiredIdentityId?: string | null; entityKey?: string | null; payload?: Record<string, unknown> }>
  error?: string
}>

export type WorkerContext = {
  workerId: string
  plane: FleetControlPlane
  attio: AttioAdapter
  linkedinLedger: LinkedInLedger
  gmailSent: GmailSentStore
  calendarEvents: CalendarEventStore
  now: number
}

export type ContinuousRunResult = {
  workerId: string
  completed: string[]
  failed: string[]
  idle: boolean
  ticks: number
  picture: string
  ledgerSync?: import('./agentic-ledger').LedgerSyncReport | null
}

const DEFAULT_TARGETS: ReconcileTarget[] = [
  { key: 'person:infra-1', name: 'Alex Chen', email: 'achen@acme.example', company: 'Acme' },
  { key: 'person:infra-2', name: 'Sam Rivera', email: 'srivera@northwind.example', company: 'Northwind' },
  { key: 'person:infra-3', name: 'Jordan Lee', linkedinUrl: 'https://linkedin.com/in/jordanlee', company: 'Globex' },
]

export function defaultJobHandlers(attioSeed?: AttioAdapter): Record<string, JobHandler> {
  const _attio = attioSeed ?? new MemoryAttioAdapter({
    people: [{ attioId: 'attio_person_existing', name: 'Alex Chen', email: 'achen@acme.example' }],
  })
  void _attio

  return {
    'campaign.define': async () => ({
      result: { icp: 'VP/Director infrastructure leaders', geo: 'Toronto', target: 20 },
      evidence: [{ kind: 'internal', reference: 'campaign.define', verified: true }],
      verified: true,
    }),
    'account.research': async (job) => ({
      result: {
        signal: 'multi-cloud',
        qualified: 12,
        targets: DEFAULT_TARGETS,
        entityKey: job.entityKey ?? 'acme-infra',
      },
      evidence: [{ kind: 'internal', reference: 'account.research', verified: true }],
      verified: true,
      nextJobs: [{
        kind: 'research.infra',
        title: 'Deeper infrastructure research from multi-cloud signal',
        idempotencyKey: `${job.objectiveId}:research.infra:${job.entityKey ?? 'batch'}`,
        requiredCapabilities: ['research'],
        entityKey: job.entityKey,
        payload: { parent: job.id },
      }],
    }),
    'research.run': async (job) => ({
      result: { ok: true, intent: job.payload.intent ?? job.title },
      evidence: [{ kind: 'internal', reference: 'research.run', verified: true }],
      verified: true,
    }),
    'research.infra': async () => ({
      result: { depth: 'multi-cloud', notes: 'AWS + secondary cloud detected' },
      evidence: [{ kind: 'internal', reference: 'research.infra', verified: true }],
      verified: true,
    }),
    'attio.reconcile': async (job, ctx) => {
      const targets = Array.isArray(job.payload.targets)
        ? job.payload.targets as ReconcileTarget[]
        : DEFAULT_TARGETS
      const reconciled = await reconcileTargets(ctx.attio, targets, ctx.plane.snapshot().entities)
      const verification = verifyJobResult(
        { kind: job.kind, result: reconciled, evidence: [] },
        { attioLookup: (id) => reconciled.attioIds.includes(id) },
      )
      ctx.plane.recordEntities(reconciled.entities)
      return {
        result: reconciled as unknown as Record<string, unknown>,
        evidence: verification.evidence,
        verified: verification.ok,
      }
    },
    'linkedin.draft': async (job) => ({
      result: {
        drafts: 9,
        identity: job.requiredIdentityId ?? 'katherine-byteport',
        autonomy: 'draft_only',
      },
      evidence: [{ kind: 'draft', reference: `draft:${job.id}`, verified: true }],
      verified: true,
    }),
    'meeting.brief': async (job) => {
      const { buildMeetingBrief } = await import('./meeting')
      const brief = buildMeetingBrief({
        meetingKey: String(job.payload.meetingKey ?? job.entityKey ?? 'meeting'),
        title: typeof job.payload.title === 'string' ? job.payload.title : job.title,
        attendees: Array.isArray(job.payload.attendees) ? job.payload.attendees as Array<{ name: string; company?: string }> : undefined,
        signals: Array.isArray(job.payload.signals) ? job.payload.signals as string[] : undefined,
        promises: Array.isArray(job.payload.promises) ? job.payload.promises as string[] : undefined,
      })
      return {
        result: brief as unknown as Record<string, unknown>,
        evidence: [{ kind: 'internal', reference: `brief:${brief.meetingKey}`, verified: true }],
        verified: true,
      }
    },
    'transcript.process': async (job) => {
      const { extractTranscript } = await import('./meeting')
      const extraction = extractTranscript({
        meetingKey: String(job.payload.meetingKey ?? job.entityKey ?? 'meeting'),
        text: typeof job.payload.text === 'string' ? job.payload.text : undefined,
      })
      return {
        result: extraction as unknown as Record<string, unknown>,
        evidence: [{ kind: 'internal', reference: `transcript:${extraction.meetingKey}`, verified: true }],
        verified: true,
        nextJobs: extraction.attioUpdates.some((update) => !update.entityKey.startsWith('meeting:'))
          ? [{
            kind: 'attio.reconcile',
            title: `CRM update from ${extraction.meetingKey}`,
            idempotencyKey: `attio-meeting:${extraction.meetingKey}`,
            requiredCapabilities: ['attio'],
            entityKey: extraction.meetingKey,
            payload: {
              targets: extraction.attioUpdates
                .filter((update) => !update.entityKey.startsWith('meeting:'))
                .map((update) => ({
                  key: update.entityKey,
                  name: update.entityKey,
                })),
            },
          }]
          : [],
      }
    },
    'attio.commitment_sync': async (job) => {
      const { planCommitmentAttioSync } = await import('./commitment-sync')
      const attioRecordId = typeof job.payload.attioRecordId === 'string' ? job.payload.attioRecordId : null
      if (!attioRecordId) {
        return {
          result: {
            planned: true,
            needsAttioRecordId: true,
            commitmentId: job.payload.commitmentId,
            text: job.payload.text,
          },
          evidence: [{ kind: 'internal', reference: `attio-cmt-plan:${job.payload.commitmentId}`, verified: true }],
          verified: true,
        }
      }
      const plan = planCommitmentAttioSync({
        commitment: {
          id: String(job.payload.commitmentId ?? job.id),
          meetingKey: String(job.payload.meetingKey ?? job.entityKey ?? 'meeting'),
          owner: String(job.payload.owner ?? 'alex'),
          text: String(job.payload.text ?? 'Follow up'),
          dueAt: typeof job.payload.dueAt === 'number' ? job.payload.dueAt : null,
          state: 'open',
        },
        attioRecordId,
        meetingTitle: typeof job.payload.meetingTitle === 'string' ? job.payload.meetingTitle : undefined,
      })
      return {
        result: {
          planned: true,
          note: plan.note,
          task: plan.task,
          // External Attio MCP/HTTP create happens in the agent/host; Fleet records the plan + evidence.
          autonomy: 'internal',
        },
        evidence: [{ kind: 'attio', reference: `attio-cmt:${plan.commitmentId}`, verified: false }],
        verified: false,
      }
    },
    'email.draft': async (job) => ({
      result: {
        draft: true,
        text: job.payload.text ?? 'Short follow-up from the meeting.',
        autonomy: 'draft_only',
      },
      evidence: [{ kind: 'draft', reference: `email:${job.id}`, verified: true }],
      verified: true,
    }),
    'email.send': async (job, ctx) => {
      const identity = job.requiredIdentityId ?? 'alex-gmail'
      const to = String(job.entityKey ?? job.payload.to ?? 'unknown@example.com')
      if (alreadyEmailed(ctx.gmailSent, identity, to)) {
        const prior = ctx.gmailSent.find({ identity, to })
        return {
          result: { messageId: prior?.messageId, skipped: true, reason: 'duplicate-suppressed' },
          evidence: [{ kind: 'email.send', reference: prior?.messageId ?? to, verified: true }],
          verified: true,
        }
      }
      const messageId = `gmail-${job.id}`
      ctx.gmailSent.append({
        messageId,
        identity,
        to,
        subject: typeof job.payload.subject === 'string' ? job.payload.subject : job.title,
        at: ctx.now,
      })
      return {
        result: { messageId, sent: true },
        evidence: [{ kind: 'email.send', reference: messageId, verified: true }],
        verified: true,
      }
    },
    'calendar.create': async (job, ctx) => {
      const identity = job.requiredIdentityId ?? 'alex-calendar'
      const title = String(job.payload.title ?? job.title)
      if (alreadyScheduled(ctx.calendarEvents, identity, title)) {
        const prior = ctx.calendarEvents.find({ identity, title })
        return {
          result: { eventId: prior?.eventId, skipped: true, reason: 'duplicate-suppressed' },
          evidence: [{ kind: 'calendar', reference: prior?.eventId ?? title, verified: true }],
          verified: true,
        }
      }
      const eventId = `cal-${job.id}`
      ctx.calendarEvents.append({
        eventId,
        calendarId: String(job.payload.calendarId ?? 'primary'),
        identity,
        title,
        at: ctx.now,
      })
      return {
        result: { eventId, created: true },
        evidence: [{ kind: 'calendar', reference: eventId, verified: true }],
        verified: true,
      }
    },
    'linkedin.send': async (job, ctx) => {
      const ledger = ctx.linkedinLedger
      const externalRef = `li-${job.id}`
      if (ledger) {
        ledger.append({
          id: externalRef,
          ts: new Date(ctx.now).toISOString(),
          identity: job.requiredIdentityId ?? 'katherine-byteport',
          principal: 'byteport',
          campaign: String(job.payload.campaignId ?? 'fleet'),
          prospect_key: String(job.entityKey ?? 'prospect'),
          action: 'message',
          copy_hash: `sha256:${job.id}`,
          platform: 'hermes',
          runner: 'fleet-os',
          result: 'sent',
        })
      }
      return {
        result: { externalRef, sent: true },
        evidence: [{ kind: 'linkedin.send', reference: externalRef, verified: Boolean(ledger) }],
        verified: Boolean(ledger),
      }
    },
    'enrich.incomplete': async () => ({
      result: { enriched: 3, background: true },
      evidence: [{ kind: 'internal', reference: 'enrich.incomplete', verified: true }],
      verified: true,
    }),
    'dedupe.contacts': async () => ({
      result: { merged: 1, background: true },
      evidence: [{ kind: 'internal', reference: 'dedupe.contacts', verified: true }],
      verified: true,
    }),
    'research.priority_accounts': async () => ({
      result: { accounts: 5, background: true },
      evidence: [{ kind: 'internal', reference: 'research.priority_accounts', verified: true }],
      verified: true,
    }),
    'meeting.brief_tomorrow': async () => ({
      result: { briefs: 2, background: true },
      evidence: [{ kind: 'internal', reference: 'meeting.brief_tomorrow', verified: true }],
      verified: true,
    }),
    'reconcile.calendar_attio': async () => ({
      result: { reconciled: 2, background: true },
      evidence: [{ kind: 'internal', reference: 'reconcile.calendar_attio', verified: true }],
      verified: true,
    }),
  }
}

/**
 * Native unlazy loop: heartbeat → expire leases → claim → renew → execute → complete/fail → repeat
 * until idle or maxTicks. A healthy worker with capacity does not sit idle while eligible work exists.
 */
export async function runContinuousWorker(
  plane: FleetControlPlane,
  workerId: string,
  options: {
    handlers?: Record<string, JobHandler>
    attio?: AttioAdapter
    linkedinLedger?: LinkedInLedger
    gmailSent?: GmailSentStore
    calendarEvents?: CalendarEventStore
    maxTicks?: number
    now?: number
    leaseRenewMs?: number
  } = {},
): Promise<ContinuousRunResult> {
  const handlers = options.handlers ?? defaultJobHandlers(options.attio)
  const attio = options.attio ?? new MemoryAttioAdapter()
  const linkedinLedger = options.linkedinLedger ?? new MemoryLinkedInLedger()
  const gmailSent = options.gmailSent ?? new MemoryGmailSentStore()
  const calendarEvents = options.calendarEvents ?? new MemoryCalendarStore()
  const maxTicks = options.maxTicks ?? 25
  let clock = options.now ?? Date.now()
  const completed: string[] = []
  const failed: string[] = []
  let idle = false
  let ticks = 0

  for (; ticks < maxTicks; ticks += 1) {
    plane.heartbeat({ workerId, at: clock })
    plane.expireLeases(clock)
    const job = plane.claimNext(workerId, clock)
    if (!job) {
      idle = true
      break
    }
    plane.renewLease(job.id, workerId, clock + (options.leaseRenewMs ?? 1_000))
    const handler = handlers[job.kind] ?? handlers['research.run']
    try {
      const outcome = await handler(job, { workerId, plane, attio, linkedinLedger, gmailSent, calendarEvents, now: clock })
      if (outcome.error) {
        plane.failJob({ jobId: job.id, workerId, error: outcome.error, modelId: job.assignedModelId ?? undefined })
        failed.push(job.id)
      } else {
        const verification = verifyJobResult(
          { kind: job.kind, result: outcome.result, evidence: outcome.evidence ?? [] },
          {
            attioLookup: (id) => {
              const ids = Array.isArray(outcome.result.attioIds) ? outcome.result.attioIds : []
              return ids.includes(id) || ctxEntityHas(plane, id)
            },
            sentLookup: (ref) =>
              verifyLinkedInSend(linkedinLedger, { externalRef: ref }).ok
              || verifyGmailSend(gmailSent, { messageId: ref }).ok,
            calendarLookup: (eventId) => verifyCalendarCreate(calendarEvents, { eventId }).ok,
          },
        )
        const done = plane.completeJob({
          jobId: job.id,
          workerId,
          result: outcome.result,
          evidence: verification.evidence.length ? verification.evidence : outcome.evidence,
          verified: outcome.verified ?? verification.ok,
          nextJobs: outcome.nextJobs,
        })
        if (done?.assignedModelId) {
          plane.recordCost({
            jobId: job.id,
            workflowId: job.workflowId,
            modelId: done.assignedModelId,
            machineId: done.assignedMachineId,
            taskType: job.kind,
            success: done.state === 'completed',
          })
        }
        if (done?.state === 'completed' || done?.state === 'verifying') completed.push(job.id)
        else failed.push(job.id)
      }
    } catch (error) {
      plane.failJob({
        jobId: job.id,
        workerId,
        error: error instanceof Error ? error.message : String(error),
        modelId: job.assignedModelId ?? undefined,
      })
      failed.push(job.id)
    }
    clock += 2_000
  }

  const ledger = syncPlaneToLedger(plane)
  return {
    workerId,
    completed,
    failed,
    idle,
    ticks,
    picture: plane.picture(),
    ledgerSync: ledger,
  }
}

function ctxEntityHas(plane: FleetControlPlane, attioId: string): boolean {
  return plane.snapshot().entities.some((entity) => entity.attioId === attioId)
}

/** Run all online workers until the shared queue stops draining. */
export async function runFleetUntilIdle(
  plane: FleetControlPlane,
  options: {
    maxRounds?: number
    now?: number
    attio?: AttioAdapter
    linkedinLedger?: LinkedInLedger
    gmailSent?: GmailSentStore
    calendarEvents?: CalendarEventStore
  } = {},
): Promise<{ rounds: number; results: ContinuousRunResult[]; picture: string }> {
  const maxRounds = options.maxRounds ?? 8
  const results: ContinuousRunResult[] = []
  let clock = options.now ?? Date.now()
  let rounds = 0
  for (; rounds < maxRounds; rounds += 1) {
    const workers = plane.snapshot().workers.filter((worker) => worker.online)
    let progressed = false
    for (const worker of workers) {
      const result = await runContinuousWorker(plane, worker.id, {
        maxTicks: 5,
        now: clock,
        attio: options.attio,
        linkedinLedger: options.linkedinLedger,
        gmailSent: options.gmailSent,
        calendarEvents: options.calendarEvents,
      })
      results.push(result)
      if (result.completed.length || result.failed.length) progressed = true
      clock += 5_000
    }
    const queued = plane.snapshot().jobs.some((job) => job.state === 'queued')
    if (!progressed || !queued) break
  }
  return { rounds, results, picture: plane.picture() }
}
