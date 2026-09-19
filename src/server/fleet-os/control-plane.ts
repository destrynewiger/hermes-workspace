import { randomUUID } from 'node:crypto'
import { decideAutonomy } from './autonomy'
import { selectWorker } from './dispatcher'
import { fallbackAfterFailure, routeModel } from './model-router'
import { FleetStore } from './store'
import {
  applyCampaignProgress,
  bumpFromJob,
  campaignFromObjective,
  ensureCampaign,
  gapJobs,
} from './campaign'
import { advertisementToRecords, fleetHealthPicture, markStaleFleet, DEFAULT_HEARTBEAT_TTL_MS, type MachineAdvertisement } from './heartbeat'
import { resolveCampaignForLuma } from './luma-webhook'
import { normalizeSignal } from './signals'
import { findSendSuppression } from './suppression'
import { discoverModelPool } from './model-pool'
import { grokbotHarnessIdentityIds, mergeIdentityRegistry } from './harness-identities'
import type {
  AgentInterface,
  CommitmentRecord,
  CostRecord,
  EntityRecord,
  EventRecord,
  FleetSnapshot,
  IdentityRecord,
  JobRecord,
  MachineRecord,
  ModelRecord,
  ObjectiveRecord,
  Priority,
  SuppressionRecord,
  WorkerRecord,
} from './types'
import { emptySnapshot } from './types'

const DEFAULT_LEASE_MS = 60_000

function now(): number {
  return Date.now()
}

function id(prefix: string): string {
  return `${prefix}_${randomUUID()}`
}

function pushEvent(snapshot: FleetSnapshot, event: Omit<EventRecord, 'id' | 'at'> & { at?: number }): EventRecord {
  const record: EventRecord = {
    id: id('evt'),
    at: event.at ?? now(),
    type: event.type,
    source: event.source,
    objectiveId: event.objectiveId,
    jobId: event.jobId,
    entityKey: event.entityKey,
    payload: event.payload,
  }
  snapshot.events.push(record)
  return record
}

export type SubmitObjectiveInput = {
  title: string
  intent: string
  sourceInterface: AgentInterface | string
  createdBy?: string
  priority?: Priority
  campaignId?: string | null
}

export class FleetControlPlane {
  constructor(private readonly store: FleetStore) {}

  snapshot(): FleetSnapshot {
    return this.store.load()
  }

