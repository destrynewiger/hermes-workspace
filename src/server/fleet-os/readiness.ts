/**
 * Fleet readiness report against the Autonomous GTM OS definition of done.
 * A green report does not invent Tailscale hosts or Attio keys — it states
 * what is proven vs what still blocks production SoT / live heartbeats.
 */

import { resolveAttioApiKey } from './attio-http'
import { loadAttioLiveSnapshot } from './attio-cache'
import { loadMcpSotSnapshot } from './mcp-sot-cache'
import { createLiveAttioAdapter } from './attio-live'
import { attioProofIsFresh, loadAttioLiveProof } from './attio-remote'
import { summarizeMeshInventory } from './fleet-mesh'
import type { FleetControlPlane } from './control-plane'
import { DEFAULT_HEARTBEAT_TTL_MS } from './heartbeat'
import { defaultLedgerPath } from './agentic-ledger'
import { existsSync } from 'node:fs'

export type ReadinessCheck = {
  id: string
  ok: boolean
  detail: string
}

export type FleetReadiness = {
  at: number
  readyForProductionDoD: boolean
  attioMode: string
  checks: ReadinessCheck[]
  blockers: string[]
  picture: string
}

const REQUIRED_MACHINES = ['oakland-mini', 'sf-mini', 'backup-mini'] as const

