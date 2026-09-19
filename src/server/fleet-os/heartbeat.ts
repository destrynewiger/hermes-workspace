import type { MachineRecord, WorkerRecord } from './types'

export type MachineAdvertisement = {
  machineId: string
  name: string
  capabilities: string[]
  identities: string[]
  models: string[]
  agents: string[]
  load?: number
  recentFailures?: number
  workers?: Array<{
    id: string
    kind: string
    capabilities: string[]
    identities: string[]
    models: string[]
    permissions?: string[]
    load?: number
  }>
  at?: number
}

export function advertisementToRecords(ad: MachineAdvertisement, at = Date.now()): {
  machine: MachineRecord
  workers: WorkerRecord[]
} {
  const machine: MachineRecord = {
    id: ad.machineId,
    name: ad.name,
    online: true,
    lastHeartbeatAt: ad.at ?? at,
    capabilities: ad.capabilities,
    identities: ad.identities,
    models: ad.models,
    agents: ad.agents,
    load: ad.load ?? 0,
    recentFailures: ad.recentFailures ?? 0,
  }
  const workers: WorkerRecord[] = (ad.workers ?? ad.agents.map((agent) => ({
    id: `${agent}-${ad.machineId}`,
    kind: agent,
    capabilities: ad.capabilities,
    identities: ad.identities,
    models: ad.models,
    permissions: ['internal'],
    load: 0,
  }))).map((worker) => ({
    id: worker.id,
    kind: worker.kind,
    machineId: ad.machineId,
    online: true,
    lastHeartbeatAt: ad.at ?? at,
    capabilities: worker.capabilities,
    identities: worker.identities,
    models: worker.models,
    load: worker.load ?? 0,
    permissions: worker.permissions ?? ['internal'],
  }))
  return { machine, workers }
}

export const FLEET_MACHINE_SEEDS: MachineAdvertisement[] = [
  {
    machineId: 'oakland-mini',
    name: 'Oakland Mac Mini',
    capabilities: ['research', 'attio', 'local-inference', 'coordination', 'meeting.brief', 'calendar', 'calendar.create', 'email.send'],
    identities: ['alex-byteport', 'alex-gmail', 'alex-calendar', 'john-gradient'],
    models: ['ollama-local'],
    agents: ['hermes', 'codex', 'muse'],
    workers: [
      { id: 'hermes-oakland', kind: 'hermes', capabilities: ['research', 'attio', 'browser', 'linkedin.draft', 'meeting.brief', 'calendar', 'calendar.create', 'email.draft', 'email.send'], identities: ['alex-byteport', 'alex-gmail', 'alex-calendar'], models: ['ollama-local'] },
      { id: 'hermes-oakland-john', kind: 'hermes', capabilities: ['linkedin.draft'], identities: ['john-gradient'], models: ['ollama-local'] },
      { id: 'muse', kind: 'muse', capabilities: ['research', 'campaign.define'], identities: [], models: ['claude-frontier'] },
      { id: 'codex', kind: 'codex', capabilities: ['coding'], identities: [], models: ['codex'] },
    ],
  },
  {
    machineId: 'sf-mini',
    name: 'Alex SF Mac Mini',
    capabilities: ['research', 'linkedin.draft', 'linkedin.send', 'browser'],
    identities: ['alex-byteport', 'katherine-byteport'],
    models: [],
    agents: ['hermes'],
    workers: [
      { id: 'hermes-sf', kind: 'hermes', capabilities: ['linkedin.draft', 'linkedin.send', 'browser', 'research'], identities: ['katherine-byteport', 'alex-byteport'], models: [] },
    ],
  },
  {
    machineId: 'backup-mini',
    name: 'Backup Byteport Mac Mini',
    capabilities: ['research', 'attio', 'transcript.process'],
    identities: ['alex-byteport', 'katherine-byteport', 'jayram-byteport', 'will-byteport', 'laksh-byteport', 'maggie-byteport'],
    models: ['openrouter-free'],
    agents: ['grokbot', 'hermes'],
    workers: [
      { id: 'grokbot-backup', kind: 'grokbot', capabilities: ['research', 'attio', 'transcript.process'], identities: ['jayram-byteport', 'will-byteport', 'laksh-byteport', 'maggie-byteport'], models: ['openrouter-free'] },
      { id: 'hermes-backup', kind: 'hermes', capabilities: ['linkedin.draft', 'linkedin.send', 'browser'], identities: ['katherine-byteport'], models: ['openrouter-free'] },
    ],
  },
  {
    machineId: 'destrys-hp',
    name: 'DestrysHP',
    capabilities: ['research', 'coding'],
    identities: [],
    models: [],
    agents: ['claude-code'],
    workers: [
      { id: 'claude-destrys', kind: 'claude-code', capabilities: ['research', 'coding'], identities: [], models: [] },
    ],
  },
]

export const DEFAULT_HEARTBEAT_TTL_MS = 90_000

export type FleetHealthReport = {
  at: number
  ttlMs: number
  onlineMachines: string[]
  offlineMachines: string[]
  onlineWorkers: string[]
  offlineWorkers: string[]
  staleMarked: string[]
}

/** Mark machines/workers offline when heartbeats fall outside the TTL. */
export function markStaleFleet(
  machines: MachineRecord[],
  workers: WorkerRecord[],
  at = Date.now(),
  ttlMs = DEFAULT_HEARTBEAT_TTL_MS,
): { staleWorkerIds: string[]; staleMachineIds: string[] } {
  const staleWorkerIds: string[] = []
  const staleMachineIds: string[] = []
  for (const machine of machines) {
    if (machine.online && at - machine.lastHeartbeatAt > ttlMs) {
      machine.online = false
      staleMachineIds.push(machine.id)
    }
  }
  for (const worker of workers) {
    if (worker.online && at - worker.lastHeartbeatAt > ttlMs) {
      worker.online = false
      staleWorkerIds.push(worker.id)
    }
  }
  return { staleWorkerIds, staleMachineIds }
}

export function fleetHealthPicture(
  machines: MachineRecord[],
  workers: WorkerRecord[],
  at = Date.now(),
  ttlMs = DEFAULT_HEARTBEAT_TTL_MS,
): FleetHealthReport {
  return {
    at,
    ttlMs,
    onlineMachines: machines.filter((item) => item.online).map((item) => item.id),
    offlineMachines: machines.filter((item) => !item.online).map((item) => item.id),
    onlineWorkers: workers.filter((item) => item.online).map((item) => item.id),
    offlineWorkers: workers.filter((item) => !item.online).map((item) => item.id),
    staleMarked: [
      ...machines.filter((item) => !item.online).map((item) => item.id),
      ...workers.filter((item) => !item.online).map((item) => item.id),
    ],
  }
}
