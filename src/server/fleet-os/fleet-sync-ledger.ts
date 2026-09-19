#!/usr/bin/env node
/**
 * Sync Fleet OS shared state into the agentic-os-compatible SQLite ledger.
 *
 *   pnpm fleet-sync-ledger
 *   FLEET_LEDGER_PATH=/path/to/ledger.sqlite pnpm fleet-sync-ledger
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FleetControlPlane } from './control-plane'
import { FleetStore, fleetOsHome } from './store'
import { buildAgenticOutbox } from './agentic-bridge'
import { appendOutboxToLedger, defaultLedgerPath } from './agentic-ledger'

async function main() {
  const home = process.env.FLEET_OS_HOME ?? fleetOsHome()
  mkdirSync(home, { recursive: true })
  const plane = new FleetControlPlane(new FleetStore(path.join(home, 'state.json')))
  if (process.argv.includes('--seed') || !plane.snapshot().machines.length) plane.seedDefaults()

  const snap = plane.snapshot()
  const outbox = buildAgenticOutbox({
    objectives: snap.objectives,
    events: snap.events,
    jobs: snap.jobs,
    attempts: snap.attempts,
  })
  const filename = process.argv.includes('--ledger')
    ? process.argv[process.argv.indexOf('--ledger') + 1]
    : defaultLedgerPath()
  const report = appendOutboxToLedger(outbox, { filename })
  console.log(JSON.stringify({
    outboxEntries: outbox.length,
    ...report,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
