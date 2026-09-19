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

describe('continuous worker (unlazy-native)', () => {
  it('drains authorized work without waiting for another prompt', async () => {
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const fleet = await runFleetUntilIdle(plane, { maxRounds: 6 })
    const jobs = plane.snapshot().jobs
    expect(jobs.filter((job) => job.state === 'completed').length).toBeGreaterThanOrEqual(4)
    expect(jobs.some((job) => job.state === 'queued' && job.kind === 'attio.reconcile')).toBe(false)
    expect(fleet.picture).toMatch(/workers online/)
  })

  it('a single worker keeps claiming until idle', async () => {
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Research accounts',
      intent: 'research high-priority accounts for enrichment',
      sourceInterface: 'codex',
    })
    const result = await runContinuousWorker(plane, 'hermes-oakland', { maxTicks: 5 })
    expect(result.completed.length).toBeGreaterThan(0)
    expect(result.idle).toBe(true)
  })

  it('seeds bounded background work only when urgent queues are empty', async () => {
    const { enqueueBackgroundWork } = await import('./background')
    const plane = createTestPlane(tmp())
    const first = enqueueBackgroundWork(plane, { kinds: ['enrich.incomplete', 'research.priority_accounts'] })
    expect(first.enqueued.length).toBe(2)
    const again = enqueueBackgroundWork(plane, { kinds: ['enrich.incomplete'] })
    expect(again.skipped).toContain('enrich.incomplete')
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
      priority: 'P1',
    })
    const blocked = enqueueBackgroundWork(plane)
    expect(blocked.skipped).toContain('urgent_work_present')
  })
})

describe('attio reconcile', () => {
  it('dedupes against existing Attio people and records entity keys', async () => {
    const adapter = new MemoryAttioAdapter({
      people: [{ attioId: 'attio_person_existing', name: 'Alex Chen', email: 'achen@acme.example' }],
    })
    const result = await reconcileTargets(adapter, [
      { key: 'person:1', name: 'Alex Chen', email: 'achen@acme.example' },
      { key: 'person:2', name: 'Sam Rivera', email: 'sam@new.example' },
    ], [], { createMissing: true })
    expect(result.existing).toBe(1)
    expect(result.newTargets).toBe(1)
    expect(result.verified).toBe(true)
    expect(result.attioIds).toHaveLength(2)
  })

  it('does not invent synthetic Attio ids when writes are gated', async () => {
    const adapter = new MemoryAttioAdapter({
      people: [{ attioId: 'attio_person_existing', name: 'Alex Chen', email: 'achen@acme.example' }],
    })
    const result = await reconcileTargets(adapter, [
      { key: 'person:1', name: 'Alex Chen', email: 'achen@acme.example' },
      { key: 'person:2', name: 'Sam Rivera', email: 'sam@new.example' },
    ])
    expect(result.existing).toBe(1)
    expect(result.newTargets).toBe(0)
    expect(result.unmatched).toHaveLength(1)
    expect(result.verified).toBe(false)
  })
})

describe('verification', () => {
  it('refuses to treat an Attio update as complete without attioIds', () => {
    const result = verifyJobResult({ kind: 'attio.reconcile', result: { ok: true }, evidence: [] })
    expect(result.ok).toBe(false)
    expect(result.state).toBe('unverified')
  })

  it('verifies LinkedIn sends only with an external reference', () => {
    const missing = verifyJobResult({ kind: 'linkedin.send', result: {}, evidence: [] })
    expect(missing.ok).toBe(false)
    const ok = verifyJobResult(
      { kind: 'linkedin.send', result: { externalRef: 'li-1' }, evidence: [] },
      { sentLookup: (ref) => ref === 'li-1' },
    )
    expect(ok.ok).toBe(true)
  })
})

