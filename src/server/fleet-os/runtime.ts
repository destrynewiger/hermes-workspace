/**
 * Process-wide Fleet OS singleton.
 * Hermes must not construct a new control plane per HTTP request — that
 * dropped objectives between Hermes and GrokBot. The store file is the
 * durable source; this cache avoids re-reading on every action in one process.
 */

import path from 'node:path'
import { mkdirSync } from 'node:fs'
import { FleetControlPlane } from './control-plane'
import { FleetStore, fleetOsHome } from './store'
import { FLEET_MACHINE_SEEDS } from './heartbeat'

let cached: { plane: FleetControlPlane; path: string } | null = null

export function fleetStateFile(): string {
  return process.env.FLEET_OS_STATE
    ?? path.join(process.env.FLEET_OS_HOME ?? fleetOsHome(), 'state.json')
}

export function getFleetPlane(options?: { seed?: boolean; statePath?: string }): FleetControlPlane {
  const statePath = options?.statePath ?? fleetStateFile()
  mkdirSync(path.dirname(statePath), { recursive: true })
  if (cached && cached.path === statePath) return cached.plane
  const plane = new FleetControlPlane(new FleetStore(statePath))
  if (options?.seed !== false && !plane.snapshot().machines.length) {
    plane.seedDefaults()
    for (const seed of FLEET_MACHINE_SEEDS) plane.applyMachineAdvertisement(seed)
  } else if (options?.seed !== false) {
    plane.ensureCanonicalRegistry()
    plane.repairStuckJobs()
  }
  cached = { plane, path: statePath }
  return plane
}

export function resetFleetPlaneCache(): void {
  cached = null
}