  seedDefaults(partial?: Partial<FleetSnapshot>): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      const seed = defaultFleet()
      Object.assign(snapshot, {
        machines: partial?.machines ?? seed.machines,
        workers: partial?.workers ?? seed.workers,
        identities: partial?.identities ?? seed.identities,
        models: partial?.models ?? seed.models,
      })
    })
  }

  /**
   * Merge newly-added canonical identities / capabilities into an existing
   * durable state file without wiping objectives, jobs, or campaigns.
   */
  ensureCanonicalRegistry(): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      const seed = defaultFleet()
      for (const identity of seed.identities) {
        const existing = snapshot.identities.find((item) => item.id === identity.id)
        if (!existing) snapshot.identities.push({ ...identity })
      }
      for (const model of seed.models) {
        if (!snapshot.models.some((item) => item.id === model.id)) snapshot.models.push({ ...model })
      }
      for (const worker of seed.workers) {
        const existing = snapshot.workers.find((item) => item.id === worker.id)
        if (!existing) {
          snapshot.workers.push({ ...worker })
          continue
        }
        existing.capabilities = [...new Set([...existing.capabilities, ...worker.capabilities])]
        existing.identities = [...new Set([...existing.identities, ...worker.identities])]
        existing.models = [...new Set([...existing.models, ...worker.models])]
      }
      for (const machine of seed.machines) {
        const existing = snapshot.machines.find((item) => item.id === machine.id)
        if (!existing) {
          snapshot.machines.push({ ...machine, online: false, lastHeartbeatAt: now() - 600_000 })
          continue
        }
        existing.capabilities = [...new Set([...existing.capabilities, ...machine.capabilities])]
        existing.identities = [...new Set([...existing.identities, ...machine.identities])]
        existing.models = [...new Set([...existing.models, ...machine.models])]
      }
    })
  }

  heartbeat(input: { workerId: string; machineId?: string; load?: number; at?: number }): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      const ts = input.at ?? now()
      const worker = snapshot.workers.find((item) => item.id === input.workerId)
      if (worker) {
        worker.online = true
        worker.lastHeartbeatAt = ts
        if (typeof input.load === 'number') worker.load = input.load
      }
      const machine = snapshot.machines.find((item) => item.id === (input.machineId ?? worker?.machineId))
      if (machine) {
        machine.online = true
        machine.lastHeartbeatAt = ts
      }
      pushEvent(snapshot, {
        type: 'worker.heartbeat',
        source: input.workerId,
        objectiveId: null,
        jobId: null,
        entityKey: null,
        payload: { workerId: input.workerId },
      })
    })
  }

  markOffline(workerId: string): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      const worker = snapshot.workers.find((item) => item.id === workerId)
      if (worker) {
        worker.online = false
        worker.lastHeartbeatAt = now()
      }
      pushEvent(snapshot, {
        type: 'worker.offline',
        source: workerId,
        objectiveId: null,
        jobId: null,
        entityKey: null,
        payload: { workerId },
      })
    })
  }

  /** Drop workers/machines whose heartbeats exceeded TTL, then expire their leases. */
  expireStaleHeartbeats(at = now(), ttlMs = DEFAULT_HEARTBEAT_TTL_MS): {
    staleWorkerIds: string[]
    staleMachineIds: string[]
    releasedJobs: JobRecord[]
  } {
    let staleWorkerIds: string[] = []
    let staleMachineIds: string[] = []
    this.store.mutate((snapshot) => {
      const marked = markStaleFleet(snapshot.machines, snapshot.workers, at, ttlMs)
      staleWorkerIds = marked.staleWorkerIds
      staleMachineIds = marked.staleMachineIds
      if (staleWorkerIds.length || staleMachineIds.length) {
        pushEvent(snapshot, {
          type: 'fleet.stale',
          source: 'control-plane',
          objectiveId: null,
          jobId: null,
          entityKey: null,
          payload: { staleWorkerIds, staleMachineIds, ttlMs, at },
        })
      }
    })
    const releasedJobs = this.expireLeases(at)
    return { staleWorkerIds, staleMachineIds, releasedJobs }
  }

  fleetHealth(at = now(), ttlMs = DEFAULT_HEARTBEAT_TTL_MS) {
    const snap = this.snapshot()
    return fleetHealthPicture(snap.machines, snap.workers, at, ttlMs)
  }

  submitObjective(input: SubmitObjectiveInput): { objective: ObjectiveRecord; jobs: JobRecord[] } {
    let objective!: ObjectiveRecord
    let jobs: JobRecord[] = []
    this.store.mutate((snapshot) => {
      const existing = snapshot.objectives.find((item) =>
        item.state !== 'cancelled' && normalize(item.title) === normalize(input.title),
      )
      if (existing) {
        existing.updatedAt = now()
        if (!isStatusQuery(input.intent)) existing.intent = input.intent
        if (existing.state === 'completed' && !isStatusQuery(input.intent)) {
          existing.state = 'active'
          existing.summary = 'Objective reopened from a new interface.'
        }
        objective = existing
        jobs = snapshot.jobs.filter((job) => job.objectiveId === existing.id)
        pushEvent(snapshot, {
          type: 'objective.resumed',
          source: String(input.sourceInterface),
          objectiveId: existing.id,
          jobId: null,
          entityKey: null,
          payload: { interface: input.sourceInterface, statusQuery: isStatusQuery(input.intent) },
        })
        return
      }
      const ts = now()
      objective = {
        id: id('obj'),
        title: input.title.trim(),
        intent: input.intent.trim(),
        sourceInterface: input.sourceInterface,
        createdBy: input.createdBy ?? String(input.sourceInterface),
        state: 'active',
        priority: input.priority ?? inferPriority(input.intent),
        campaignId: input.campaignId ?? null,
        createdAt: ts,
        updatedAt: ts,
        summary: 'Objective recorded. Decomposition in progress.',
      }
      snapshot.objectives.push(objective)
      const workflowId = id('wf')
      snapshot.workflows.push({
        id: workflowId,
        objectiveId: objective.id,
        kind: inferWorkflowKind(input.intent),
        state: 'running',
        createdAt: ts,
        updatedAt: ts,
      })
      jobs = decompose(objective, workflowId)
      snapshot.jobs.push(...jobs)
      const campaignSpec = campaignFromObjective(objective.id, objective.title, objective.intent)
      if (campaignSpec) {
        ensureCampaign(snapshot, campaignSpec)
        objective.campaignId = campaignSpec.id
      }
      pushEvent(snapshot, {
        type: 'objective.created',
        source: String(input.sourceInterface),
        objectiveId: objective.id,
        jobId: null,
        entityKey: null,
        payload: { jobCount: jobs.length, campaignId: objective.campaignId },
      })
    })
    return { objective, jobs }
  }

  ingestEvent(type: string, source: string, payload: Record<string, unknown>): EventRecord {
    let event!: EventRecord
    this.store.mutate((snapshot) => {
      event = pushEvent(snapshot, {
        type,
        source,
        objectiveId: typeof payload.objectiveId === 'string' ? payload.objectiveId : null,
        jobId: typeof payload.jobId === 'string' ? payload.jobId : null,
        entityKey: typeof payload.entityKey === 'string' ? payload.entityKey : null,
        payload,
      })

      if (type === 'calendar.external_meeting_soon' && typeof payload.meetingKey === 'string') {
        const objective = ensureMeetingObjective(snapshot, payload)
        enqueueJob(snapshot, {
          objectiveId: objective.id,
          workflowId: workflowFor(snapshot, objective.id),
          kind: 'meeting.brief',
          title: `Brief for ${payload.meetingKey}`,
          priority: 'P0',
          requiredCapabilities: ['meeting.brief'],
          requiredIdentityId: null,
          idempotencyKey: `brief:${payload.meetingKey}`,
          entityKey: String(payload.meetingKey),
          payload: {
            meetingKey: payload.meetingKey,
            title: payload.title,
            attendees: payload.attendees,
            signals: payload.signals,
            promises: payload.promises,
          },
        })
      }

      if (type === 'granola.transcript_available' && typeof payload.meetingKey === 'string') {
        const objective = snapshot.objectives.find((item) => item.state === 'active' && (
          item.title.includes('promised')
          || item.title.includes(String(payload.meetingKey))
          || item.intent.toLowerCase().includes('meeting')
        )) ?? snapshot.objectives.find((item) => item.state === 'active')
          ?? ensureMeetingObjective(snapshot, payload)
        enqueueJob(snapshot, {
          objectiveId: objective.id,
          workflowId: workflowFor(snapshot, objective.id),
          kind: 'transcript.process',
          title: `Process transcript ${payload.meetingKey}`,
          priority: 'P0',
          requiredCapabilities: ['transcript.process'],
          requiredIdentityId: null,
          idempotencyKey: `transcript:${payload.meetingKey}`,
          entityKey: String(payload.meetingKey),
          payload: {
            meetingKey: payload.meetingKey,
            text: payload.text,
            attendees: payload.attendees,
          },
        })
      }

      if (type === 'luma.rsvp') {
        const campaignId = resolveCampaignForLuma(
          snapshot.campaigns.map((item) => ({
            id: item.id,
            title: item.title,
            objectiveId: item.objectiveId,
            geography: item.geography,
          })),
          {
            campaignId: typeof payload.campaignId === 'string' ? payload.campaignId : undefined,
            objectiveId: typeof payload.objectiveId === 'string' ? payload.objectiveId : undefined,
            eventName: typeof payload.eventName === 'string' ? payload.eventName : undefined,
            rsvps: typeof payload.rsvps === 'number' ? payload.rsvps : undefined,
          },
        )
        const campaign = campaignId
          ? snapshot.campaigns.find((item) => item.id === campaignId)
          : undefined
        if (campaign) {
          event.payload = { ...payload, campaignId: campaign.id }
          const rsvps = typeof payload.rsvps === 'number' ? payload.rsvps : campaign.rsvps + 1
          applyCampaignProgress(campaign, { rsvps })
          for (const next of gapJobs(campaign, workflowFor(snapshot, campaign.objectiveId))) {
            enqueueJob(snapshot, {
              objectiveId: campaign.objectiveId,
              workflowId: workflowFor(snapshot, campaign.objectiveId),
              ...next,
            })
          }
          const objective = snapshot.objectives.find((item) => item.id === campaign.objectiveId)
          if (objective) {
            objective.summary = `${campaign.rsvps}/${campaign.targetCount} RSVPs. ${campaign.gaps[0] ?? 'On track.'}`
            objective.updatedAt = now()
            const leftover = snapshot.jobs.filter((job) =>
              job.objectiveId === objective.id && job.state !== 'completed' && job.state !== 'dead_letter')
            if (campaign.state === 'completed' && leftover.length === 0) objective.state = 'completed'
            else if (leftover.length) objective.state = 'active'
          }
        } else if (typeof payload.eventName === 'string' && payload.eventName.trim()) {
          const title = payload.eventName.trim()
          let objective = snapshot.objectives.find((item) => item.title === title && item.state !== 'cancelled')
          if (!objective) {
            const ts = now()
            objective = {
              id: id('obj'),
              title,
              intent: `Track RSVPs and follow-up for ${title}.`,
              sourceInterface: 'api',
              createdBy: source,
              state: 'active',
              priority: 'P2',
              campaignId: null,
              createdAt: ts,
              updatedAt: ts,
              summary: 'Opened from a Luma RSVP with no existing campaign.',
            }
            snapshot.objectives.push(objective)
            snapshot.workflows.push({
              id: id('wf'),
              objectiveId: objective.id,
              kind: 'event-campaign',
              state: 'running',
              createdAt: ts,
              updatedAt: ts,
            })
          }
          enqueueJob(snapshot, {
            objectiveId: objective.id,
            workflowId: workflowFor(snapshot, objective.id),
            kind: 'campaign.define',
            title: `Define campaign for ${title}`.slice(0, 180),
            priority: 'P2',
            requiredCapabilities: ['campaign.define'],
            requiredIdentityId: null,
            idempotencyKey: `campaign.define:${title.toLowerCase()}`,
            entityKey: null,
            payload: { eventName: title, guest: payload.guest ?? null },
          })
        }
      }

      if (type.startsWith('signal.') || type === 'signal.detected' || type === 'inbox.reply') {
        const signal = normalizeSignal({
          source,
          type: type.replace(/^signal\./, '') || 'detected',
          entityKey: typeof payload.entityKey === 'string' ? payload.entityKey : null,
          company: typeof payload.company === 'string' ? payload.company : null,
          person: typeof payload.person === 'string' ? payload.person : null,
          summary: typeof payload.summary === 'string' ? payload.summary : typeof payload.signal === 'string' ? payload.signal : undefined,
          strength: typeof payload.strength === 'number' ? payload.strength : undefined,
          payload,
        })
        event.payload = { ...payload, normalized: signal }
        if (signal.relevant && signal.suggestedAction && !signal.alreadyKnown) {
          const objective = snapshot.objectives.find((item) => item.state === 'active')
            ?? (() => {
              const ts = now()
              const created = {
                id: id('obj'),
                title: signal.company ? `${signal.company} signal motion` : 'Signal motion',
                intent: `Act on ${signal.summary}`,
                sourceInterface: 'api',
                createdBy: source,
                state: 'active' as const,
                priority: signal.strength >= 0.7 ? 'P1' as const : 'P3' as const,
                campaignId: null,
                createdAt: ts,
                updatedAt: ts,
                summary: 'Opened from normalized signal.',
              }
              snapshot.objectives.push(created)
              snapshot.workflows.push({
                id: id('wf'),
                objectiveId: created.id,
                kind: 'signal-motion',
                state: 'running',
                createdAt: ts,
                updatedAt: ts,
              })
              return created
            })()
          enqueueJob(snapshot, {
            objectiveId: objective.id,
            workflowId: workflowFor(snapshot, objective.id),
            kind: signal.suggestedAction,
            title: `Signal: ${signal.summary}`.slice(0, 200),
            priority: signal.strength >= 0.7 ? 'P1' : 'P3',
            requiredCapabilities: signal.suggestedAction.startsWith('email')
              ? ['email.draft']
              : signal.suggestedAction.startsWith('campaign')
                ? ['research']
                : ['research'],
            requiredIdentityId: null,
            idempotencyKey: `signal:${signal.source}:${signal.entityKey ?? signal.summary}`.slice(0, 200),
            entityKey: signal.entityKey,
            payload: { signal },
          })
        }
      }
    })
    return event
  }

  expireLeases(at = now()): JobRecord[] {
    const recovered: JobRecord[] = []
    this.store.mutate((snapshot) => {
      for (const job of snapshot.jobs) {
        if ((job.state === 'leased' || job.state === 'running') && job.leaseExpiresAt && job.leaseExpiresAt < at) {
          const attempt = snapshot.attempts.find((item) => item.jobId === job.id && item.outcome === 'running')
          if (attempt) {
            attempt.outcome = 'abandoned'
            attempt.finishedAt = at
            attempt.error = 'lease expired'
          }
          job.state = 'queued'
          job.assignedWorkerId = null
          job.assignedMachineId = null
          job.leaseExpiresAt = null
          job.updatedAt = at
          recovered.push({ ...job })
          pushEvent(snapshot, {
            type: 'job.lease_expired',
            source: 'control-plane',
            objectiveId: job.objectiveId,
            jobId: job.id,
            entityKey: job.entityKey,
            payload: { previousWorker: attempt?.workerId ?? null },
          })
        }
      }
    })
    return recovered
  }

  claimNext(workerId: string, at = now()): JobRecord | null {
    this.expireLeases(at)
    let claimed: JobRecord | null = null
    this.store.mutate((snapshot) => {
      const worker = snapshot.workers.find((item) => item.id === workerId)
      if (!worker?.online) return
      const queued = snapshot.jobs
        .filter((job) => job.state === 'queued')
        .sort((a, b) => {
          const identityBoost = (job: typeof a) =>
            job.requiredIdentityId && worker.identities.includes(job.requiredIdentityId) ? -1 : 0
          return identityBoost(a) - identityBoost(b)
            || priorityRank(a.priority) - priorityRank(b.priority)
            || a.createdAt - b.createdAt
        })
      for (const job of queued) {
        if (!job.requiredIdentityId) {
          job.requiredIdentityId = defaultIdentityForKind(job.kind, snapshot.identities)
        }
        const choice = selectWorker({
          job,
          workers: [worker],
          machines: snapshot.machines,
          identities: snapshot.identities,
          now: at,
        })
        if ('unavailable' in choice) continue
        const suppressed = findSendSuppression(snapshot.suppressions ?? [], job, at)
        if (suppressed) {
          job.state = 'completed'
          job.result = { skipped: true, suppressed: true, reason: suppressed.reason, suppressionId: suppressed.id }
          job.evidence = [{ kind: 'suppression', reference: suppressed.id, verified: true }]
          job.nextAction = `Suppressed: ${suppressed.reason}`
          job.updatedAt = at
          pushEvent(snapshot, {
            type: 'action.suppressed',
            source: workerId,
            objectiveId: job.objectiveId,
            jobId: job.id,
            entityKey: job.entityKey,
            payload: { suppressionId: suppressed.id, key: suppressed.key, reason: suppressed.reason },
          })
          continue
        }
        const identity = (job.requiredIdentityId
          ? snapshot.identities.find((item) => item.id === job.requiredIdentityId)
          : null) ?? choice.identity
        const action = actionForJob(job.kind)
        const autonomy = decideAutonomy(action, identity)
        if (!autonomy.allow) {
          job.state = 'blocked'
          job.nextAction = autonomy.reason
          job.updatedAt = at
          continue
        }
        if (!autonomy.execute && (/\.send$/.test(action) || action === 'calendar.create')) {
          job.state = 'blocked'
          job.nextAction = autonomy.reason
          job.updatedAt = at
          snapshot.approvals.push({
            id: id('apr'),
            jobId: job.id,
            action,
            status: 'pending',
            decision: autonomy.reason,
            createdAt: at,
          })
          continue
        }
        const model = routeModel(
          { kind: job.kind, complexity: job.acceptableModelTiers[0] ?? 'local_free' },
          snapshot.models,
        )
        job.state = 'leased'
        job.assignedWorkerId = workerId
        job.assignedMachineId = choice.machine.id
        job.assignedModelId = model.model?.id ?? null
        job.leaseExpiresAt = at + DEFAULT_LEASE_MS
        job.attempts += 1
        job.updatedAt = at
        snapshot.attempts.push({
          id: id('att'),
          jobId: job.id,
          workerId,
          modelId: job.assignedModelId,
          startedAt: at,
          finishedAt: null,
          outcome: 'running',
          error: null,
        })
        worker.load += 1
        claimed = { ...job }
        pushEvent(snapshot, {
          type: 'job.claimed',
          source: workerId,
          objectiveId: job.objectiveId,
          jobId: job.id,
          entityKey: job.entityKey,
          payload: { machineId: choice.machine.id, modelId: job.assignedModelId, autonomy },
        })
        break
      }
    })
    return claimed
  }

  renewLease(jobId: string, workerId: string, at = now()): boolean {
    let ok = false
    this.store.mutate((snapshot) => {
      const job = snapshot.jobs.find((item) => item.id === jobId)
      if (!job || job.assignedWorkerId !== workerId) return
      if (job.state !== 'leased' && job.state !== 'running') return
      job.state = 'running'
      job.leaseExpiresAt = at + DEFAULT_LEASE_MS
      job.updatedAt = at
      ok = true
    })
    return ok
  }

  completeJob(input: {
    jobId: string
    workerId: string
    result: Record<string, unknown>
    evidence?: Array<{ kind: string; reference: string; verified: boolean }>
    nextJobs?: Array<Partial<JobRecord> & { kind: string; title: string; idempotencyKey: string }>
    verified?: boolean
  }): JobRecord | null {
    let completed: JobRecord | null = null
    this.store.mutate((snapshot) => {
      const job = snapshot.jobs.find((item) => item.id === input.jobId)
      if (!job || job.assignedWorkerId !== input.workerId) return
      const evidence = input.evidence ?? []
      const needsVerify = ['linkedin.send', 'email.send', 'attio.update', 'attio.reconcile', 'calendar.create'].includes(job.kind)
      const meetingOnly = isMeetingOnlyReconcile(job, input.result)
      if (needsVerify && !meetingOnly && !(input.verified || evidence.some((item) => item.verified))) {
        job.state = 'verifying'
        job.evidence = evidence
        job.result = input.result
        job.updatedAt = now()
        job.nextAction = 'Await verification of external effect.'
        completed = { ...job }
        return
      }
      job.state = 'completed'
      job.evidence = evidence
      job.result = input.result
      job.leaseExpiresAt = null
      job.updatedAt = now()
      const attempt = snapshot.attempts.find((item) => item.jobId === job.id && item.outcome === 'running')
      if (attempt) {
        attempt.outcome = 'ok'
        attempt.finishedAt = now()
      }
      const worker = snapshot.workers.find((item) => item.id === input.workerId)
      if (worker && worker.load > 0) worker.load -= 1
      completed = { ...job }
      pushEvent(snapshot, {
        type: 'job.completed',
        source: input.workerId,
        objectiveId: job.objectiveId,
        jobId: job.id,
        entityKey: job.entityKey,
        payload: { result: input.result },
      })
      for (const next of input.nextJobs ?? []) {
        enqueueJob(snapshot, {
          objectiveId: job.objectiveId,
          workflowId: job.workflowId,
          kind: next.kind,
          title: next.title,
          priority: next.priority ?? job.priority,
          requiredCapabilities: next.requiredCapabilities ?? [],
          requiredIdentityId: next.requiredIdentityId ?? null,
          idempotencyKey: next.idempotencyKey,
          entityKey: next.entityKey ?? job.entityKey,
          payload: next.payload ?? {},
        })
      }
      const campaign = snapshot.campaigns.find((item) => item.objectiveId === job.objectiveId)
        ?? snapshot.campaigns.find((item) => item.id === job.entityKey)
      if (campaign && job.state === 'completed') {
        bumpFromJob(campaign, job)
        const objective = snapshot.objectives.find((item) => item.id === campaign.objectiveId)
        if (objective) {
          objective.summary = `${campaign.rsvps}/${campaign.targetCount} RSVPs, ${campaign.contacted} contacted.`
            + (campaign.gaps[0] ? ` Next: ${campaign.gaps[0]}` : '')
          objective.updatedAt = now()
        }
      }
      if (job.kind === 'transcript.process' && Array.isArray(input.result.commitments)) {
        appendMeetingCommitments(snapshot, {
          meetingKey: String(job.entityKey ?? input.result.meetingKey ?? 'meeting'),
          objectiveId: job.objectiveId,
          workflowId: job.workflowId,
          attioRecordId: typeof input.result.attioRecordId === 'string' ? input.result.attioRecordId : null,
          commitments: input.result.commitments as Array<{ owner?: string; text?: string; dueAt?: string | null }>,
        })
      }
      continueObjective(snapshot, job)
    })
    return completed
  }

  failJob(input: { jobId: string; workerId: string; error: string; modelId?: string }): JobRecord | null {
    let failed: JobRecord | null = null
    this.store.mutate((snapshot) => {
      const job = snapshot.jobs.find((item) => item.id === input.jobId)
      if (!job) return
      const attempt = snapshot.attempts.find((item) => item.jobId === job.id && item.outcome === 'running')
      if (attempt) {
        attempt.outcome = 'failed'
        attempt.finishedAt = now()
        attempt.error = input.error
      }
      const worker = snapshot.workers.find((item) => item.id === input.workerId)
      if (worker && worker.load > 0) worker.load -= 1
      if (/429|rate limit|credits|unavailable/i.test(input.error) && input.modelId) {
        const next = fallbackAfterFailure(
          { kind: job.kind, complexity: job.acceptableModelTiers[0] ?? 'local_free' },
          snapshot.models,
          input.modelId,
        )
        if (next.model) {
          job.state = 'queued'
          job.assignedWorkerId = null
          job.assignedMachineId = null
          job.assignedModelId = next.model.id
          job.leaseExpiresAt = null
          job.preferredModelId = next.model.id
          job.updatedAt = now()
          const model = snapshot.models.find((item) => item.id === input.modelId)
          if (model) model.available = false
          pushEvent(snapshot, {
            type: 'model.failover',
            source: 'control-plane',
            objectiveId: job.objectiveId,
            jobId: job.id,
            entityKey: job.entityKey,
            payload: { from: input.modelId, to: next.model.id, error: input.error },
          })
          failed = { ...job }
          return
        }
      }
      if (job.attempts >= job.maxAttempts) {
        job.state = 'dead_letter'
        job.nextAction = 'Human judgment required after repeated failure.'
      } else {
        job.state = 'queued'
        job.assignedWorkerId = null
        job.assignedMachineId = null
        job.leaseExpiresAt = null
      }
      job.updatedAt = now()
      failed = { ...job }
    })
    return failed
  }

  reclaimDeadLetters(input?: { jobId?: string; at?: number }): JobRecord[] {
    const reclaimed: JobRecord[] = []
    const at = input?.at ?? now()
    this.store.mutate((snapshot) => {
      for (const job of snapshot.jobs) {
        if (job.state !== 'dead_letter') continue
        if (input?.jobId && job.id !== input.jobId) continue
        job.state = 'queued'
        job.assignedWorkerId = null
        job.assignedMachineId = null
        job.leaseExpiresAt = null
        job.maxAttempts = Math.max(job.maxAttempts, job.attempts + 2)
        job.nextAction = 'Reclaimed from dead letter for another attempt.'
        job.updatedAt = at
        reclaimed.push({ ...job })
        pushEvent(snapshot, {
          type: 'job.reclaimed',
          source: 'control-plane',
          objectiveId: job.objectiveId,
          jobId: job.id,
          entityKey: job.entityKey,
          payload: { maxAttempts: job.maxAttempts },
        })
      }
    })
    return reclaimed
  }

  status(query: string): {
    objective: ObjectiveRecord | null
    jobs: JobRecord[]
    picture: string
    approvals: string[]
  } {
    const snapshot = this.store.load()
    const needle = normalize(query)
    const matches = snapshot.objectives.filter((item) =>
      needle.includes(normalize(item.title)) || normalize(item.title).includes(needle) || normalize(item.intent).includes(needle),
    )
    const objective = matches.find((item) => item.state === 'active')
      ?? matches[0]
      ?? snapshot.objectives.find((item) => item.state === 'active')
      ?? null
    const jobs = objective ? snapshot.jobs.filter((job) => job.objectiveId === objective.id) : []
    const completed = jobs.filter((job) => job.state === 'completed').length
    const queued = jobs.filter((job) => job.state === 'queued').length
    const running = jobs.filter((job) => job.state === 'leased' || job.state === 'running').length
    const blocked = jobs.filter((job) => job.state === 'blocked' || job.state === 'verifying')
    const approvals = snapshot.approvals.filter((item) => item.status === 'pending').map((item) => item.decision)
    const decision = blocked.map((job) => job.nextAction).find((item) => item && item.trim())
    const picture = objective
      ? `${objective.title}: ${completed}/${jobs.length} jobs complete, ${running} running, ${queued} queued.`
        + ((objective.state === 'completed' && queued + running + blocked.length === 0)
          ? ' Objective complete.'
          : blocked.length
            ? ` Decision: ${decision ?? `${blocked.length} need a decision.`}`
            : ' Next authorized work will be claimed automatically.')
      : 'No matching objective in shared state.'
    return { objective, jobs, picture, approvals }
  }

  picture(): string {
    const snapshot = this.store.load()
    const online = snapshot.workers.filter((item) => item.online)
    const queued = snapshot.jobs.filter((item) => item.state === 'queued').length
    const running = snapshot.jobs.filter((item) => item.state === 'leased' || item.state === 'running').length
    const pending = snapshot.approvals.filter((item) => item.status === 'pending').length
    const dead = snapshot.jobs.filter((item) => item.state === 'dead_letter').length
    const objectives = snapshot.objectives.filter((item) => item.state === 'active')
    const openPromises = snapshot.commitments.filter((item) => item.state === 'open').length
    const costs = this.costRollup()
    return [
      `${objectives.length} active objective(s).`,
      `${online.length} workers online, ${running} jobs running, ${queued} queued.`,
      pending ? `${pending} human decision(s) waiting.` : 'No human decisions waiting.',
      openPromises ? `${openPromises} open promise(s).` : 'No open meeting promises.',
      dead ? `${dead} dead-letter job(s) need reclaim or judgment.` : 'No dead-letter jobs.',
      costs.picture,
    ].join(' ')
  }

  costRollup(): {
    total: number
    jobs: number
    byProvider: Record<string, { count: number; amount: number }>
    picture: string
  } {
    const snapshot = this.store.load()
    const byProvider: Record<string, { count: number; amount: number }> = {}
    let total = 0
    for (const cost of snapshot.costs) {
      total += cost.amount
      const bucket = byProvider[cost.provider] ?? (byProvider[cost.provider] = { count: 0, amount: 0 })
      bucket.count += 1
      bucket.amount += cost.amount
    }
    const picture = snapshot.costs.length === 0
      ? 'No inference cost recorded yet (deterministic/local-free preferred).'
      : `Inference: ${snapshot.costs.length} billed job(s), ${total.toFixed(4)} units across ${Object.keys(byProvider).join(', ') || 'none'}.`
    return { total, jobs: snapshot.costs.length, byProvider, picture }
  }

  stuckBoard(): {
    deadLetter: Array<{ id: string; kind: string; nextAction: string | null }>
    blocked: Array<{ id: string; kind: string; nextAction: string | null }>
    verifying: Array<{ id: string; kind: string; nextAction: string | null }>
    picture: string
  } {
    const snapshot = this.store.load()
    const summarize = (job: JobRecord) => ({ id: job.id, kind: job.kind, nextAction: job.nextAction })
    const deadLetter = snapshot.jobs.filter((job) => job.state === 'dead_letter').map(summarize)
    const blocked = snapshot.jobs.filter((job) => job.state === 'blocked').map(summarize)
    const verifying = snapshot.jobs.filter((job) => job.state === 'verifying').map(summarize)
    const picture = (!deadLetter.length && !blocked.length && !verifying.length)
      ? 'No stuck GTM motions. Queued work will drain when a worker has capacity.'
      : [
        deadLetter.length ? `${deadLetter.length} dead-letter job(s).` : null,
        blocked.length ? `${blocked.length} blocked (need identity, session, or approval).` : null,
        verifying.length ? `${verifying.length} unverified external action(s).` : null,
      ].filter(Boolean).join(' ')
    return { deadLetter, blocked, verifying, picture }
  }

  recordEntities(entities: EntityRecord[]): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      for (const entity of entities) {
        const existing = snapshot.entities.find((item) => item.key === entity.key)
        if (existing) {
          existing.attioId = entity.attioId
          existing.displayName = entity.displayName
          existing.aliases = [...new Set([...existing.aliases, ...entity.aliases])]
        } else {
          snapshot.entities.push(entity)
        }
      }
      pushEvent(snapshot, {
        type: 'entity.upserted',
        source: 'attio',
        objectiveId: null,
        jobId: null,
        entityKey: entities[0]?.key ?? null,
        payload: { count: entities.length },
      })
    })
  }

  /**
   * Pull open Attio tasks into shared commitments.
   * A task that is a human decision and names an existing objective reopens that
   * objective with a blocked job so status answers with the decision, not "complete".
   */
  ingestAttioTasks(tasks: Array<{
    taskId: string
    content: string
    isCompleted?: boolean
    deadlineAt?: string | null
    linkedRecordId?: string | null
  }>): { created: number; decisions: number; completed: number } {
    let created = 0
    let decisions = 0
    let completed = 0
    this.store.mutate((snapshot) => {
      for (const task of tasks) {
        const taskId = task.taskId.trim()
        const content = task.content.trim()
        if (!taskId || !content) continue
        let commitment = snapshot.commitments.find((item) => item.attioTaskId === taskId)
        if (!commitment) {
          commitment = {
            id: id('cmt'),
            meetingKey: `attio:${taskId}`,
            objectiveId: null,
            owner: 'alex',
            text: content.slice(0, 240),
            dueAt: task.deadlineAt ? Date.parse(task.deadlineAt) || null : null,
            state: task.isCompleted ? 'done' : 'open',
            attioTaskId: taskId,
            createdAt: now(),
          }
          snapshot.commitments.push(commitment)
          created += 1
        } else if (task.isCompleted && commitment.state !== 'done') {
          commitment.state = 'done'
          completed += 1
        }
        if (task.isCompleted || !isHumanDecision(content)) continue
        const objective = objectiveForDecision(snapshot, content)
        if (!objective) continue
        const idempotencyKey = `attio-decision:${taskId}`
        if (snapshot.jobs.some((job) => job.idempotencyKey === idempotencyKey)) continue
        const workflowId = workflowFor(snapshot, objective.id)
        const job = enqueueJob(snapshot, {
          objectiveId: objective.id,
          workflowId,
          kind: 'human.decision',
          title: content.slice(0, 120),
          priority: 'P0',
          requiredCapabilities: ['coordination'],
          requiredIdentityId: null,
          idempotencyKey,
          entityKey: task.linkedRecordId ? `attio:${task.linkedRecordId}` : null,
          payload: { attioTaskId: taskId },
        })
        job.state = 'blocked'
        job.nextAction = content.slice(0, 280)
        job.updatedAt = now()
        objective.state = 'active'
        objective.summary = content.slice(0, 240)
        objective.updatedAt = now()
        commitment.objectiveId = objective.id
        if (!snapshot.approvals.some((item) => item.jobId === job.id && item.status === 'pending')) {
          snapshot.approvals.push({
            id: id('apr'),
            jobId: job.id,
            action: 'human.decision',
            status: 'pending',
            decision: content.slice(0, 280),
            createdAt: now(),
          })
        }
        decisions += 1
        pushEvent(snapshot, {
          type: 'decision.required',
          source: 'attio',
          objectiveId: objective.id,
          jobId: job.id,
          entityKey: job.entityKey,
          payload: { attioTaskId: taskId },
        })
      }
    })
    return { created, decisions, completed }
  }

  stampCommitmentAttio(input: {
    commitmentId: string
    attioTaskId?: string | null
    attioNoteId?: string | null
  }): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      const hit = snapshot.commitments.find((item) => item.id === input.commitmentId)
      if (!hit) return
      if (input.attioTaskId) hit.attioTaskId = input.attioTaskId
      pushEvent(snapshot, {
        type: 'commitment.attio_synced',
        source: 'attio',
        objectiveId: hit.objectiveId,
        jobId: null,
        entityKey: hit.meetingKey,
        payload: {
          commitmentId: hit.id,
          attioTaskId: input.attioTaskId ?? null,
          attioNoteId: input.attioNoteId ?? null,
        },
      })
    })
  }

  /** Decision-oriented view of open promises. Does not dump operational history. */
  promiseBoard(): {
    open: CommitmentRecord[]
    alexOwned: CommitmentRecord[]
    missingAttio: CommitmentRecord[]
    picture: string
  } {
    const snapshot = this.store.load()
    const open = snapshot.commitments.filter((item) => item.state === 'open')
    const alexOwned = open.filter((item) => item.owner === 'alex')
    const missingAttio = open.filter((item) => !item.attioTaskId)
    const lines = alexOwned.slice(0, 6).map((item) => item.text)
    const picture = open.length === 0
      ? 'No open meeting promises.'
      : `${open.length} open promise(s). Alex owns ${alexOwned.length}`
        + (lines.length ? `: ${lines.join('; ')}.` : '.')
        + (missingAttio.length ? ` ${missingAttio.length} still need Attio evidence.` : ' Attio evidence is on file.')
    return { open, alexOwned, missingAttio, picture }
  }

  recordCost(input: {
    jobId: string | null
    workflowId: string | null
    modelId: string
    machineId: string | null
    taskType: string
    success: boolean
    amount?: number
  }): CostRecord {
    let record!: CostRecord
    this.store.mutate((snapshot) => {
      const model = snapshot.models.find((item) => item.id === input.modelId)
      record = {
        id: id('cost'),
        at: now(),
        workflowId: input.workflowId,
        jobId: input.jobId,
        provider: model?.provider ?? 'unknown',
        modelId: input.modelId,
        machineId: input.machineId,
        taskType: input.taskType,
        amount: input.amount ?? model?.costPerUnit ?? 0,
        success: input.success,
      }
      snapshot.costs.push(record)
    })
    return record
  }

  registerWorker(worker: WorkerRecord, machine?: MachineRecord): FleetSnapshot {
    return this.store.mutate((snapshot) => {
      const ts = now()
      const existingWorker = snapshot.workers.find((item) => item.id === worker.id)
      if (existingWorker) {
        Object.assign(existingWorker, { ...worker, lastHeartbeatAt: ts, online: true })
      } else {
        snapshot.workers.push({ ...worker, lastHeartbeatAt: ts, online: true })
      }
      if (machine) {
        const existingMachine = snapshot.machines.find((item) => item.id === machine.id)
        if (existingMachine) Object.assign(existingMachine, { ...machine, lastHeartbeatAt: ts, online: true })
        else snapshot.machines.push({ ...machine, lastHeartbeatAt: ts, online: true })
      }
      pushEvent(snapshot, {
        type: 'worker.registered',
        source: worker.id,
        objectiveId: null,
        jobId: null,
        entityKey: null,
        payload: { machineId: worker.machineId, capabilities: worker.capabilities },
      })
    })
  }

  addSuppression(input: {
    channel: SuppressionRecord['channel']
    key: string
    reason: string
    source: string
    expiresAt?: number | null
  }): SuppressionRecord {
    let record!: SuppressionRecord
    this.store.mutate((snapshot) => {
      const key = input.key.trim().toLowerCase()
      const existing = (snapshot.suppressions ?? []).find((item) => item.channel === input.channel && item.key === key)
      if (existing) {
        record = existing
        return
      }
      record = {
        id: id('sup'),
        channel: input.channel,
        key,
        reason: input.reason,
        source: input.source,
        createdAt: now(),
        expiresAt: input.expiresAt ?? null,
      }
      snapshot.suppressions.push(record)
    })
    return record
  }

  recordCommitments(input: {
    meetingKey: string
    objectiveId?: string | null
    workflowId?: string | null
    attioRecordId?: string | null
    commitments: Array<{ owner?: string; text?: string; dueAt?: string | null }>
  }): CommitmentRecord[] {
    let created: CommitmentRecord[] = []
    this.store.mutate((snapshot) => {
      const objectiveId = input.objectiveId
        ?? snapshot.jobs.find((job) => job.entityKey === input.meetingKey)?.objectiveId
        ?? null
      const workflowId = input.workflowId
        ?? (objectiveId ? workflowFor(snapshot, objectiveId) : null)
      created = appendMeetingCommitments(snapshot, {
        meetingKey: input.meetingKey,
        objectiveId,
        workflowId,
        attioRecordId: input.attioRecordId,
        commitments: input.commitments,
      })
    })
    return created
  }

  repairStuckJobs(): { requeued: number; skippedVerify: number } {
    let requeued = 0
    let skippedVerify = 0
    this.store.mutate((snapshot) => {
      for (const job of snapshot.jobs) {
        if (job.state === 'blocked' && (job.kind.endsWith('.draft') || job.kind === 'email.draft')) {
          job.requiredIdentityId = job.requiredIdentityId
            ?? defaultIdentityForKind(job.kind, snapshot.identities)
          if (job.requiredIdentityId) {
            job.state = 'queued'
            job.nextAction = 'Assigned default sender identity and requeued.'
            job.updatedAt = now()
            requeued += 1
          }
        }
        if (job.state === 'verifying' && job.result && isMeetingOnlyReconcile(job, job.result)) {
          job.state = 'completed'
          job.nextAction = 'No CRM person key to reconcile. Commitments already tracked.'
          job.updatedAt = now()
          skippedVerify += 1
        }
      }
      for (const objective of snapshot.objectives) {
        const leftover = snapshot.jobs.filter((job) =>
          job.objectiveId === objective.id && job.state !== 'completed' && job.state !== 'dead_letter')
        if (objective.state === 'completed' && leftover.length) {
          objective.state = 'active'
          objective.summary = `${snapshot.jobs.filter((job) => job.objectiveId === objective.id && job.state === 'completed').length}/${snapshot.jobs.filter((job) => job.objectiveId === objective.id).length} jobs complete. Continuing authorized work without waiting for a prompt.`
          objective.updatedAt = now()
        }
      }
    })
    return { requeued, skippedVerify }
  }

  enqueueBackgroundJob(input: {
    objectiveId: string
    workflowId: string
    kind: string
    title: string
    priority: Priority
    requiredCapabilities: string[]
    idempotencyKey: string
    requiredIdentityId?: string | null
    entityKey?: string | null
    payload?: Record<string, unknown>
  }): JobRecord {
    let job!: JobRecord
    this.store.mutate((snapshot) => {
      job = enqueueJob(snapshot, {
        objectiveId: input.objectiveId,
        workflowId: input.workflowId,
        kind: input.kind,
        title: input.title,
        priority: input.priority,
        requiredCapabilities: input.requiredCapabilities,
        requiredIdentityId: input.requiredIdentityId ?? null,
        idempotencyKey: input.idempotencyKey,
        entityKey: input.entityKey ?? null,
        payload: input.payload ?? { background: true },
      })
      pushEvent(snapshot, {
        type: 'job.enqueued',
        source: 'background',
        objectiveId: input.objectiveId,
        jobId: job.id,
        entityKey: job.entityKey,
        payload: { kind: input.kind, priority: input.priority },
      })
    })
    return job
  }

  applyMachineAdvertisement(ad: MachineAdvertisement): FleetSnapshot {
    const { machine, workers } = advertisementToRecords(ad)
    return this.store.mutate((snapshot) => {
      const existingMachine = snapshot.machines.find((item) => item.id === machine.id)
      if (existingMachine) Object.assign(existingMachine, machine)
      else snapshot.machines.push(machine)
      for (const worker of workers) {
        const existing = snapshot.workers.find((item) => item.id === worker.id)
        if (existing) Object.assign(existing, worker)
        else snapshot.workers.push(worker)
      }
      pushEvent(snapshot, {
        type: 'machine.heartbeat',
        source: machine.id,
        objectiveId: null,
        jobId: null,
        entityKey: null,
        payload: {
          capabilities: machine.capabilities,
          identities: machine.identities,
          models: machine.models,
          workers: workers.map((worker) => worker.id),
        },
      })
    })
  }

  campaignStatus(query: string): string {
    const snapshot = this.store.load()
    const needle = normalize(query)
    const campaign = snapshot.campaigns.find((item) =>
      normalize(item.title).includes(needle) || needle.includes(normalize(item.title)) || item.id.includes(needle),
    )
    if (!campaign) return 'No campaign matched.'
    return `${campaign.title}: ${campaign.rsvps}/${campaign.targetCount} RSVPs, ${campaign.contacted} contacted, ${campaign.accepted} accepted.`
      + (campaign.gaps.length ? ` Decision: ${campaign.gaps[0]}` : ' No human decision needed.')
  }

  setIdentityLane(identityId: string, patch: Partial<{ sendMode: 'live' | 'draft_only' | 'staged' | 'planned'; autonomyLevel: 0 | 1 | 2 | 3 | 4; sessionStatus: 'alive' | 'needs_login' | 'locked' | 'unknown' | 'needs_attach' }>): void {
    this.store.mutate((snapshot) => {
      const row = snapshot.identities.find((item) => item.id === identityId)
      if (!row) return
      Object.assign(row, patch)
    })
  }
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