describe('model router', () => {
  const models: ModelRecord[] = [
    { id: 'ollama-local', provider: 'ollama', tier: 'local_free', available: true, costPerUnit: 0, latencyMs: 800, successRate: 0.9, capabilities: ['general'] },
    { id: 'cheap', provider: 'openrouter', tier: 'inexpensive_cloud', available: true, costPerUnit: 0.02, latencyMs: 900, successRate: 0.92, capabilities: ['general'] },
    { id: 'claude', provider: 'anthropic', tier: 'frontier', available: true, costPerUnit: 1, latencyMs: 1400, successRate: 0.98, capabilities: ['write', 'general'] },
  ]

  it('uses code instead of an LLM for deterministic work', () => {
    expect(routeModel({ kind: 'attio.lookup', complexity: 'frontier' }, models).mode).toBe('code')
  })

  it('prefers free local models for classification', () => {
    expect(routeModel({ kind: 'classify', complexity: 'local_free' }, models).model?.id).toBe('ollama-local')
  })

  it('fails over after a 429 without stopping the workflow', () => {
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const job = plane.claimNext('hermes-oakland')
    expect(job).toBeTruthy()
    const failed = plane.failJob({
      jobId: job!.id,
      workerId: 'hermes-oakland',
      error: '429 rate limit',
      modelId: job!.assignedModelId ?? 'ollama-local',
    })
    expect(failed?.state).toBe('queued')
    expect(failed?.preferredModelId).not.toBe(job!.assignedModelId)
    const next = fallbackAfterFailure({ kind: 'research', complexity: 'local_free' }, models, 'ollama-local')
    expect(next.model?.id).toBe('cheap')
  })
})

describe('autonomy', () => {
  it('does not silently send LinkedIn messages on a draft-only identity', () => {
    const decision = decideAutonomy('linkedin.send', {
      id: 'katherine-byteport',
      teammate: 'katherine',
      principal: 'byteport',
      channel: 'linkedin',
      machineId: 'sf-mini',
      sessionHost: 'hermes',
      sessionStatus: 'alive',
      autonomyLevel: 2,
      sendMode: 'draft_only',
    })
    expect(decision.execute).toBe(false)
    expect(decision.allow).toBe(true)
  })

  it('blocks live LinkedIn sends until the identity lane is approved', () => {
    const plane = createTestPlane(tmp())
    const { objective } = plane.submitObjective({
      title: 'Hold Katherine send',
      intent: 'Send a LinkedIn message as Katherine',
      sourceInterface: 'hermes',
    })
    const workflowId = plane.snapshot().workflows.find((item) => item.objectiveId === objective.id)!.id
    plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: 'linkedin.send',
      title: 'Send',
      priority: 'P1',
      requiredCapabilities: ['linkedin.send'],
      requiredIdentityId: 'katherine-byteport',
      idempotencyKey: 'hold-send-1',
      entityKey: 'linkedin.com/in/x',
    })
    let guard = 0
    while (guard++ < 5) {
      const job = plane.claimNext('hermes-sf')
      if (!job) break
      if (job.kind === 'linkedin.send') throw new Error('send should not be claimed')
      plane.completeJob({ jobId: job.id, workerId: 'hermes-sf', result: { ok: true }, verified: true })
    }
    expect(plane.snapshot().jobs.find((job) => job.kind === 'linkedin.send')?.state).toBe('blocked')
    expect(plane.snapshot().approvals.some((item) => item.status === 'pending')).toBe(true)
  })
})

describe('meeting lifecycle', () => {
  it('briefs before the meeting and tracks commitments after Granola', async () => {
    const { runMeetingLifecycleLoop } = await import('./gtm-loop')
    const plane = createTestPlane(tmp())
    const result = await runMeetingLifecycleLoop(plane)
    expect(result.jobs.some((job) => job.kind === 'meeting.brief' && job.state === 'completed')).toBe(true)
    expect(result.jobs.some((job) => job.kind === 'transcript.process' && job.state === 'completed')).toBe(true)
    expect(result.commitments.length).toBeGreaterThan(0)
    expect(result.jobs.some((job) => job.kind === 'email.draft')).toBe(true)
  })
})

