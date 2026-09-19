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
