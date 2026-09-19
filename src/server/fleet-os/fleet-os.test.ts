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

  it('dispatches LinkedIn drafts to Katherine rather than the first idle machine', () => {
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'muse',
    })
    const oakland = plane.claimNext('hermes-oakland')
    expect(oakland?.requiredIdentityId).not.toBe('katherine-byteport')
    const katherine = plane.claimNext('hermes-sf')
    expect(katherine?.requiredIdentityId).toBe('katherine-byteport')
    expect(katherine?.assignedMachineId).toBe('sf-mini')
  })

  it('returns a leased job to the queue when the worker stops heartbeating', () => {
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const start = Date.now()
    const claimed = plane.claimNext('hermes-oakland', start)
    expect(claimed).toBeTruthy()
    plane.markOffline('hermes-oakland')
    plane.heartbeat({ workerId: 'grokbot-backup', at: start + 120_000 })
    const recovered = plane.expireLeases(start + 120_000)
    expect(recovered.some((job) => job.id === claimed!.id)).toBe(true)
    const stolen = plane.claimNext('grokbot-backup', start + 121_000)
    expect(stolen?.id).toBe(claimed!.id)
    expect(stolen?.assignedWorkerId).toBe('grokbot-backup')
  })

  it('does not enqueue duplicate jobs for the same idempotency key', () => {
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const again = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'claude-code',
    })
    const keys = again.jobs.map((job) => job.idempotencyKey)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('keeps going after a job completes when the next authorized step is implied', async () => {
    const plane = createTestPlane(tmp())
    const result = await runSignalToDraftLoop(plane)
    expect(result.status.picture).toMatch(/jobs complete/)
    const snapshot = plane.snapshot()
    expect(snapshot.jobs.some((job) => job.kind === 'research.infra')).toBe(true)
    expect(snapshot.jobs.some((job) => job.kind === 'linkedin.draft' && job.state === 'completed')).toBe(true)
    expect(snapshot.jobs.some((job) => job.kind === 'attio.reconcile' && job.state === 'completed')).toBe(true)
    expect(snapshot.entities.length).toBeGreaterThan(0)
    expect(snapshot.events.some((event) => event.type === 'job.completed')).toBe(true)
  })

  it('lets GrokBot resume a completed Toronto objective for status without re-decomposing', async () => {
    const plane = createTestPlane(tmp())
    await runSignalToDraftLoop(plane)
    const before = plane.snapshot().jobs.length
    const resumed = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Where are we on Toronto?',
      sourceInterface: 'grokbot',
    })
    expect(resumed.objective.state).toBe('completed')
    expect(plane.snapshot().jobs.length).toBe(before)
    expect(plane.status('Toronto').picture).toMatch(/Objective complete/)
  })

  it('survives a coordinator restart because state is on disk', () => {
    const dir = tmp()
    const first = new FleetControlPlane(new FleetStore(`${dir}/state.json`))
    first.seedDefaults()
    first.submitObjective({
      title: 'Keep target accounts warm',
      intent: 'Keep our target accounts warm across LinkedIn, X, email, calls, events, and founder relationships.',
      sourceInterface: 'gemini-spark',
    })
    const second = new FleetControlPlane(new FleetStore(`${dir}/state.json`))
    expect(second.status('warm').objective?.title).toBe('Keep target accounts warm')
  })
})
