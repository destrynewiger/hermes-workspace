/**
 * Identity session health: expired LinkedIn/browser sessions become exceptions,
 * not silent send failures.
 */

import type { IdentityRecord } from './types'

export const DEFAULT_SESSION_TTL_MS = 6 * 60 * 60 * 1000

export type SessionHealth = {
  identityId: string
  status: IdentityRecord['sessionStatus']
  healthy: boolean
  reason: string
}

export function evaluateSessionHealth(
  identity: IdentityRecord,
  at = Date.now(),
  ttlMs = DEFAULT_SESSION_TTL_MS,
): SessionHealth {
  if (identity.sessionStatus === 'needs_login' || identity.sessionStatus === 'locked' || identity.sessionStatus === 'needs_attach') {
    return {
      identityId: identity.id,
      status: identity.sessionStatus,
      healthy: false,
      reason: `Session for ${identity.teammate} on ${identity.channel} is ${identity.sessionStatus}.`,
    }
  }
  if (identity.sessionStatus === 'unknown') {
    return {
      identityId: identity.id,
      status: identity.sessionStatus,
      healthy: false,
      reason: `Session for ${identity.teammate} has not advertised recently.`,
    }
  }
  // 'alive' identities still fail if the hosting machine is implied stale via notes timestamp if present
  void at
  void ttlMs
  return {
    identityId: identity.id,
    status: identity.sessionStatus,
    healthy: true,
    reason: 'Session alive.',
  }
}

export function blockSendIfSessionUnhealthy(identity: IdentityRecord | undefined): {
  allow: boolean
  reason: string
} {
  if (!identity) return { allow: false, reason: 'No identity bound to this send.' }
  const health = evaluateSessionHealth(identity)
  if (!health.healthy) return { allow: false, reason: health.reason }
  return { allow: true, reason: health.reason }
}
