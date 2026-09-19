#!/usr/bin/env node
/**
 * Probe Tailscale fleet hosts for SSH + Fleet OS HTTP readiness.
 *
 * Run on a machine that is ON the tailnet (Oakland Mini):
 *   pnpm fleet-mesh-probe
 *   pnpm fleet-mesh-probe --once --json
 *
 * From a cloud VM without Tailscale this will correctly report unreachable.
 * When `tailscale status --json` is available, missing peer IPs (e.g. backup-mini)
 * are enriched before probing.
 */
import { execFileSync } from 'node:child_process'
import {
  FLEET_MESH_HOSTS,
  enrichMeshFromTailscaleStatus,
  meshProbeTargets,
  requiredMeshHosts,
  type FleetMeshHost,
  type MeshProbeResult,
} from './fleet-mesh'

function readTailscaleStatus(): Parameters<typeof enrichMeshFromTailscaleStatus>[0] | null {
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], {
      encoding: 'utf8',
      timeout: 8_000,
    })
    return JSON.parse(raw)
  } catch {
    return null
  }
}

async function probeTcp(host: string, port: number, timeoutMs = 2500): Promise<boolean> {
  const { default: net } = await import('node:net')
  return new Promise((resolve) => {
    const socket = net.connect({ host, port }, () => {
      socket.destroy()
      resolve(true)
    })
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(false))
  })
}

async function probeFleetHttp(host: string, port: number): Promise<{ ok: boolean; detail: string }> {
  const url = `http://${host}:${port}/api/fleet-os`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'readiness' }),
      signal: controller.signal,
    })
    const text = await res.text()
    return { ok: res.ok, detail: text.slice(0, 200) }
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timer)
  }
}

async function probeHost(host: FleetMeshHost): Promise<MeshProbeResult[]> {
  const targets = meshProbeTargets(host)
  if (!targets.length) {
    return [{
      machineId: host.machineId,
      host: host.tailscaleHostname || host.machineId,
      tcp22: 'unknown',
      fleetHttp: 'skipped',
      detail: 'No Tailscale IP/hostname recorded yet — update fleet-mesh.ts on first bootstrap.',
    }]
  }
  const results: MeshProbeResult[] = []
  for (const target of targets) {
    const tcp22 = await probeTcp(target, 22) ? 'open' : 'closed'
    const http = await probeFleetHttp(target, host.expectedFleetPort)
    results.push({
      machineId: host.machineId,
      host: target,
      tcp22,
      fleetHttp: http.ok ? 'ok' : (http.detail.includes('abort') || http.detail.includes('timeout') ? 'unreachable' : 'error'),
      detail: http.detail,
    })
  }
  return results
}

async function main() {
  const json = process.argv.includes('--json')
  const requiredOnly = !process.argv.includes('--all')
  const status = readTailscaleStatus()
  const enrichment = status
    ? enrichMeshFromTailscaleStatus(status, FLEET_MESH_HOSTS)
    : { hosts: FLEET_MESH_HOSTS, discovered: [], selfIsOakland: false }
  const hosts = requiredOnly
    ? enrichment.hosts.filter((host) => requiredMeshHosts(enrichment.hosts).some((r) => r.machineId === host.machineId))
    : enrichment.hosts
  const all: MeshProbeResult[] = []
  for (const host of hosts) {
    all.push(...await probeHost(host))
  }
  const required = requiredMeshHosts(enrichment.hosts)
  const missingRequiredIp = required.filter((host) => !host.tailscaleIp).map((host) => host.machineId)
  const reachableIds = new Set(
    all.filter((item) => item.fleetHttp === 'ok' || item.tcp22 === 'open').map((item) => item.machineId),
  )
  const liveFromThisHost = missingRequiredIp.length === 0
    && required.every((host) => reachableIds.has(host.machineId))
  const summary = {
    at: new Date().toISOString(),
    selfIsOakland: enrichment.selfIsOakland,
    liveFromThisHost,
    discovered: enrichment.discovered,
    missingRequiredIp,
    onTailnetHint: 'If every host is unreachable, this process is not on Tailscale. Run from Oakland Mini after `tailscale up`.',
    reachableFleetHttp: all.filter((item) => item.fleetHttp === 'ok').map((item) => item.machineId),
    results: all,
  }
  if (json) {
    console.log(JSON.stringify(summary, null, 2))
  } else {
    console.log(`Fleet mesh probe @ ${summary.at}`)
    for (const row of all) {
      console.log(`- ${row.machineId} ${row.host}: ssh=${row.tcp22} fleet=${row.fleetHttp} (${row.detail.slice(0, 80)})`)
    }
    if (enrichment.discovered.length) {
      console.log(`Discovered IPs: ${enrichment.discovered.map((d) => `${d.machineId}=${d.tailscaleIp}`).join(', ')}`)
    }
    console.log(summary.onTailnetHint)
  }
  process.exit(liveFromThisHost ? 0 : 2)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
