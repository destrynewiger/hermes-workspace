/**
 * Optional auto-sync of Fleet OS state into the agentic-os-compatible ledger.
 * Enable with FLEET_AUTO_SYNC_LEDGER=1 (default on for fleet-worker / advertise).
 */

import { buildAgenticOutbox } from './agentic-bridge'
import { appendOutboxToLedger, defaultLedgerPath, type LedgerSyncReport } from './agentic-ledger'
import type { FleetControlPlane } from './control-plane'

export function autoSyncEnabled(): boolean {
  const value = process.env.FLEET_AUTO_SYNC_LEDGER?.trim()
  if (value === '0' || value?.toLowerCase() === 'false') return false
  if (value === '1' || value?.toLowerCase() === 'true') return true
  // Default: sync when a ledger path is explicitly configured.
  return Boolean(process.env.FLEET_LEDGER_PATH || process.env.AGENTIC_LEDGER_PATH)
}

export function syncPlaneToLedger(
  plane: FleetControlPlane,
  options?: { filename?: string },
): LedgerSyncReport | null {
  if (!autoSyncEnabled() && !options?.filename) return null
  const snap = plane.snapshot()
  const outbox = buildAgenticOutbox({
    objectives: snap.objectives,
    events: snap.events,
    jobs: snap.jobs,
    attempts: snap.attempts,
  })
  return appendOutboxToLedger(outbox, {
    filename: options?.filename ?? defaultLedgerPath(),
  })
}