function isStatusQuery(intent: string): boolean {
  return /\b(where are we|status|progress|what happened|how is|how's)\b/i.test(intent)
}

function workflowFor(snapshot: FleetSnapshot, objectiveId: string): string {
  return snapshot.workflows.find((item) => item.objectiveId === objectiveId)?.id ?? id('wf')
}

function ensureMeetingObjective(snapshot: FleetSnapshot, payload: Record<string, unknown>): ObjectiveRecord {
  const meetingKey = String(payload.meetingKey ?? 'meeting')
  const title = `Meeting ${meetingKey}`
  const existing = snapshot.objectives.find((item) => item.state === 'active' && (
    item.title === title || normalize(item.title).includes(normalize(meetingKey))
  ))
  if (existing) return existing
  const ts = now()
  const objective: ObjectiveRecord = {
    id: id('obj'),
    title,
    intent: `Prepare and follow through on external meeting ${meetingKey}`,
    sourceInterface: 'api',
    createdBy: 'calendar',
    state: 'active',
    priority: 'P0',
    campaignId: null,
    createdAt: ts,
    updatedAt: ts,
    summary: 'Meeting lifecycle opened from calendar/Granola event.',
  }
  snapshot.objectives.push(objective)
  snapshot.workflows.push({
    id: id('wf'),
    objectiveId: objective.id,
    kind: 'meeting-lifecycle',
    state: 'running',
    createdAt: ts,
    updatedAt: ts,
  })
  return objective
}

function priorityRank(priority: Priority): number {
  return { P0: 0, P1: 1, P2: 2, P3: 3, P4: 4 }[priority]
}

function inferPriority(intent: string): Priority {
  const text = intent.toLowerCase()
  if (/(today|tomorrow|meeting|reply|failed)/.test(text)) return 'P0'
  if (/(dinner|pipeline|intro|warm|revenue)/.test(text)) return 'P1'
  if (/(campaign|prospect|research|outreach)/.test(text)) return 'P2'
  if (/(signal|enrich|map)/.test(text)) return 'P3'
  return 'P4'
}

function inferWorkflowKind(intent: string): string {
  const text = intent.toLowerCase()
  if (text.includes('dinner')) return 'event-campaign'
  if (text.includes('meeting')) return 'meeting-lifecycle'
  if (text.includes('signal') || text.includes('data-movement')) return 'signal-motion'
  return 'gtm-loop'
}

function actionForJob(kind: string): string {
  if (kind.startsWith('linkedin')) return kind.includes('send') ? 'linkedin.send' : 'linkedin.draft'
  if (kind.startsWith('email')) return kind.includes('send') ? 'email.send' : 'email.draft'
  if (kind.startsWith('attio')) return 'attio.reconcile'
  if (kind.includes('transcript')) return 'transcript.process'
  return 'research.run'
}

function defaultIdentityForKind(kind: string, identities: IdentityRecord[]): string | null {
  const channel = kind.startsWith('email') ? 'gmail'
    : kind.startsWith('linkedin') ? 'linkedin'
      : kind.startsWith('calendar') ? 'calendar'
        : null
  if (!channel) return null
  const match = identities.find((item) => item.channel === channel && item.teammate === 'alex')
    ?? identities.find((item) => item.channel === channel)
  return match?.id ?? null
}

function isHumanDecision(content: string): boolean {
  return /\b(decide|decision|lock|confirm|choose|before outreach|approval)\b/i.test(content)
}

function objectiveForDecision(snapshot: FleetSnapshot, content: string): ObjectiveRecord | null {
  const hay = content.toLowerCase()
  const ranked = [...snapshot.objectives].sort((a, b) => {
    const score = (item: ObjectiveRecord) => (item.state === 'active' ? 0 : 1)
    return score(a) - score(b)
  })
  return ranked.find((item) => {
    const tokens = item.title.toLowerCase().split(/[^a-z0-9]+/).filter((token) =>
      token.length > 4 && !['dinner', 'meeting', 'prepare', 'follow'].includes(token))
    return tokens.some((token) => hay.includes(token))
  }) ?? null
}

function isMeetingOnlyReconcile(job: JobRecord, result: Record<string, unknown>): boolean {
  if (job.kind !== 'attio.reconcile') return false
  const unmatched = Array.isArray(result.unmatched) ? result.unmatched : []
  if (unmatched.length && unmatched.every((item) => {
    const key = item && typeof item === 'object' && 'key' in item ? String((item as { key: unknown }).key) : ''
    return key.startsWith('meeting:')
  })) return true
  return Boolean(job.entityKey && /^[0-9a-f-]{8}-/.test(job.entityKey) && !result.attioIds)
}

function appendMeetingCommitments(snapshot: FleetSnapshot, input: {
  meetingKey: string
  objectiveId: string | null
  workflowId: string | null
  attioRecordId?: string | null
  commitments: Array<{ owner?: string; text?: string; dueAt?: string | null }>
}): CommitmentRecord[] {
  const created: CommitmentRecord[] = []
  for (const raw of input.commitments) {
    const text = raw.text?.trim()
    if (!text) continue
    if (snapshot.commitments.some((item) =>
      item.meetingKey === input.meetingKey && item.text.toLowerCase() === text.toLowerCase(),
    )) continue
    const commitment: CommitmentRecord = {
      id: id('cmt'),
      meetingKey: input.meetingKey,
      objectiveId: input.objectiveId,
      owner: (raw.owner ?? 'alex').toLowerCase(),
      text: text.slice(0, 240),
      dueAt: raw.dueAt ? Date.parse(raw.dueAt) || null : null,
      state: 'open',
      attioTaskId: null,
      createdAt: now(),
    }
    snapshot.commitments.push(commitment)
    created.push(commitment)
    if (!input.objectiveId || !input.workflowId) continue
    if (commitment.owner === 'alex') {
      enqueueJob(snapshot, {
        objectiveId: input.objectiveId,
        workflowId: input.workflowId,
        kind: 'email.draft',
        title: `Follow up: ${text.slice(0, 80)}`,
        priority: 'P0',
        requiredCapabilities: ['email.draft'],
        requiredIdentityId: null,
        idempotencyKey: `followup:${commitment.id}`,
        entityKey: commitment.meetingKey,
        payload: { commitmentId: commitment.id, text },
      })
    }
    enqueueJob(snapshot, {
      objectiveId: input.objectiveId,
      workflowId: input.workflowId,
      kind: 'attio.commitment_sync',
      title: `Attio commitment: ${text.slice(0, 60)}`,
      priority: 'P0',
      requiredCapabilities: ['attio'],
      requiredIdentityId: null,
      idempotencyKey: `attio-cmt:${commitment.id}`,
      entityKey: commitment.meetingKey,
      payload: {
        commitmentId: commitment.id,
        text,
        owner: commitment.owner,
        meetingKey: commitment.meetingKey,
        attioRecordId: input.attioRecordId ?? null,
      },
    })
  }
  return created
}

function enqueueJob(snapshot: FleetSnapshot, input: {
  objectiveId: string
  workflowId: string
  kind: string
  title: string
  priority: Priority
  requiredCapabilities: string[]
  requiredIdentityId: string | null
  idempotencyKey: string
  entityKey: string | null
  payload: Record<string, unknown>
}): JobRecord {
  const existing = snapshot.jobs.find((job) => job.idempotencyKey === input.idempotencyKey)
  if (existing) return existing
  const ts = now()
  const job: JobRecord = {
    id: id('job'),
    objectiveId: input.objectiveId,
    workflowId: input.workflowId,
    kind: input.kind,
    title: input.title,
    state: 'queued',
    priority: input.priority,
    requiredCapabilities: input.requiredCapabilities,
    requiredIdentityId: input.requiredIdentityId
      ?? defaultIdentityForKind(input.kind, snapshot.identities),
    preferredModelId: null,
    acceptableModelTiers: input.kind.includes('draft') || input.kind.includes('brief')
      ? ['inexpensive_cloud', 'frontier']
      : ['local_free', 'inexpensive_cloud'],
    idempotencyKey: input.idempotencyKey,
    entityKey: input.entityKey,
    assignedWorkerId: null,
    assignedMachineId: null,
    assignedModelId: null,
    leaseExpiresAt: null,
    attempts: 0,
    maxAttempts: 3,
    evidence: [],
    result: null,
    nextAction: null,
    crmImpact: null,
    createdAt: ts,
    updatedAt: ts,
    payload: input.payload,
  }
  snapshot.jobs.push(job)
  return job
}

function decompose(objective: ObjectiveRecord, workflowId: string): JobRecord[] {
  const snapshot = emptySnapshot()
  snapshot.jobs = []
  const intent = objective.intent.toLowerCase()
  if (intent.includes('dinner') || intent.includes('infrastructure leader')) {
    enqueueJob(snapshot, {
      objectiveId: objective.id,
      workflowId,
      kind: 'campaign.define',
      title: 'Define ICP and geography for the dinner',
      priority: objective.priority,
      requiredCapabilities: ['research'],
      requiredIdentityId: null,
      idempotencyKey: `${objective.id}:campaign.define`,
      entityKey: objective.campaignId,
      payload: { objective: objective.intent },
    })
    enqueueJob(snapshot, {
      objectiveId: objective.id,
      workflowId,
      kind: 'account.research',
      title: 'Research target infrastructure leaders',
      priority: objective.priority,
      requiredCapabilities: ['research'],
      requiredIdentityId: null,
      idempotencyKey: `${objective.id}:account.research`,
      entityKey: null,
      payload: {},
    })
    enqueueJob(snapshot, {
      objectiveId: objective.id,
      workflowId,
      kind: 'attio.reconcile',
      title: 'Dedupe targets against Attio',
      priority: objective.priority,
      requiredCapabilities: ['attio'],
      requiredIdentityId: null,
      idempotencyKey: `${objective.id}:attio.reconcile`,
      entityKey: null,
      payload: {},
    })
    enqueueJob(snapshot, {
      objectiveId: objective.id,
      workflowId,
      kind: 'linkedin.draft',
      title: 'Draft outreach for remaining targets',
      priority: objective.priority,
      requiredCapabilities: ['linkedin.draft'],
      requiredIdentityId: 'katherine-byteport',
      idempotencyKey: `${objective.id}:linkedin.draft`,
      entityKey: null,
      payload: {},
    })
  } else {
    enqueueJob(snapshot, {
      objectiveId: objective.id,
      workflowId,
      kind: 'research.run',
      title: `Work objective: ${objective.title}`,
      priority: objective.priority,
      requiredCapabilities: ['research'],
      requiredIdentityId: null,
      idempotencyKey: `${objective.id}:research.run`,
      entityKey: null,
      payload: { intent: objective.intent },
    })
  }
  return snapshot.jobs
}

function continueObjective(snapshot: FleetSnapshot, completed: JobRecord): void {
  const jobs = snapshot.jobs.filter((job) => job.objectiveId === completed.objectiveId)
  const remaining = jobs.filter((job) => job.state !== 'completed' && job.state !== 'dead_letter')
  const objective = snapshot.objectives.find((item) => item.id === completed.objectiveId)
  if (!objective) return
  if (!remaining.length) {
    objective.state = 'completed'
    objective.summary = 'Objective complete. Shared state is available to every interface.'
    objective.updatedAt = now()
    const workflow = snapshot.workflows.find((item) => item.id === completed.workflowId)
    if (workflow) workflow.state = 'completed'
    return
  }
  objective.summary = `${jobs.filter((job) => job.state === 'completed').length}/${jobs.length} jobs complete. Continuing authorized work without waiting for a prompt.`
  objective.updatedAt = now()
  if (completed.kind === 'account.research' && completed.result?.signal === 'multi-cloud') {
    enqueueJob(snapshot, {
      objectiveId: completed.objectiveId,
      workflowId: completed.workflowId,
      kind: 'research.infra',
      title: 'Deeper infrastructure research from multi-cloud signal',
      priority: 'P1',
      requiredCapabilities: ['research'],
      requiredIdentityId: null,
      idempotencyKey: `${completed.objectiveId}:research.infra:${completed.entityKey ?? 'batch'}`,
      entityKey: completed.entityKey,
      payload: { parent: completed.id },
    })
  }
}

export function defaultFleet(): Pick<FleetSnapshot, 'machines' | 'workers' | 'identities' | 'models'> {
  const ts = now()
  const grokbotIds = grokbotHarnessIdentityIds()
  const machines: MachineRecord[] = [
    { id: 'oakland-mini', name: 'Oakland Mac Mini', online: true, lastHeartbeatAt: ts, capabilities: ['research', 'attio', 'local-inference', 'coordination', 'meeting.brief', 'calendar', 'calendar.create', 'email.send'], identities: ['alex-byteport', 'alex-gmail', 'alex-calendar'], models: ['ollama-local'], agents: ['hermes', 'codex'], load: 0, recentFailures: 0 },
    { id: 'sf-mini', name: 'Alex SF Mac Mini', online: true, lastHeartbeatAt: ts, capabilities: ['research', 'linkedin.draft', 'browser'], identities: ['alex-byteport', 'katherine-byteport'], models: [], agents: ['hermes'], load: 0, recentFailures: 0 },
    { id: 'backup-mini', name: 'Backup Byteport Mac Mini', online: true, lastHeartbeatAt: ts, capabilities: ['research', 'attio', 'transcript.process'], identities: grokbotIds, models: ['openrouter-free'], agents: ['grokbot'], load: 0, recentFailures: 0 },
    { id: 'destrys-hp', name: 'DestrysHP', online: false, lastHeartbeatAt: ts - 600_000, capabilities: ['research', 'coding'], identities: [], models: [], agents: ['claude-code'], load: 0, recentFailures: 1 },
  ]
  const workers: WorkerRecord[] = [
    { id: 'hermes-oakland', kind: 'hermes', machineId: 'oakland-mini', online: true, lastHeartbeatAt: ts, capabilities: ['research', 'attio', 'browser', 'linkedin.draft', 'meeting.brief', 'calendar', 'calendar.create', 'email.draft', 'email.send'], identities: ['alex-byteport', 'alex-gmail', 'alex-calendar'], models: ['ollama-local'], load: 0, permissions: ['internal'] },
    { id: 'hermes-sf', kind: 'hermes', machineId: 'sf-mini', online: true, lastHeartbeatAt: ts, capabilities: ['linkedin.draft', 'browser', 'research', 'linkedin.send'], identities: ['katherine-byteport', 'alex-byteport'], models: [], load: 0, permissions: ['draft'] },
    { id: 'grokbot-backup', kind: 'grokbot', machineId: 'backup-mini', online: true, lastHeartbeatAt: ts, capabilities: ['research', 'attio', 'transcript.process'], identities: grokbotIds, models: ['openrouter-free'], load: 0, permissions: ['internal'] },
    { id: 'muse', kind: 'muse', machineId: 'oakland-mini', online: true, lastHeartbeatAt: ts, capabilities: ['research', 'campaign.define'], identities: [], models: ['claude-frontier'], load: 0, permissions: ['internal'] },
    { id: 'codex', kind: 'codex', machineId: 'oakland-mini', online: true, lastHeartbeatAt: ts, capabilities: ['coding'], identities: [], models: ['codex'], load: 0, permissions: ['internal'] },
  ]
  const identities: IdentityRecord[] = mergeIdentityRegistry([
    { id: 'alex-byteport', teammate: 'alex', principal: 'byteport', channel: 'linkedin', machineId: 'sf-mini', sessionHost: 'alex-browser', sessionStatus: 'unknown', autonomyLevel: 2, sendMode: 'staged' },
    { id: 'alex-gmail', teammate: 'alex', principal: 'byteport', channel: 'gmail', machineId: 'oakland-mini', sessionHost: 'hermes-oakland', sessionStatus: 'alive', autonomyLevel: 2, sendMode: 'draft_only' },
    { id: 'alex-calendar', teammate: 'alex', principal: 'byteport', channel: 'calendar', machineId: 'oakland-mini', sessionHost: 'hermes-oakland', sessionStatus: 'alive', autonomyLevel: 2, sendMode: 'draft_only' },
    { id: 'katherine-byteport', teammate: 'katherine', principal: 'byteport', channel: 'linkedin', machineId: 'sf-mini', sessionHost: 'hermes', sessionStatus: 'alive', autonomyLevel: 2, sendMode: 'draft_only' },
    { id: 'john-gradient', teammate: 'john', principal: 'gradient', channel: 'linkedin', machineId: null, sessionHost: 'luey', sessionStatus: 'unknown', autonomyLevel: 3, sendMode: 'live' },
  ])
  const baseline: ModelRecord[] = [
    { id: 'ollama-local', provider: 'ollama', tier: 'local_free', available: true, costPerUnit: 0, latencyMs: 800, successRate: 0.9, capabilities: ['classify', 'extract', 'general'] },
    { id: 'openrouter-free', provider: 'openrouter', tier: 'local_free', available: true, costPerUnit: 0, latencyMs: 1200, successRate: 0.85, capabilities: ['general'] },
    { id: 'openrouter-cheap', provider: 'openrouter', tier: 'inexpensive_cloud', available: true, costPerUnit: 0.02, latencyMs: 900, successRate: 0.92, capabilities: ['general', 'write'] },
    { id: 'claude-frontier', provider: 'anthropic', tier: 'frontier', available: true, costPerUnit: 1, latencyMs: 1500, successRate: 0.97, capabilities: ['write', 'reason', 'general'] },
    { id: 'codex', provider: 'openai', tier: 'frontier', available: true, costPerUnit: 0, latencyMs: 1100, successRate: 0.95, capabilities: ['coding'] },
  ]
  const discovered = discoverModelPool(ts)
  const models: ModelRecord[] = [...baseline]
  for (const model of discovered) {
    if (!models.some((item) => item.id === model.id)) models.push(model)
  }
  return { machines, workers, identities, models }
}
