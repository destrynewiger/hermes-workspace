#!/usr/bin/env node
/**
 * Continuous machine advertisement for Tailscale hosts.
 *
 * On each Mac Mini / DestrysHP:
 *   pnpm fleet-advertise --machine oakland-mini --interval 30
 *   FLEET_OS_URL=http://oakland:3000/api/fleet-os pnpm fleet-advertise --machine sf-mini
 *
 * Heartbeats keep identity/capability routing honest. Silent machines drop offline
 * after TTL via expireStaleHeartbeats on the control plane.
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FleetControlPlane } from './control-plane'
import { FleetStore, fleetOsHome } from './store'
import { FLEET_MACHINE_SEEDS } from './heartbeat'

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

async function httpAdvertise(base: string, machineId: string) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'advertise', machineId }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}

async function httpHeartbeat(base: string, workerId: string, machineId: string) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'heartbeat', workerId, machineId }),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json()
}

async function main() {
  const machineId = arg('machine', process.env.FLEET_MACHINE_ID)
  if (!machineId) {
    console.error('Usage: fleet-advertise --machine <oakland-mini|sf-mini|backup-mini|destrys-hp> [--interval 30] [--once]')
    process.exit(2)
  }
  const seed = FLEET_MACHINE_SEEDS.find((item) => item.machineId === machineId)
  if (!seed) {
    console.error(`Unknown machine: ${machineId}. Known: ${FLEET_MACHINE_SEEDS.map((item) => item.machineId).join(', ')}`)
    process.exit(2)
  }

  const intervalSec = Number(arg('interval', process.env.FLEET_ADVERTISE_INTERVAL ?? '30'))
  const once = process.argv.includes('--once')
  const base = process.env.FLEET_OS_URL

  async function tick() {
    if (base) {
      await httpAdvertise(base, machineId)
      for (const worker of seed.workers ?? []) {
        await httpHeartbeat(base, worker.id, machineId)
      }
      console.log(JSON.stringify({
        at: new Date().toISOString(),
        mode: 'http',
        machineId,
        workers: (seed.workers ?? []).map((item) => item.id),
        url: base,
      }))
      return
    }

    const home = process.env.FLEET_OS_HOME ?? fleetOsHome()
    mkdirSync(home, { recursive: true })
    const plane = new FleetControlPlane(new FleetStore(path.join(home, 'state.json')))
    if (!plane.snapshot().machines.length) plane.seedDefaults()
    plane.applyMachineAdvertisement({ ...seed, at: Date.now() })
    for (const worker of seed.workers ?? []) {
      plane.heartbeat({ workerId: worker.id, machineId, at: Date.now() })
    }
    const stale = plane.expireStaleHeartbeats()
    console.log(JSON.stringify({
      at: new Date().toISOString(),
      mode: 'local',
      machineId,
      workers: (seed.workers ?? []).map((item) => item.id),
      health: plane.fleetHealth(),
      expired: stale,
    }))
  }

  await tick()
  if (once) return

  const ms = Math.max(5, intervalSec) * 1000
  console.error(`Advertising ${machineId} every ${intervalSec}s. Ctrl+C to stop.`)
  setInterval(() => {
    tick().catch((error) => {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }))
    })
  }, ms)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
