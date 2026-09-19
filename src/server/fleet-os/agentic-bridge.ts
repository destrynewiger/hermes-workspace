/**
 * Protocol bridge between Fleet OS (JSON control plane) and agentic-os
 * (SQLite WAL event ledger). This package cannot push agentic-os, so we
 * emit ledger-compatible events that a Mac Mini host can append via
 * createEventLedger().append(...).
 *
 * Contract mirrors agentic-os/server/lib/event-ledger.js:
 *   eventId, streamId, type, actor, occurredAt, payload
 */

import type {
  AttemptRecord,
  EventRecord,
  JobRecord,
  ObjectiveRecord,
  WorkflowRecord,
} from './types'

export type AgenticLedgerEvent = {
  eventId: string
  streamId: string
  expectedVersion?: number | null
  type: string
  actor: string
  occurredAt: number
  payload: Record<string, unknown>
}

export type AgenticOutboxEntry = AgenticLedgerEvent & {
  source: 'fleet-os'
  exportedAt: number
}

function streamForObjective(objectiveId: string): string {
  return `fleet-os:objective:${objectiveId}`
}

function streamForJob(jobId: string): string {
  return `fleet-os:job:${jobId}`
}

/** Map a Fleet OS event into an agentic-os appendable ledger event. */
export function fleetEventToLedger(event: EventRecord): AgenticLedgerEvent {
  const objectiveId = event.objectiveId
    ?? (typeof event.payload.objectiveId === 'string' ? event.payload.objectiveId : null)
    ?? (typeof event.payload.campaignId === 'string' ? `campaign:${event.payload.campaignId}` : null)
    ?? 'fleet-os:global'
  return {
    eventId: event.id,
    streamId: streamForObjective(objectiveId),
    type: `fleet.${event.type}`,
    actor: event.source,
    occurredAt: event.at,
    payload: {
      fleetEventId: event.id,
      objectiveId: event.objectiveId,
      jobId: event.jobId,
      entityKey: event.entityKey,
      ...event.payload,
    },
  }
}

/** Map objective create/resume into a durable work-item style ledger event. */
export function objectiveToLedger(
  objective: ObjectiveRecord,
  actor = 'fleet-os',
): AgenticLedgerEvent {
  return {
    eventId: `fleet-obj-${objective.id}-${objective.updatedAt}`,
    streamId: streamForObjective(objective.id),
    type: 'fleet.objective.upserted',
    actor,
    occurredAt: objective.updatedAt,
    payload: {
      workItemId: objective.id,
      title: objective.title,
      intent: objective.intent,
      state: objective.state,
      priority: objective.priority,
      sourceInterface: objective.sourceInterface,
      campaignId: objective.campaignId,
      summary: objective.summary,
    },
  }
}

export function jobAttemptToLedger(
  job: JobRecord,
  attempt: AttemptRecord,
  actor = 'fleet-os',
): AgenticLedgerEvent {
  return {
    eventId: attempt.id,
    streamId: streamForJob(job.id),
    type: attempt.outcome === 'failed' || attempt.error
      ? 'fleet.job.attempt_failed'
      : attempt.outcome === 'ok'
        ? 'fleet.job.attempt_ok'
        : 'fleet.job.attempted',
    actor,
    occurredAt: attempt.finishedAt ?? attempt.startedAt,
    payload: {
      workItemId: job.objectiveId,
      jobId: job.id,
      kind: job.kind,
      workerId: attempt.workerId,
      modelId: attempt.modelId,
      state: job.state,
      outcome: attempt.outcome,
      error: attempt.error,
      idempotencyKey: job.idempotencyKey,
      runId: attempt.id,
    },
  }
}

export function jobTerminalToLedger(job: JobRecord, actor = 'fleet-os'): AgenticLedgerEvent {
  const terminal = ['completed', 'failed', 'cancelled', 'dead_letter'].includes(job.state)
  return {
    eventId: `fleet-job-${job.id}-${job.state}-${job.updatedAt}`,
    streamId: streamForJob(job.id),
    type: terminal ? `fleet.job.${job.state}` : 'fleet.job.updated',
    actor,
    occurredAt: job.updatedAt,
    payload: {
      workItemId: job.objectiveId,
      jobId: job.id,
      kind: job.kind,
      state: job.state,
      assignedWorkerId: job.assignedWorkerId,
      assignedMachineId: job.assignedMachineId,
      assignedModelId: job.assignedModelId,
      requiredIdentityId: job.requiredIdentityId,
      result: job.result,
      evidence: job.evidence,
      nextAction: job.nextAction,
      crmImpact: job.crmImpact,
      idempotencyKey: job.idempotencyKey,
      attempts: job.attempts,
    },
  }
}

/** Snapshot export: every objective + recent events + terminal jobs as outbox entries. */
export function buildAgenticOutbox(input: {
  objectives: ObjectiveRecord[]
  workflows?: WorkflowRecord[]
  events: EventRecord[]
  jobs: JobRecord[]
  attempts?: AttemptRecord[]
  now?: number
}): AgenticOutboxEntry[] {
  const now = input.now ?? Date.now()
  const entries: AgenticOutboxEntry[] = []
  const attempts = input.attempts ?? []

  for (const objective of input.objectives) {
    entries.push({ ...objectiveToLedger(objective), source: 'fleet-os', exportedAt: now })
  }
  for (const event of input.events) {
    entries.push({ ...fleetEventToLedger(event), source: 'fleet-os', exportedAt: now })
  }
  for (const job of input.jobs) {
    for (const attempt of attempts.filter((item) => item.jobId === job.id)) {
      entries.push({ ...jobAttemptToLedger(job, attempt), source: 'fleet-os', exportedAt: now })
    }
    if (['completed', 'failed', 'cancelled', 'dead_letter', 'verifying'].includes(job.state)) {
      entries.push({ ...jobTerminalToLedger(job), source: 'fleet-os', exportedAt: now })
    }
  }
  return entries
}

/**
 * Import helper for agentic-os hosts: filter to appendable ledger events and
 * drop duplicates by eventId. The host still owns optimistic concurrency.
 */
export function ledgerEventsFromOutbox(entries: AgenticOutboxEntry[]): AgenticLedgerEvent[] {
  const seen = new Set<string>()
  const out: AgenticLedgerEvent[] = []
  for (const entry of entries) {
    if (seen.has(entry.eventId)) continue
    seen.add(entry.eventId)
    out.push({
      eventId: entry.eventId,
      streamId: entry.streamId,
      expectedVersion: entry.expectedVersion ?? null,
      type: entry.type,
      actor: entry.actor,
      occurredAt: entry.occurredAt,
      payload: entry.payload,
    })
  }
  return out
}
