import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FleetControlPlane } from './control-plane'
import { createTestPlane, runSignalToDraftLoop } from './gtm-loop'
import { fallbackAfterFailure, routeModel } from './model-router'
import { FleetStore } from './store'
import { decideAutonomy } from './autonomy'
import { MemoryAttioAdapter, reconcileTargets } from './attio'
import { verifyJobResult } from './verify'
import { runContinuousWorker, runFleetUntilIdle } from './worker-loop'
import type { ModelRecord } from './types'

const dirs: string[] = []

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-os-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('fleet-os control plane', () => {
  it('lets Hermes record an objective that GrokBot can continue from shared state', () => {
    const plane = createTestPlane(tmp())
    const fromHermes = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const fromGrok = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Where are we on Toronto?',
      sourceInterface: 'grokbot',
    })
    expect(fromGrok.objective.id).toBe(fromHermes.objective.id)
    expect(plane.status('Toronto').picture).toMatch(/Toronto dinner/)
    expect(fromGrok.jobs.length).toBeGreaterThan(1)
  })
})

describe('required coverage', () => {
  it('exposes Tailscale mesh inventory with known Oakland/SF IPs', async () => {
    const { FLEET_MESH_HOSTS, summarizeMeshInventory, meshHostByMachineId } = await import('./fleet-mesh')
    expect(meshHostByMachineId('oakland-mini')?.tailscaleHostname).toBe('alex-mac-mini-1')
    expect(meshHostByMachineId('sf-mini')?.tailscaleIp).toBe('100.106.243.19')
    expect(summarizeMeshInventory().withKnownIp).toBeGreaterThanOrEqual(2)
    expect(FLEET_MESH_HOSTS.some((host) => host.machineId === 'backup-mini' && !host.tailscaleIp)).toBe(true)
  })

  it('enriches backup-mini IP from tailscale status peers', async () => {
    const { enrichMeshFromTailscaleStatus } = await import('./fleet-mesh')
    const enriched = enrichMeshFromTailscaleStatus({
      Self: {
        HostName: 'alex-mac-mini-1',
        TailscaleIPs: ['100.118.142.13'],
      },
      Peer: {
        a: { HostName: 'alex-agent-mini', TailscaleIPs: ['100.106.243.19'] },
        b: { HostName: 'backup-byteport-mini', TailscaleIPs: ['100.99.88.77'] },
      },
    })
    expect(enriched.selfIsOakland).toBe(true)
    expect(enriched.hosts.find((h) => h.machineId === 'backup-mini')?.tailscaleIp).toBe('100.99.88.77')
  })

  it('duo-poll fetches Amplemarket watched leads without Sumble', async () => {
    const previous = process.env.AMPLEMARKET_API_KEY
    process.env.AMPLEMARKET_API_KEY = 'ample-key'
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url))
      expect(String(url).includes('sumble')).toBe(false)
      return {
        ok: true,
        json: async () => ({
          duo_leads: [{
            person: { name: 'Eliott Macdonald' },
            company: { name: 'Teradyne' },
            signal: { kind: 'recent_job_changes', title: 'Was recently promoted' },
          }],
        }),
      } as Response
    }) as typeof fetch
    try {
      const { handleFleetHttp } = await import('./api-handlers')
      const plane = createTestPlane(tmp())
      const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
        action: 'duo-poll',
      })
      expect(result.status).toBe(200)
      expect(result.body.ingested).toBe(1)
      expect(seen[0]).toContain('api.amplemarket.com/duo_leads')
    } finally {
      globalThis.fetch = originalFetch
      if (previous === undefined) delete process.env.AMPLEMARKET_API_KEY
      else process.env.AMPLEMARKET_API_KEY = previous
    }
  })
})
