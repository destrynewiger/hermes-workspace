import { ACTION_AUTONOMY, type AutonomyLevel, type IdentityRecord } from './types'
import { blockSendIfSessionUnhealthy } from './session-health'

export type AutonomyDecision =
  | { allow: true; execute: true; reason: string }
  | { allow: true; execute: false; requiresApproval: true; reason: string }
  | { allow: false; execute: false; reason: string }

export function autonomyForAction(action: string): AutonomyLevel {
  return ACTION_AUTONOMY[action] ?? 2
}

export function decideAutonomy(action: string, identity?: IdentityRecord | null): AutonomyDecision {
  const required = autonomyForAction(action)
  if (required <= 1) {
    return { allow: true; execute: true; reason: 'Internal, reversible work runs without approval.' }
  }
  if (!identity) {
    return { allow: false; execute: false; reason: 'External action requires an authorized identity.' }
  }
  if (required >= 3) {
    const session = blockSendIfSessionUnhealthy(identity)
    if (!session.allow) {
      return { allow: false; execute: false; reason: session.reason }
    }
  }
  if (required === 2 || identity.sendMode === 'draft_only' || identity.sendMode === 'staged' || identity.sendMode === 'planned') {
    return { allow: true; execute: false; requiresApproval: true; reason: 'Draft the external action and wait for approval.' }
  }
  if (identity.autonomyLevel >= required && identity.sendMode === 'live') {
    return { allow: true; execute: true; reason: `Supervised lane ${identity.id} may execute ${action}.` }
  }
  return { allow: true; execute: false; requiresApproval: true; reason: 'Action exceeds the identity autonomy lane.' }
}

export function shouldAskHuman(decision: AutonomyDecision): boolean {
  return !decision.execute
}
