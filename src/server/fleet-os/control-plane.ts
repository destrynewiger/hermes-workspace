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
