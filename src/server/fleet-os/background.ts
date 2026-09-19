import type { FleetControlPlane } from './control-plane'
import type { Priority } from './types'

export type BackgroundKind =
  | 'enrich.incomplete'
  | 'dedupe.contacts'
  | 'research.priority_accounts'
  | 'meeting.brief_tomorrow'
  | 'reconcile.calendar_attio'

const BACKGROUND_SPECS: Array<{
  kind: BackgroundKind
  title: string
  priority: Priority
  requiredCapabilities: string[]
}> = [
  { kind: 'enrich.incomplete', title: 'Enrich incomplete Attio records', priority: 'P4', requiredCapabilities: ['attio', 'research'] },
  { kind: 'dedupe.contacts', title: 'Resolve duplicate contacts', priority: 'P4', requiredCapabilities: ['attio'] },
  { kind: 'research.priority_accounts', title: 'Research highest-priority accounts', priority: 'P3', requiredCapabilities: ['research'] },
  { kind: 'meeting.brief_tomorrow', title: 'Prepare tomorrow meeting briefings', priority: 'P1', requiredCapabilities: ['meeting.brief', 'research'] },
  { kind: 'reconcile.calendar_attio', title: 'Reconcile calendar and Attio', priority: 'P4', requiredCapabilities: ['attio', 'calendar'] },
]

/**
 * When urgent/campaign queues are empty, seed a bounded background backlog.
 * Idle compute pulls useful authorized work — it does not invent external sends.
 */
export function enqueueBackgroundWork(plane: FleetControlPlane, options?: {
  kinds?: BackgroundKind[]
  objectiveTitle?: string
}): { enqueued: string[]; skipped: string[] } {
  const snapshot = plane.snapshot()
  const urgent = snapshot.jobs.some((job) =>
    ['queued', 'leased', 'running', 'verifying'].includes(job.state)
    && (job.priority === 'P0' || job.priority === 'P1' || job.priority === 'P2'),
  )
  if (urgent) return { enqueued: [], skipped: ['urgent_work_present'] }

  const active = snapshot.objectives.find((item) => item.state === 'active')
  const objective = active ?? plane.submitObjective({
    title: options?.objectiveTitle ?? 'Background fleet work',
    intent: 'Use spare fleet capacity for authorized enrichment, research, and reconciliation.',
    sourceInterface: 'api',
    priority: 'P4',
  }).objective

  const workflowId = snapshot.workflows.find((item) => item.objectiveId === objective.id)?.id
    ?? plane.snapshot().workflows.find((item) => item.objectiveId === objective.id)?.id
  if (!workflowId) return { enqueued: [], skipped: ['no_workflow'] }

  const allowed = new Set(options?.kinds ?? BACKGROUND_SPECS.map((spec) => spec.kind))
  const enqueued: string[] = []
  const skipped: string[] = []

  for (const spec of BACKGROUND_SPECS) {
    if (!allowed.has(spec.kind)) continue
    // Use control plane enqueue via a tiny internal job complete with nextJobs pattern:
    // submit a no-op research job completion is heavy; instead mutate through a dedicated API.
    const key = `bg:${spec.kind}`
    const exists = plane.snapshot().jobs.some((job) => job.idempotencyKey === key && job.state !== 'dead_letter')
    if (exists) {
      skipped.push(spec.kind)
      continue
    }
    plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: spec.kind,
      title: spec.title,
      priority: spec.priority,
      requiredCapabilities: spec.requiredCapabilities,
      idempotencyKey: key,
    })
    enqueued.push(spec.kind)
  }
  return { enqueued, skipped }
}
