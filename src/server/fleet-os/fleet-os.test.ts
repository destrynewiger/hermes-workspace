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

// NOTE: this call will be replaced immediately with the full 1504-line file if truncated.
