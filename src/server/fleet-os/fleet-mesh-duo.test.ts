import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createTestPlane } from './gtm-loop'

const dirs: string[] = []

function tmp(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fleet-os-mesh-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('oakland mesh + duo signals', () => {
  it('exposes Tailscale mesh inventory with known Oakland/SF IPs', async () => {
    const { FLEET_MESH_HOSTS, summarizeMeshInventory, meshHostByMachineId } = await import('./fleet-mesh')
    expect(meshHostByMachineId('oakland-mini')?.tailscaleHostname).toBe('alex-mac-mini-1')
    expect(meshHostByMachineId('sf-mini')?.tailscaleIp).toBe('100.106.243.19')
    expect(summarizeMeshInventory().withKnownIp).toBeGreaterThanOrEqual(2)
    expect(FLEET_MESH_HOSTS.some((host) => host.machineId === 'backup-mini' && !host.tailscaleIp)).toBe(true)
    expect(meshHostByMachineId('backup-mini')?.lastKnownTailscaleIp).toBe('100.90.155.111')
    expect(meshHostByMachineId('backup-mini')?.identities).toEqual(expect.arrayContaining(['katherine-byteport']))
  })

  it('probes last-known backup IP without treating it as a live Tailscale IP', async () => {
    const { meshHostByMachineId, meshProbeTargets, summarizeMeshInventory } = await import('./fleet-mesh')
    const backup = meshHostByMachineId('backup-mini')!
    expect(backup.tailscaleIp).toBe('')
    expect(meshProbeTargets(backup)).toContain('100.90.155.111')
    expect(summarizeMeshInventory().missingIp).toContain('backup-mini')
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

  it('does not stamp FLEET_TAILSCALE_MESH from tailscale status alone', () => {
    const bootstrap = readFileSync(new URL('./scripts/bootstrap-fleet-host.sh', import.meta.url), 'utf8')
    const wizard = readFileSync(new URL('./scripts/fleet-host-wizard.sh', import.meta.url), 'utf8')
    expect(bootstrap).toContain('liveFromThisHost')
    expect(bootstrap.includes('tailscale status >/dev/null 2>&1; then')).toBe(false)
    expect(wizard).toContain('liveFromThisHost')
    expect(wizard).toContain('write_env FLEET_TAILSCALE_MESH 0')
  })

  it('starts the Cursor self-hosted worker during host bootstrap', () => {
    const bootstrap = readFileSync(new URL('./scripts/bootstrap-fleet-host.sh', import.meta.url), 'utf8')
    expect(bootstrap).toContain('cursor worker start')
    expect(bootstrap).toContain('command -v cursor')
  })
})
