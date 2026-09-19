#!/usr/bin/env node
/**
 * Fleet worker protocol CLI.
 * Machines run: pnpm fleet-worker --worker hermes-oakland --advertise oakland-mini
 * Or against an HTTP control plane: FLEET_OS_URL=http://host:3000/api/fleet-os
*/
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FleetControlPlane } from './control-plane'
import { FleetStore, fleetOsHome } from './store'
import { runContinuousWorker } from './worker-loop'
import { createLiveAttioAdapter } from './attio-live'

function arg(name: string, fallback?: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`)
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]
  return fallback
}

async function httpAction(base: string, body: Record<string, unknown>) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`)
  return response.json() as Promise<Record<string, unknown>

}

async function main() {
  const workerId = arg('worker', process.env.FLEET_WORKER_ID)
  if (!workerId) {
    console.error('Usage: fleet-worker --worker <workerId> [--ticks 20] [--seed] [--advertise <machineId>]')
    process.exit(2)
  }
  const ticks = Number(arg('ticks', '20'))
  const base = process.env.FLEET_OS_URL

  if (base) {
    await httpAction(base, { action: 'heartbeat', workerId })
    for (let i = 0; i < ticks; i += 1) {
      const claimed = await httpAction(base, { action: 'claim', workerId }) as { job?: { id: string; kind: string } | null }
      if (!claimed.job) {
        console.log(JSON.stringify({ workerId, idle: true, tick: i }))
        break
      }
      await httpAction(base, {
        action: 'complete',
        jobId: claimed.job.id,
        workerId,
        result: { ok: true, kind: claimed.job.kind, via: 'http-worker' },
        verified: true,
      })
      console.log(JSON.stringify({ workerId, completed: claimed.job.id, kind: claimed.job.kind }))
    }
    return
  }

  const home = process.env.FLEET_OS_HOME ?? fleetOsHome()
  mkdirSync(home, { recursive: true })
  const plane = new FleetControlPlane(new FleetStore(path.join(home, 'state.json')))
  if (process.argv.includes('--seed') || !plane.snapshot().workers.length) plane.seedDefaults()

  const advertise = arg('advertise')
  if (advertise) {
    const { FLEET_MACHINE_SEEDS } = await import('./heartbeat')
    const seed = FLEET_MACHINE_SEEDS.find((item) => item.machineId === advertise)
    if (!seed) {
      console.error(`Unknown machine advertisement: ${advertise}`)
      process.exit(2)
    }
    plane.applyMachineAdvertisement(seed)
    console.log(JSON.stringify({ advertised: seed.machineId, workers: seed.workers?.map((item) => item.id) ?? seed.agents }))
    if (process.argv.includes('--heartbeat-only')) return
  }

  const { adapter: attio, mode: attioMode } = createLiveAttioAdapter()
  const result = await runContinuousWorker(plane, workerId, {
    maxTicks: ticks,
    attio,
  })
  if (process.argv.includes('--expire-stale')) {
    const health = plane.expireStaleHeartbeats()
    console.log(JSON.stringify({ expired: health, fleetHealth: plane.fleetHealth() }, null, 2))
  }
  console.log(JSON.stringify({ attioMode, fleetHealth: plane.fleetHealth() }, null, 2))
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
