import type { IdentityRecord, JobRecord, MachineRecord, WorkerRecord } from './types'

export type DispatchChoice = {
  worker: WorkerRecord
  machine: MachineRecord
  identity: IdentityRecord | null
  reasons: string[]
}

export function selectWorker(input: {
  job: JobRecord
  workers: WorkerRecord[]
  machines: MachineRecord[]
  identities: IdentityRecord[]
  now?: number
}): DispatchChoice | { unavailable: string; considered: string[] } {
  const now = input.now ?? Date.now()
  const considered: string[] = []
  const heartbeatLimit = 90_000

  const eligibleWorkers = input.workers.filter((worker) => {
    const machine = input.machines.find((item) => item.id === worker.machineId)
    const reasons: string[] = []
    if (!worker.online) reasons.push('worker offline')
    if (!machine?.online) reasons.push('machine offline')
    if (now - worker.lastHeartbeatAt > heartbeatLimit) reasons.push('stale heartbeat')
    if (!input.job.requiredCapabilities.every((cap) => worker.capabilities.includes(cap))) {
      reasons.push('missing capability')
    }
    if (input.job.requiredIdentityId) {
      const identity = input.identities.find((item) => item.id === input.job.requiredIdentityId)
      if (!identity) reasons.push('unknown identity')
      else {
        const onWorker = worker.identities.includes(identity.id)
        const onMachine = Boolean(identity.machineId && identity.machineId === worker.machineId)
        const onHost = identity.sessionHost === worker.id
        if (!onWorker && !onMachine && !onHost) {
          reasons.push(`identity ${identity.id} is not on this worker`)
        }
      }
    }
    considered.push(`${worker.id}: ${reasons.length ? reasons.join(', ') : 'eligible'}`)
    return reasons.length === 0
  })

  if (!eligibleWorkers.length) {
    return { unavailable: 'No eligible worker for capability, identity, and availability constraints.', considered }
  }

  const ranked = [...eligibleWorkers].sort((a, b) => {
    if (a.load !== b.load) return a.load - b.load
    const aFail = input.machines.find((m) => m.id === a.machineId)?.recentFailures ?? 0
    const bFail = input.machines.find((m) => m.id === b.machineId)?.recentFailures ?? 0
    return aFail - bFail
  })

  const worker = ranked[0]
  const machine = input.machines.find((item) => item.id === worker.machineId)!
  const identity = input.job.requiredIdentityId
    ? input.identities.find((item) => item.id === input.job.requiredIdentityId) ?? null
    : null
  return {
    worker,
    machine,
    identity,
    reasons: [`Selected ${worker.id} on ${machine.id} with load ${worker.load}.`],
  }
}
