/**
 * Multi-host shared-state simulation.
 * Proves Hermes on oakland-mini and GrokBot on backup-mini share one durable
 * FleetStore file — the same continuity contract Tailscale hosts will use.
 */

import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FleetControlPlane } from './control-plane'
import { FleetStore } from './store'
import { FLEET_MACHINE_SEEDS } from './heartbeat'
import { runContinuousWorker } from './worker-loop'
import { createLiveAttioAdapter } from './attio-live'
import { syncPlaneToLedger } from './ledger-sync'
import { executeExecutiveCommand } from './executive'

export async function runMultiHostContinuitySim(dir: string) {
  mkdirSync(dir, { recursive: true })
  const statePath = path.join(dir, 'shared-state.json')
  const ledgerPath = path.join(dir, 'shared-ledger.sqlite')

  // Host A: Oakland Hermes receives the objective.
  const oakland = new FleetControlPlane(new FleetStore(statePath))
  oakland.seedDefaults()
  for (const seed of FLEET_MACHINE_SEEDS) {
    oakland.applyMachineAdvertisement({ ...seed, at: Date.now() })
  }
  const hermes = executeExecutiveCommand(
    oakland,
    'Get 20 qualified infrastructure leaders to the Toronto dinner.',
    'hermes',
  )
  const { adapter } = createLiveAttioAdapter()
  await runContinuousWorker(oakland, 'hermes-oakland', {
    maxTicks: 8,
    attio: adapter,
  })
  oakland.markOffline('hermes-oakland')
  const syncA = syncPlaneToLedger(oakland, { filename: ledgerPath })

  // Host B: Backup GrokBot opens the same state file and continues.
  const backup = new FleetControlPlane(new FleetStore(statePath))
  backup.heartbeat({ workerId: 'grokbot-backup', machineId: 'backup-mini', at: Date.now() })
  backup.expireStaleHeartbeats(Date.now() + 1_000, 90_000)
  const status = executeExecutiveCommand(backup, 'Where are we on Toronto dinner?', 'grokbot')
  await runContinuousWorker(backup, 'grokbot-backup', {
    maxTicks: 8,
    attio: adapter,
    now: Date.now() + 5_000,
  })
  const syncB = syncPlaneToLedger(backup, { filename: ledgerPath })

  const snap = backup.snapshot()
  return {
    sharedStatePath: statePath,
    ledgerPath,
    hermesObjectiveId: hermes.objectiveId,
    grokSameObjective: status.objectiveId === hermes.objectiveId,
    toronto: backup.status('Toronto'),
    campaign: backup.campaignStatus('Toronto'),
    oaklandOffline: snap.workers.find((item) => item.id === 'hermes-oakland')?.online === false,
    grokOnline: snap.workers.find((item) => item.id === 'grokbot-backup')?.online === true,
    entities: snap.entities.length,
    ledger: {
      afterOakland: syncA,
      afterBackup: syncB,
      grewOrStable: (syncB?.latestSequence ?? 0) >= (syncA?.latestSequence ?? 0),
    },
    jobsCompleted: snap.jobs.filter((job) => job.state === 'completed').length,
  }
}
