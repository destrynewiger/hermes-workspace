#!/usr/bin/env node
/**
 * Executive command CLI — any interface can shell out to the same control plane.
 * Example: pnpm fleet-cmd --interface hermes "Where are we on Toronto?"
 */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { FleetControlPlane } from './control-plane'
import { FleetStore, fleetOsHome } from './store'
import { executeExecutiveCommand } from './executive'

async function main() {
  const ifaceIdx = process.argv.indexOf('--interface')
  const sourceInterface = ifaceIdx >= 0 ? process.argv[ifaceIdx + 1] : 'api'
  const text = process.argv.filter((arg, index) => {
    if (arg === '--interface') return false
    if (ifaceIdx >= 0 && index === ifaceIdx + 1) return false
    if (arg === '--seed') return false
    return !arg.endsWith('fleet-cmd.ts') && !arg.includes('tsx') && arg !== '--'
  }).slice(-1)[0]

  if (!text) {
    console.error('Usage: fleet-cmd [--interface hermes] "Get 20 qualified infrastructure leaders to the Toronto dinner."')
    process.exit(2)
  }

  const home = process.env.FLEET_OS_HOME ?? fleetOsHome()
  mkdirSync(home, { recursive: true })
  const plane = new FleetControlPlane(new FleetStore(path.join(home, 'state.json')))
  if (process.argv.includes('--seed') || !plane.snapshot().machines.length) plane.seedDefaults()
  const result = executeExecutiveCommand(plane, text, sourceInterface)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
