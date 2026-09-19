export const PRIORITIES = ['P0', 'P1', 'P2', 'P3', 'P4'] as const
export type Priority = (typeof PRIORITIES)[number]

export const JOB_STATES = [
  'queued',
  'leased',
  'running',
  'verifying',
  'completed',
  'failed',
  'blocked',
  'dead_letter',
] as const
export type JobState = (typeof JOB_STATES)[number]

export const OBJECTIVE_STATES = ['active', 'blocked', 'completed', 'cancelled'] as const
export type ObjectiveState = (typeof OBJECTIVE_STATES)[number]

export const AUTONOMY_LEVELS = [0, 1, 2, 3, 4] as const
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number]

export const MODEL_TIERS = ['deterministic', 'local_free', 'inexpensive_cloud', 'frontier'] as const
export type ModelTier = (typeof MODEL_TIERS)[number]

export const INTERFACES = [
  'hermes',
  'grokbot',
  'muse',
  'codex',
  'claude-code',
  'gemini-spark',
  'telegram',
  'slack',
  'api',
] as const
export type AgentInterface = (typeof INTERFACES)[number]

export type AutonomyPolicy = {
  observe: 0
  internal: 1
  draft: 2
  supervised: 3
  autonomousLane: 4
}

export type MachineRecord = {
  id: string
  name: string
  online: boolean
  lastHeartbeatAt: number
  capabilities: string[]
  identities: string[]
  models: string[]
  agents: string[]
  load: number
  recentFailures: number
  notes?: string
}

export type WorkerRecord = {
  id: string
  kind: AgentInterface | string
  machineId: string
  online: boolean
  lastHeartbeatAt: number
  capabilities: string[]
  identities: string[]
  models: string[]
  load: number
  permissions: string[]
}

export type IdentityRecord = {
  id: string
  teammate: string
  principal: string
  channel: string
  machineId: string | null
  sessionHost: string
  sessionStatus: 'alive' | 'needs_login' | 'locked' | 'unknown' | 'needs_attach'
  autonomyLevel: AutonomyLevel
  sendMode: 'live' | 'draft_only' | 'staged' | 'planned'
}

export type ModelRecord = {
  id: string
  provider: string
  tier: ModelTier
  available: boolean
  costPerUnit: number
  latencyMs: number
  successRate: number
  capabilities: string[]
}

export type ObjectiveRecord = {
  id: string
  title: string
  intent: string
  sourceInterface: AgentInterface | string
  createdBy: string
  state: ObjectiveState
  priority: Priority
  campaignId: string | null
  createdAt: number
  updatedAt: number
  summary: string
}

export type WorkflowRecord = {
  id: string
  objectiveId: string
  kind: string
  state: ObjectiveState | 'running'
  createdAt: number
  updatedAt: number
}

export type JobRecord = {
  id: string
  objectiveId: string
  workflowId: string
  kind: string
  title: string
  state: JobState
  priority: Priority
  requiredCapabilities: string[]
  requiredIdentityId: string | null
  preferredModelId: string | null
  acceptableModelTiers: ModelTier[]
  idempotencyKey: string
  entityKey: string | null
  assignedWorkerId: string | null
  assignedMachineId: string | null
  assignedModelId: string | null
  leaseExpiresAt: number | null
  attempts: number
  maxAttempts: number
  evidence: Array<{ kind: string; reference: string; verified: boolean }>
  result: Record<string, unknown> | null
  nextAction: string | null
  crmImpact: string | null
  createdAt: number
  updatedAt: number
  payload: Record<string, unknown>
}

export type AttemptRecord = {
  id: string
  jobId: string
  workerId: string
  modelId: string | null
  startedAt: number
  finishedAt: number | null
  outcome: 'running' | 'ok' | 'failed' | 'abandoned'
  error: string | null
}

export type EventRecord = {
  id: string
  type: string
  at: number
  source: string
  objectiveId: string | null
  jobId: string | null
  entityKey: string | null
  payload: Record<string, unknown>
}

export type EntityRecord = {
  key: string
  kind: 'person' | 'company' | 'campaign' | 'meeting' | 'signal' | 'opportunity'
  attioId: string | null
  displayName: string
  aliases: string[]
}

export type ApprovalRecord = {
  id: string
  jobId: string
  action: string
  status: 'pending' | 'approved' | 'rejected'
  decision: string
  createdAt: number
}

export type CostRecord = {
  id: string
  at: number
  workflowId: string | null
  jobId: string | null
  provider: string
  modelId: string
  machineId: string | null
  taskType: string
  amount: number
  success: boolean
}

export type CampaignRecord = {
  id: string
  objectiveId: string
  title: string
  targetCount: number
  contacted: number
  accepted: number
  rsvps: number
  attended: number
  geography: string | null
  state: 'active' | 'completed' | 'blocked'
  gaps: string[]
  updatedAt: number
}

export type CommitmentRecord = {
  id: string
  meetingKey: string
  objectiveId: string | null
  owner: string
  text: string
  dueAt: number | null
  state: 'open' | 'done' | 'cancelled'
  attioTaskId: string | null
  createdAt: number
}

export type SuppressionRecord = {
  id: string
  channel: 'email' | 'linkedin' | 'any'
  key: string
  reason: string
  source: string
  createdAt: number
  expiresAt: number | null
}

export type FleetSnapshot = {
  version: 1
  machines: MachineRecord[]
  workers: WorkerRecord[]
  identities: IdentityRecord[]
  models: ModelRecord[]
  objectives: ObjectiveRecord[]
  workflows: WorkflowRecord[]
  jobs: JobRecord[]
  attempts: AttemptRecord[]
  events: EventRecord[]
  entities: EntityRecord[]
  approvals: ApprovalRecord[]
  costs: CostRecord[]
  campaigns: CampaignRecord[]
  commitments: CommitmentRecord[]
  suppressions: SuppressionRecord[]
}

export function emptySnapshot(): FleetSnapshot {
  return {
    version: 1,
    machines: [],
    workers: [],
    identities: [],
    models: [],
    objectives: [],
    workflows: [],
    jobs: [],
    attempts: [],
    events: [],
    entities: [],
    approvals: [],
    costs: [],
    campaigns: [],
    commitments: [],
    suppressions: [],
  }
}

export const ACTION_AUTONOMY: Record<string, AutonomyLevel> = {
  'research.run': 1,
  'enrich.run': 1,
  'attio.reconcile': 1,
  'attio.commitment_sync': 1,
  'meeting.brief': 1,
  'transcript.process': 1,
  'queue.manage': 1,
  'linkedin.draft': 2,
  'email.draft': 2,
  'intro.draft': 2,
  'linkedin.send': 3,
  'email.send': 3,
  'calendar.create': 3,
}
