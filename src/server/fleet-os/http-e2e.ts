/**
 * End-to-end proof that fleet hosts coordinate over HTTP (the Tailscale path).
 * Starts an ephemeral control plane, advertises Oakland + Backup, runs Toronto
 * via Hermes command, drains work, asks GrokBot for status, syncs ledger.
 */

import { createServer, type Server } from 'node:http'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FleetControlPlane } from './control-plane'
import { FleetStore } from './store'
import { FLEET_MACHINE_SEEDS } from './heartbeat'
import { handleFleetHttp } from './api-handlers'

async function post(base: string, body: Record<string, unknown>) {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await response.json() as Record<string, unknown>
  if (!response.ok || json.ok === false) {
    throw new Error(`HTTP ${response.status}: ${JSON.stringify(json)}`)
  }
  return json
}

async function get(base: string, q?: string) {
  const url = q ? `${base}?q=${encodeURIComponent(q)}` : base
  const response = await fetch(url)
  return response.json() as Promise<Record<string, unknown>>
}

export async function runHttpFleetE2E(dir: string) {
  mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, 'state.json')
  const ledgerPath = path.join(dir, 'ledger.sqlite')
  const plane = new FleetControlPlane(new FleetStore(statePath))
  plane.seedDefaults()

  let server: Server | null = null
  const base = await new Promise<string>((resolve, reject) => {
    server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let body: Record<string, unknown> | null = null
      if (req.method === 'POST') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks).toString('utf8')
        body = raw.trim() ? JSON.parse(raw) as Record<string, unknown> : {}
      }
      const result = await handleFleetHttp(plane, req.method ?? 'GET', url.searchParams, body)
      res.writeHead(result.status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result.body))
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (!address || typeof address === 'string') reject(new Error('no port'))
      else resolve(`http://127.0.0.1:${address.port}`)
    })
  })

  try {
    await post(base, { action: 'advertise', machineId: 'oakland-mini' })
    await post(base, { action: 'advertise', machineId: 'backup-mini' })
    await post(base, { action: 'advertise', machineId: 'sf-mini' })

    const hermes = await post(base, {
      action: 'command',
      text: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })

    const drainOakland = await post(base, {
      action: 'drain',
      workerId: 'hermes-oakland',
      ticks: 8,
    })

    // Simulate Oakland going quiet: mark offline via fail path isn't enough;
    // heartbeat only Backup, expire stale Oakland after TTL.
    plane.markOffline('hermes-oakland')
    await post(base, { action: 'heartbeat', workerId: 'grokbot-backup', machineId: 'backup-mini' })

    const grok = await post(base, {
      action: 'command',
      text: 'Where are we on Toronto dinner?',
      sourceInterface: 'grokbot',
    })

    const drainBackup = await post(base, {
      action: 'drain',
      workerId: 'grokbot-backup',
      ticks: 6,
    })

    const luma = await post(base, {
      action: 'luma',
      body: {
        type: 'guest.approved',
        data: {
          event: { name: 'Toronto dinner', api_id: 'evt_http_1' },
          guest: { email: 'vp@acme.example', name: 'VP Acme', status: 'approved' },
        },
      },
    })

    const ledger = await post(base, {
      action: 'sync-ledger',
      ledgerPath,
    })

    const sessionHealth = await post(base, { action: 'session-health' })
    const reclaim = await post(base, { action: 'reclaim' })
    const readiness = await post(base, { action: 'readiness' })
    const attioReconcile = await post(base, { action: 'attio-reconcile' })

    const status = await get(base, 'Toronto')
    const health = plane.fleetHealth()

    return {
      base,
      hermesObjectiveId: hermes.objectiveId,
      grokSameObjective: grok.objectiveId === hermes.objectiveId,
      oaklandDrained: Array.isArray((drainOakland.drain as { completed?: string[] })?.completed)
        ? (drainOakland.drain as { completed: string[] }).completed.length
        : 0,
      backupDrained: Array.isArray((drainBackup.drain as { completed?: string[] })?.completed)
        ? (drainBackup.drain as { completed: string[] }).completed.length
        : 0,
      torontoPicture: status.picture,
      campaign: plane.campaignStatus('Toronto'),
      lumaCampaign: luma.campaign,
      ledgerInserted: ledger.inserted,
      ledgerSequence: ledger.latestSequence,
      sessionUnhealthy: Array.isArray(sessionHealth.unhealthy) ? sessionHealth.unhealthy.length : -1,
      reclaimed: typeof reclaim.reclaimed === 'number' ? reclaim.reclaimed : -1,
      readinessReady: Boolean((readiness.readiness as { readyForProductionDoD?: boolean })?.readyForProductionDoD),
      readinessBlockers: Array.isArray((readiness.readiness as { blockers?: string[] })?.blockers)
        ? (readiness.readiness as { blockers: string[] }).blockers.length
        : -1,
      attioReconcileExisting: Number((attioReconcile.reconcile as { existing?: number })?.existing ?? -1),
      health: {
        onlineMachines: health.onlineMachines,
        onlineWorkers: health.onlineWorkers,
        oaklandOffline: plane.snapshot().workers.find((item) => item.id === 'hermes-oakland')?.online === false,
      },
      seededMachines: FLEET_MACHINE_SEEDS.map((item) => item.machineId),
    }
  } finally {
    await new Promise<void>((resolve) => server?.close(() => resolve()))
  }
}