export function assessFleetReadiness(
  plane: FleetControlPlane,
  options?: { at?: number; ttlMs?: number },
): FleetReadiness {
  const at = options?.at ?? Date.now()
  const ttlMs = options?.ttlMs ?? DEFAULT_HEARTBEAT_TTL_MS
  const health = plane.fleetHealth(at, ttlMs)
  const attioKey = resolveAttioApiKey()
  const snapshot = loadAttioLiveSnapshot()
  const mcpSot = loadMcpSotSnapshot()
  const composioProof = loadAttioLiveProof()
  const composioFresh = attioProofIsFresh(composioProof, undefined, at)
  const { mode: attioMode } = createLiveAttioAdapter()
  const ledgerPath = process.env.FLEET_LEDGER_PATH ?? defaultLedgerPath()
  const ageMs = snapshot ? at - Date.parse(snapshot.fetchedAt) : Number.POSITIVE_INFINITY
  const snapshotFresh = Boolean(snapshot && Number.isFinite(ageMs) && ageMs < 7 * 24 * 60 * 60 * 1000)
  const attioSotWired = Boolean(attioKey) || composioFresh


  const liveHeartbeats = REQUIRED_MACHINES.every((id) => health.onlineMachines.includes(id))
  // Seeded advertisements count as online in this process, but production DoD
  // requires heartbeats fresher than TTL from real hosts (not just seedDefaults).
  const snap = plane.snapshot()
  const freshHostBeats = REQUIRED_MACHINES.filter((id) => {
    const machine = snap.machines.find((item) => item.id === id)
    return Boolean(machine?.online && at - machine.lastHeartbeatAt <= ttlMs)
  })
  // Distinguish "seeded forever online" from advertise/heartbeat within TTL.
  const recentAdvertiseEvents = snap.events.filter((event) =>
    (event.type === 'worker.heartbeat' || event.type === 'machine.heartbeat' || event.type === 'machine.advertised')
    && at - event.at <= ttlMs,
  ).length

  const checks: ReadinessCheck[] = [
    {
      id: 'attio-http-key',
      ok: Boolean(attioKey),
      detail: attioKey
        ? 'ATTIO_API_KEY resolved for HTTP Attio adapter.'
        : 'ATTIO_API_KEY missing on this host — Mac Mini workers still need the key for offline HTTP.',
    },
    {
      id: 'attio-live-verified',
      ok: attioSotWired,
      detail: attioKey
        ? 'Attio SoT wired via HTTP API key.'
        : composioFresh
          ? `Attio SoT verified live via ${composioProof?.source} at ${composioProof?.verifiedAt} (${composioProof?.people.length} people / ${composioProof?.companies.length} companies).`
          : 'No fresh Attio live proof (Composio/MCP) and no ATTIO_API_KEY.',
    },
    {
      id: 'attio-live-snapshot',
      ok: snapshotFresh && (snapshot?.people.length ?? 0) >= 1 && (snapshot?.companies.length ?? 0) >= 1,
      detail: snapshot
        ? `Snapshot ${snapshot.source} with ${snapshot.people.length} people / ${snapshot.companies.length} companies (age ${Math.round(ageMs / 3600000)}h).`
        : 'No Attio live snapshot on disk.',
    },
    {
      id: 'attio-mode',
      ok: attioMode === 'http' || attioMode === 'live-seeded',
      detail: `Attio adapter mode: ${attioMode}.`,
    },
    {
      id: 'gmail-calendar-sot-cache',
      ok: Boolean(mcpSot && mcpSot.gmailSent.length + mcpSot.calendarEvents.length > 0),
      detail: mcpSot
        ? `MCP SoT cache: ${mcpSot.gmailSent.length} Sent proofs, ${mcpSot.calendarEvents.length} calendar proofs.`
        : 'No Gmail/Calendar MCP SoT cache yet.',
    },
    {
      id: 'ledger-path',
      ok: Boolean(ledgerPath),
      detail: existsSync(ledgerPath)
        ? `Ledger exists at ${ledgerPath}.`
        : `Ledger path ${ledgerPath} not present yet (will create on sync).`,
    },
    {
      id: 'required-machines-online',
      ok: liveHeartbeats,
      detail: liveHeartbeats
        ? `Required machines online: ${REQUIRED_MACHINES.join(', ')}.`
        : `Missing online machines: ${REQUIRED_MACHINES.filter((id) => !health.onlineMachines.includes(id)).join(', ') || 'none'}.`,
    },
    {
      id: 'fresh-host-heartbeats',
      ok: freshHostBeats.length === REQUIRED_MACHINES.length && recentAdvertiseEvents > 0,
      detail: recentAdvertiseEvents > 0
        ? `${freshHostBeats.length}/${REQUIRED_MACHINES.length} required hosts heartbeating within TTL; ${recentAdvertiseEvents} recent advertise/heartbeat events.`
        : `No advertise/heartbeat events within TTL. Seeded roster alone does not prove Tailscale hosts.`,
    },
    {
      id: 'tailscale-mesh',
      ok: process.env.FLEET_TAILSCALE_MESH === '1',
      detail: process.env.FLEET_TAILSCALE_MESH === '1'
        ? 'FLEET_TAILSCALE_MESH=1 — host bootstrap verified Tailscale connectivity.'
        : 'FLEET_TAILSCALE_MESH not set. Process-local advertise does not count as Tailscale heartbeats.',
    },
    {
      id: 'identity-registry',
      ok: snap.identities.some((item) => item.id === 'katherine-byteport')
        && snap.identities.some((item) => item.id === 'alex-gmail'),
      detail: `${snap.identities.length} identities registered (Katherine LinkedIn + Alex Gmail/Calendar expected).`,
    },
    {
      id: 'mesh-inventory',
      ok: summarizeMeshInventory().withKnownIp >= 2,
      detail: (() => {
        const mesh = summarizeMeshInventory()
        return `Mesh inventory: ${mesh.required} required hosts, ${mesh.withKnownIp} with known Tailscale IPs`
          + (mesh.missingIp.length ? ` (missing IP: ${mesh.missingIp.join(', ')})` : '')
          + '. Run pnpm fleet-mesh-probe on Oakland to prove reachability.'
      })(),
    },
  ]

  const blockers = checks
    .filter((check) => {
      if (check.ok) return false
      // HTTP key is optional when a fresh Composio/MCP proof already wires SoT.
      if (check.id === 'attio-http-key' && attioSotWired) return false
      return true
    })
    .map((check) => `${check.id}: ${check.detail}`)
  // Production DoD: live Attio SoT (HTTP key or fresh Composio/MCP proof) + Tailscale mesh + fresh host heartbeats.
  const readyForProductionDoD = attioSotWired
    && process.env.FLEET_TAILSCALE_MESH === '1'
    && freshHostBeats.length === REQUIRED_MACHINES.length
    && recentAdvertiseEvents > 0
    && snapshotFresh

  return {
    at,
    readyForProductionDoD,
    attioMode,
    checks,
    blockers,
    picture: readyForProductionDoD
      ? 'Fleet OS production DoD met: Attio HTTP + live host heartbeats proven.'
      : `Fleet OS not production-ready. ${blockers.length} blocker(s): ${blockers.map((item) => item.split(':')[0]).join(', ')}.`,
  }
}