describe('campaign + LinkedIn ledger', () => {
  it('tracks Toronto RSVP progress as a campaign decision surface', () => {
    const plane = createTestPlane(tmp())
    const { objective } = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    expect(plane.snapshot().campaigns[0]?.targetCount).toBe(20)
    plane.ingestEvent('luma.rsvp', 'luma', {
      campaignId: plane.snapshot().campaigns[0].id,
      rsvps: 8,
      objectiveId: objective.id,
    })
    expect(plane.campaignStatus('Toronto')).toMatch(/8\/20 RSVPs/)
    expect(plane.campaignStatus('Toronto')).toMatch(/Decision:/)
  })

  it('counts contacted as outreach touches, not research volume', async () => {
    const { bumpFromJob } = await import('./campaign')
    const campaign = {
      id: 'camp_1',
      objectiveId: 'obj_1',
      title: 'Toronto dinner',
      targetCount: 20,
      contacted: 0,
      accepted: 0,
      rsvps: 0,
      attended: 0,
      geography: 'toronto',
      state: 'active' as const,
      gaps: [] as string[],
      updatedAt: Date.now(),
    }
    bumpFromJob(campaign, { id: 'job_1', kind: 'account.research', result: { qualified: 50 } } as never)
    expect(campaign.contacted).toBe(0)
    bumpFromJob(campaign, { id: 'job_2', kind: 'linkedin.draft', result: { drafts: 9 } } as never)
    expect(campaign.contacted).toBe(1)
  })

  it('verifies LinkedIn sends against the outreach harness ledger', async () => {
    const { runLinkedInVerifyLoop } = await import('./gtm-loop')
    const plane = createTestPlane(tmp())
    const result = await runLinkedInVerifyLoop(plane)
    expect(result.send?.state).toBe('completed')
    expect(result.ledger.some((event) => event.result === 'sent')).toBe(true)
  })
})

describe('machine heartbeat protocol', () => {
  it('registers a machine advertisement and makes its workers claimable', () => {
    const plane = createTestPlane(tmp())
    plane.applyMachineAdvertisement({
      machineId: 'destrys-hp',
      name: 'DestrysHP',
      capabilities: ['research', 'coding'],
      identities: [],
      models: [],
      agents: ['claude-code'],
      workers: [{ id: 'claude-destrys', kind: 'claude-code', capabilities: ['research', 'coding'], identities: [], models: [] }],
    })
    expect(plane.snapshot().machines.find((item) => item.id === 'destrys-hp')?.online).toBe(true)
    expect(plane.snapshot().workers.some((item) => item.id === 'claude-destrys' && item.online)).toBe(true)
  })

  it('marks silent machines offline and releases their leases', () => {
    const plane = createTestPlane(tmp())
    const started = Date.now()
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    plane.heartbeat({ workerId: 'hermes-oakland', at: started })
    const job = plane.claimNext('hermes-oakland', started)
    expect(job).toBeTruthy()
    const expired = plane.expireStaleHeartbeats(started + 120_000, 90_000)
    expect(expired.staleWorkerIds).toContain('hermes-oakland')
    expect(plane.snapshot().workers.find((item) => item.id === 'hermes-oakland')?.online).toBe(false)
    expect(plane.fleetHealth(started + 120_000).offlineWorkers).toContain('hermes-oakland')
    const released = plane.snapshot().jobs.find((item) => item.id === job!.id)
    expect(released?.state === 'queued' || expired.releasedJobs.some((item) => item.id === job!.id)).toBe(true)
  })

  it('advertises all seeded Tailscale hosts including DestrysHP', async () => {
    const { FLEET_MACHINE_SEEDS } = await import('./heartbeat')
    const plane = createTestPlane(tmp())
    for (const seed of FLEET_MACHINE_SEEDS) plane.applyMachineAdvertisement({ ...seed, at: Date.now() })
    const health = plane.fleetHealth()
    expect(health.onlineMachines).toEqual(expect.arrayContaining(['oakland-mini', 'sf-mini', 'backup-mini', 'destrys-hp']))
    expect(health.onlineWorkers).toContain('claude-destrys')
  })
})
