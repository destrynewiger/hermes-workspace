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
    // Drain non-send work first; the send must remain blocked pending approval.
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
    bumpFromJob(campaign, {
      id: 'job_1',
      kind: 'account.research',
      result: { qualified: 50 },
    } as never)
    expect(campaign.contacted).toBe(0)
    bumpFromJob(campaign, {
      id: 'job_2',
      kind: 'linkedin.draft',
      result: { drafts: 9 },
    } as never)
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
      workers: [{
        id: 'claude-destrys',
        kind: 'claude-code',
        capabilities: ['research', 'coding'],
        identities: [],
        models: [],
      }],
    })
    const machine = plane.snapshot().machines.find((item) => item.id === 'destrys-hp')
    expect(machine?.online).toBe(true)
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
    for (const seed of FLEET_MACHINE_SEEDS) {
      plane.applyMachineAdvertisement({ ...seed, at: Date.now() })
    }
    const health = plane.fleetHealth()
    expect(health.onlineMachines).toEqual(expect.arrayContaining([
      'oakland-mini',
      'sf-mini',
      'backup-mini',
      'destrys-hp',
    ]))
    expect(health.onlineWorkers).toContain('claude-destrys')
    expect(health.onlineWorkers).toContain('hermes-backup')
    expect(health.onlineWorkers).toContain('hermes-oakland-john')
  })
})

describe('executive commands + signals + full loop', () => {
  it('parses Alex objectives and status questions into shared-state actions', async () => {
    const { executeExecutiveCommand } = await import('./executive')
    const plane = createTestPlane(tmp())
    const created = executeExecutiveCommand(
      plane,
      'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      'hermes',
    )
    expect(created.objectiveId).toBeTruthy()
    const status = executeExecutiveCommand(plane, 'Where are we on Toronto dinner?', 'grokbot')
    expect(status.objectiveId).toBe(created.objectiveId)
    expect(status.picture).toMatch(/Toronto/i)
  })

  it('normalizes a Sumble signal into actionable research work', () => {
    const plane = createTestPlane(tmp())
    plane.ingestEvent('signal.detected', 'sumble', {
      company: 'Acme',
      signal: 'multi-cloud warehouse migration',
      strength: 0.9,
    })
    const jobs = plane.snapshot().jobs
    expect(jobs.some((job) => job.kind === 'account.research')).toBe(true)
    expect(plane.snapshot().events.some((event) => event.payload.normalized)).toBe(true)
  })

  it('runs the full signal→meeting→follow-up loop with cross-agent continuity and failover', async () => {
    const { runFullGtmLoop } = await import('./gtm-loop')
    const plane = createTestPlane(tmp())
    const result = await runFullGtmLoop(plane, {
      liveCompanies: [{ recordId: '8fc484a3-8e27-4d9e-9223-ecfa3114a002', name: 'Byteport', domain: 'byteport.com' }],
    })
    expect(result.grokSameObjective).toBe(true)
    expect(result.commitments.length).toBeGreaterThan(0)
    expect(result.eventTypes).toEqual(expect.arrayContaining([
      'objective.created',
      'signal.detected',
      'calendar.external_meeting_soon',
      'granola.transcript_available',
    ]))
    expect(result.failover?.recovered).toBe(true)
    expect(result.attention).toMatch(/objective|approval|blocked|campaign|decision/i)
  })
})

describe('live Attio seed + Luma webhook + agentic-os bridge', () => {
  it('reconciles against the live Byteport Attio company id without inventing CRM ids', async () => {
    const { reconcileAgainstLiveAttio, BYTEPORT_LIVE_COMPANY, createLiveAttioAdapter } = await import('./attio-live')
    const { adapter, mode } = createLiveAttioAdapter({
      companies: [BYTEPORT_LIVE_COMPANY],
      people: [{ recordId: 'person-live-1', name: 'Alex Newiger', email: 'alex@byteport.com' }],
    })
    expect(mode).toMatch(/live-seeded|http/)
    const company = await adapter.findCompany({ domain: 'byteport.com' })
    expect(company?.attioId).toBe(BYTEPORT_LIVE_COMPANY.recordId)
    const result = await reconcileAgainstLiveAttio([
      { key: 'person:alex', name: 'Alex Newiger', email: 'alex@byteport.com' },
      { key: 'person:new', name: 'New Prospect', email: 'new@example.com' },
    ], {
      companies: [BYTEPORT_LIVE_COMPANY],
      people: [{ recordId: 'person-live-1', name: 'Alex Newiger', email: 'alex@byteport.com' }],
    })
    expect(result.existing).toBe(1)
    expect(result.newTargets).toBe(0)
    expect(result.unmatched.map((item) => item.key)).toContain('person:new')
    expect(result.verified).toBe(false)
    expect(result.attioIds).toContain('person-live-1')
    expect(result.attioIds.every((id) => !id.startsWith('attio_person_'))).toBe(true)
  })

  it('normalizes a Luma guest-approved webhook and advances Toronto RSVPs by event name', async () => {
    const { normalizeLumaWebhook } = await import('./luma-webhook')
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const normalized = normalizeLumaWebhook({
      type: 'guest.approved',
      data: {
        event: { name: 'Byteport Toronto Dinner', api_id: 'evt_toronto_1' },
        guest: { email: 'vp@acme.example', name: 'Pat VP', status: 'approved' },
      },
    })
    expect(normalized).toBeTruthy()
    plane.ingestEvent(normalized!.type, normalized!.source, normalized!.payload)
    expect(plane.campaignStatus('Toronto')).toMatch(/1\/20 RSVPs/)
    expect(plane.snapshot().events.some((event) => event.type === 'luma.rsvp')).toBe(true)
  })

  it('exports Fleet OS state as agentic-os ledger-compatible outbox events', async () => {
    const { buildAgenticOutbox, ledgerEventsFromOutbox } = await import('./agentic-bridge')
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const job = plane.claimNext('hermes-oakland')
    if (job) {
      plane.completeJob({
        jobId: job.id,
        workerId: 'hermes-oakland',
        result: { ok: true },
        verified: true,
      })
    }
    const snap = plane.snapshot()
    const outbox = buildAgenticOutbox({
      objectives: snap.objectives,
      events: snap.events,
      jobs: snap.jobs,
      attempts: snap.attempts,
    })
    expect(outbox.some((entry) => entry.type === 'fleet.objective.upserted')).toBe(true)
    expect(outbox.some((entry) => entry.type.startsWith('fleet.job.'))).toBe(true)
    const ledger = ledgerEventsFromOutbox(outbox)
    expect(ledger.every((entry) => entry.eventId && entry.streamId && entry.type)).toBe(true)
    expect(new Set(ledger.map((entry) => entry.eventId)).size).toBe(ledger.length)
  })

  it('appends outbox events into an agentic-os-compatible SQLite ledger idempotently', async () => {
    const { buildAgenticOutbox } = await import('./agentic-bridge')
    const { verifyLedgerIdempotency } = await import('./agentic-ledger')
    const { BYTEPORT_LIVE_ALEX } = await import('./attio-live')
    const plane = createTestPlane(tmp())
    plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const snap = plane.snapshot()
    const outbox = buildAgenticOutbox({
      objectives: snap.objectives,
      events: snap.events,
      jobs: snap.jobs,
      attempts: snap.attempts,
    })
    const ledgerFile = `${tmp()}/agentic-ledger.sqlite`
    const { first, second } = verifyLedgerIdempotency(outbox, ledgerFile)
    expect(first.inserted).toBeGreaterThan(0)
    expect(first.failed).toHaveLength(0)
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(first.attempted)
    expect(second.latestSequence).toBe(first.latestSequence)
    expect(BYTEPORT_LIVE_ALEX.recordId).toBe('6a89dc7a-81be-4f9b-bed2-724564ee3e97')
  })

  it('discovers a free fallback model pool so workflows never hard-fail', async () => {
    const { discoverModelPool, preferredTierForKind } = await import('./model-pool')
    const pool = discoverModelPool()
    expect(pool.some((model) => model.tier === 'deterministic')).toBe(true)
    expect(pool.some((model) => model.tier === 'local_free' && model.available)).toBe(true)
    expect(preferredTierForKind('attio.reconcile')[0]).toBe('deterministic')
    expect(preferredTierForKind('linkedin.draft')).toContain('frontier')
  })

  it('loads the durable MCP-refreshed Attio snapshot with real Byteport team ids', async () => {
    const { loadAttioLiveSnapshot } = await import('./attio-cache')
    const { createLiveAttioAdapter } = await import('./attio-live')
    const snapshot = loadAttioLiveSnapshot()
    expect(snapshot?.companies[0]?.recordId).toBe('8fc484a3-8e27-4d9e-9223-ecfa3114a002')
    expect(snapshot?.people.some((person) => person.email === 'alex@byteport.com')).toBe(true)
    expect(snapshot?.people.some((person) => person.email === 'jayram@byteport.com')).toBe(true)
    const { adapter, mode } = createLiveAttioAdapter()
    expect(mode).toBe('live-seeded')
    const jayram = await adapter.findPerson({ email: 'jayram@byteport.com' })
    expect(jayram?.attioId).toBe('8aed6ffa-3397-4d06-b59e-79663afa28d1')
  })

  it('continues Toronto across Oakland→Backup hosts sharing one durable state file', async () => {
    const { runMultiHostContinuitySim } = await import('./multi-host-sim')
    const result = await runMultiHostContinuitySim(tmp())
    expect(result.grokSameObjective).toBe(true)
    expect(result.oaklandOffline).toBe(true)
    expect(result.grokOnline).toBe(true)
    expect(result.jobsCompleted).toBeGreaterThan(0)
    expect(result.ledger.afterOakland?.inserted).toBeGreaterThan(0)
    expect(result.ledger.grewOrStable).toBe(true)
    expect(result.toronto.picture).toMatch(/Toronto/i)
  })

  it('coordinates Hermes and GrokBot over the HTTP control plane', async () => {
    const { runHttpFleetE2E } = await import('./http-e2e')
    const result = await runHttpFleetE2E(tmp())
    expect(result.grokSameObjective).toBe(true)
    expect(result.oaklandDrained + result.backupDrained).toBeGreaterThan(0)
    expect(result.health.oaklandOffline).toBe(true)
    expect(String(result.lumaCampaign)).toMatch(/1\/20 RSVPs/)
    expect(Number(result.ledgerInserted)).toBeGreaterThan(0)
    expect(result.sessionUnhealthy).toBeGreaterThanOrEqual(1)
    expect(result.reclaimed).toBe(0)
    expect(result.readinessReady).toBe(false)
    expect(result.readinessBlockers).toBeGreaterThan(0)
    expect(result.attioReconcileExisting).toBeGreaterThanOrEqual(1)
    expect(result.seededMachines).toEqual(expect.arrayContaining(['oakland-mini', 'backup-mini', 'sf-mini']))
  })

  it('maps Attio live people onto fleet sender identities', async () => {
    const { buildIdentityMap, resolveSenderForPrincipal } = await import('./identity-map')
    const map = buildIdentityMap()
    expect(map.some((link) => link.email === 'alex@byteport.com' && link.attioId === '6a89dc7a-81be-4f9b-bed2-724564ee3e97')).toBe(true)
    expect(map.some((link) => link.email === 'jayram@byteport.com')).toBe(true)
    expect(resolveSenderForPrincipal('byteport')?.fleetIdentityId).toBeTruthy()
  })

  it('persists HTTP objectives across process-plane cache reset via the shared store file', async () => {
    const { getFleetPlane, resetFleetPlaneCache } = await import('./runtime')
    const statePath = `${tmp()}/state.json`
    resetFleetPlaneCache()
    const first = getFleetPlane({ statePath, seed: true })
    first.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    resetFleetPlaneCache()
    const second = getFleetPlane({ statePath, seed: false })
    expect(second.snapshot().objectives.some((item) => /toronto/i.test(item.title))).toBe(true)
    const grok = second.submitObjective({
      title: 'Toronto dinner',
      intent: 'Where are we on Toronto?',
      sourceInterface: 'grokbot',
    })
    expect(grok.objective.id).toBe(first.snapshot().objectives[0].id)
    resetFleetPlaneCache()
  })

  it('blocks live sends when the identity session needs login', async () => {
    const { decideAutonomy } = await import('./autonomy')
    const decision = decideAutonomy('linkedin.send', {
      id: 'katherine-byteport',
      teammate: 'katherine',
      principal: 'byteport',
      channel: 'linkedin',
      machineId: 'sf-mini',
      sessionHost: 'hermes',
      sessionStatus: 'needs_login',
      autonomyLevel: 3,
      sendMode: 'live',
    })
    expect(decision.execute).toBe(false)
    expect(decision.allow).toBe(false)
    expect(decision.reason).toMatch(/needs_login/)
  })
})

describe('gmail + calendar verification', () => {
  it('does not treat a calendar create as complete without calendar lookup', () => {
    const missing = verifyJobResult({ kind: 'calendar.create', result: { eventId: 'evt-1' }, evidence: [] })
    expect(missing.ok).toBe(false)
    const ok = verifyJobResult(
      { kind: 'calendar.create', result: { eventId: 'evt-1' }, evidence: [] },
      { calendarLookup: (id) => id === 'evt-1' },
    )
    expect(ok.ok).toBe(true)
  })

  it('verifies Gmail sends against Sent and suppresses a duplicate to the same person', async () => {
    const { runEmailCalendarVerifyLoop } = await import('./gtm-loop')
    const plane = createTestPlane(tmp())
    const result = await runEmailCalendarVerifyLoop(plane)
    expect(result.email.every((job) => job.state === 'completed')).toBe(true)
    expect(result.gmailSent).toHaveLength(1)
    expect(result.email.some((job) => job.result?.skipped === true)).toBe(true)
    expect(result.calendar?.state).toBe('completed')
    expect(result.calendarEvents).toHaveLength(1)
    expect(result.calendar?.evidence.some((item) => item.verified && item.kind === 'calendar')).toBe(true)
  })
})

describe('dead-letter reclaim', () => {
  it('returns exhausted jobs to the queue so another worker can continue', () => {
    const plane = createTestPlane(tmp())
    const { objective } = plane.submitObjective({
      title: 'Retryable research',
      intent: 'Research a stuck account',
      sourceInterface: 'hermes',
    })
    const workflowId = plane.snapshot().workflows.find((item) => item.objectiveId === objective.id)!.id
    plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: 'research.run',
      title: 'Failover research',
      priority: 'P2',
      requiredCapabilities: ['research'],
      idempotencyKey: 'dead-letter-research-1',
      entityKey: 'company:acme',
    })
    const start = Date.now()
    const target = plane.snapshot().jobs.find((job) => job.idempotencyKey === 'dead-letter-research-1')
    expect(target).toBeTruthy()
    let failures = 0
    let guard = 0
    while (failures < 3 && guard++ < 20) {
      const claimed = plane.claimNext('hermes-oakland', start + guard * 1_000)
      expect(claimed).toBeTruthy()
      if (claimed!.id !== target!.id) {
        plane.completeJob({ jobId: claimed!.id, workerId: 'hermes-oakland', result: { ok: true }, verified: true })
        continue
      }
      const failed = plane.failJob({
        jobId: claimed!.id,
        workerId: 'hermes-oakland',
        error: 'transient worker crash',
      })
      failures += 1
      if (failures < 3) expect(failed?.state).toBe('queued')
      else expect(failed?.state).toBe('dead_letter')
    }
    expect(failures).toBe(3)
    expect(plane.picture()).toMatch(/dead-letter/)
    const reclaimed = plane.reclaimDeadLetters({ jobId: target!.id, at: start + 10_000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0].state).toBe('queued')
    plane.heartbeat({ workerId: 'grokbot-backup', at: start + 11_000 })
    let stolen = null as ReturnType<typeof plane.claimNext>
    for (let i = 0; i < 8; i += 1) {
      const claimed = plane.claimNext('grokbot-backup', start + 12_000 + i * 1_000)
      if (!claimed) break
      if (claimed.id === target!.id) {
        stolen = claimed
        break
      }
      plane.completeJob({ jobId: claimed.id, workerId: 'grokbot-backup', result: { ok: true }, verified: true })
    }
    expect(stolen?.id).toBe(target!.id)
  })
})

describe('live Attio + MCP SoT readiness', () => {
  it('loads the MCP-refreshed Attio snapshot and reconciles real Byteport ids', async () => {
    const { reconcileAgainstLiveAttio, BYTEPORT_LIVE_ALEX } = await import('./attio-live')
    const result = await reconcileAgainstLiveAttio([
      { key: 'person:alex', name: 'Alex Newiger', email: 'alex@byteport.com', company: 'Byteport' },
      { key: 'person:jayram', name: 'Jayram Palamadai', email: 'jayram@byteport.com', company: 'Byteport' },
    ])
    expect(result.mode).toMatch(/live-seeded|http/)
    expect(result.existing).toBeGreaterThanOrEqual(2)
    expect(result.attioIds).toContain(BYTEPORT_LIVE_ALEX.recordId)
    expect(result.verified).toBe(true)
  })

  it('verifies real Gmail Sent and Calendar proofs from the MCP SoT cache', async () => {
    const { storesFromMcpSotSnapshot, loadMcpSotSnapshot } = await import('./mcp-sot-cache')
    const { verifyGmailSend, verifyCalendarCreate } = await import('./sot-verify')
    const snapshot = loadMcpSotSnapshot()
    expect(snapshot?.gmailSent.length).toBeGreaterThan(0)
    expect(snapshot?.calendarEvents.length).toBeGreaterThan(0)
    const { gmailSent, calendarEvents } = storesFromMcpSotSnapshot()
    const mail = verifyGmailSend(gmailSent, { messageId: snapshot!.gmailSent[0].messageId })
    const cal = verifyCalendarCreate(calendarEvents, { eventId: snapshot!.calendarEvents[0].eventId })
    expect(mail.ok).toBe(true)
    expect(cal.ok).toBe(true)
  })

  it('reports production DoD blockers until Attio key and Tailscale heartbeats exist', async () => {
    const plane = createTestPlane(tmp())
    const { assessFleetReadiness } = await import('./readiness')
    const readiness = assessFleetReadiness(plane)
    expect(readiness.readyForProductionDoD).toBe(false)
    expect(readiness.blockers.some((item) =>
      item.startsWith('attio-http-key')
      || item.startsWith('attio-live-verified')
      || item.startsWith('fresh-host-heartbeats')
      || item.startsWith('tailscale-mesh'),
    )).toBe(true)
    expect(readiness.picture).toMatch(/not production-ready/)
  })

  it('treats a fresh Composio Attio proof as live SoT wiring', async () => {
    const { assessFleetReadiness } = await import('./readiness')
    const { attioProofIsFresh, loadAttioLiveProof } = await import('./attio-remote')
    const proof = loadAttioLiveProof()
    expect(attioProofIsFresh(proof)).toBe(true)
    const plane = createTestPlane(tmp())
    const readiness = assessFleetReadiness(plane)
    expect(readiness.checks.some((check) => check.id === 'attio-live-verified' && check.ok)).toBe(true)
  })

  it('tolerates Attio proof timestamps slightly ahead of the server clock', async () => {
    const { attioProofIsFresh } = await import('./attio-remote')
    const at = Date.now()
    const proof = {
      verifiedAt: new Date(at + 30_000).toISOString(),
      source: 'attio-mcp' as const,
      workspace: 'byteport',
      people: [{ recordId: 'x', name: 'Alex', email: 'alex@byteport.com' }],
      companies: [],
    }
    expect(attioProofIsFresh(proof, undefined, at)).toBe(true)
    expect(attioProofIsFresh(proof, undefined, at, 1_000)).toBe(false)
  })

  it('maps Sumble monitor output into Fleet OS signal events', async () => {
    const { sumbleMonitorToFleetEvents, buildMigrationPlan } = await import('./migration')
    const events = sumbleMonitorToFleetEvents({
      researched: 3,
      newSignals: 1,
      signals: [{ company: 'Acme', detail: 'PagerDuty detected', kind: 'incident_stack' }],
    })
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('signal.detected')
    expect(events[0].source).toBe('research')
    const plan = buildMigrationPlan()
    expect(plan.wrap.some((item) => item.id === 'gtm-account-signal-monitor')).toBe(true)
    expect(plan.deprecate.some((item) => item.id === 'gtm-sumble-monitor')).toBe(true)
    expect(plan.reuse.some((item) => item.id === 'agentic-os-ledger')).toBe(true)
    const briefEvent = (await import('./migration')).dailyBriefToFleetEvent({
      asOf: '2026-09-18',
      briefId: 'brief-1',
      changeCount: 2,
    })
    expect(briefEvent.source).toBe('byteport-hermes')
    expect(briefEvent.payload.kind).toBe('meeting.brief_tomorrow')
  })

  it('ingests Granola transcripts into commitment follow-up jobs', async () => {
    const { handleFleetHttp } = await import('./api-handlers')
    const plane = createTestPlane(tmp())
    const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'granola-ingest',
      meetingKey: 'mtg-toronto-prep',
      title: 'Toronto dinner prep',
      attendees: ['Alex Newiger', 'Prospect VP'],
      transcript: "I'll send the invite list tomorrow and follow up with warm intros.",
    })
    expect(result.status).toBe(200)
    expect(result.body.ok).toBe(true)
    expect((result.body.extraction as { commitments: unknown[] }).commitments.length).toBeGreaterThan(0)
    const jobs = plane.snapshot().jobs.filter((job) => job.kind === 'transcript.process')
    expect(jobs.length).toBeGreaterThan(0)
  })

  it('records real meeting commitments at ingest and skips empty notes', async () => {
    const { extractTranscript } = await import('./meeting')
    expect(extractTranscript({
      meetingKey: 'empty',
      text: 'We talked about the weather and the office.',
    }).commitments).toHaveLength(0)
    const mounya = extractTranscript({
      meetingKey: 'mounya',
      text: '# Next Steps\n- Mounya on vacation for ~1 week; will text Alex via LinkedIn when back\n- Onsite visit planned',
    })
    expect(mounya.commitments.some((item) => /linkedin/i.test(item.text))).toBe(true)

    const { handleFleetHttp } = await import('./api-handlers')
    const plane = createTestPlane(tmp())
    const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'granola-ingest',
      meetingKey: 'mtg-mounya',
      title: 'Byteport 1st call: Mounya',
      attendees: ['Alex Newiger', 'Mounya Inampudi'],
      attioRecordId: 'cb857b5a-24e5-43e9-8a86-ab64b9238273',
      transcript: '# Next Steps\n- Mounya will text Alex via LinkedIn when back\n- Onsite visit planned',
    })
    expect(result.status).toBe(200)
    const recorded = result.body.commitments as Array<{ text: string }>
    expect(recorded.length).toBeGreaterThan(0)
    expect(plane.snapshot().commitments.length).toBe(recorded.length)
    const again = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'granola-ingest',
      meetingKey: 'mtg-mounya',
      transcript: '# Next Steps\n- Mounya will text Alex via LinkedIn when back\n- Onsite visit planned',
    })
    expect((again.body.commitments as unknown[]).length).toBe(0)
    expect(plane.snapshot().jobs.some((job) => job.kind === 'attio.commitment_sync' && job.payload.attioRecordId === 'cb857b5a-24e5-43e9-8a86-ab64b9238273')).toBe(true)

    const { parseExecutiveCommand } = await import('./commands')
    const { executeExecutiveCommand } = await import('./executive')
    expect(parseExecutiveCommand('Follow up on everything I promised this week.', 'hermes').kind).toBe('promises')
    const follow = executeExecutiveCommand(plane, 'Follow up on everything I promised this week.', 'grokbot')
    expect(follow.command.kind).toBe('promises')
    expect(follow.picture).toMatch(/open promise/i)
    expect((follow.details?.open as unknown[]).length).toBeGreaterThan(0)
    const before = plane.snapshot().objectives.length
    executeExecutiveCommand(plane, 'Follow up on everything I promised this week.', 'muse')
    expect(plane.snapshot().objectives.length).toBe(before)
    const attention = executeExecutiveCommand(plane, 'What needs my attention today?', 'slack')
    expect(attention.picture).toMatch(/promise/i)
    expect(parseExecutiveCommand('Why aren\'t we getting meetings?', 'hermes').kind).toBe('stuck')
    expect(executeExecutiveCommand(plane, 'Why aren\'t we getting meetings?', 'hermes').picture).toMatch(/stuck|queued|dead-letter|blocked/i)
    expect(parseExecutiveCommand('What did inference cost?', 'codex').kind).toBe('cost')
    plane.recordCost({
      jobId: null,
      workflowId: null,
      modelId: 'ollama-local',
      machineId: 'oakland-mini',
      taskType: 'classify',
      success: true,
      amount: 0,
    })
    expect(executeExecutiveCommand(plane, 'What did inference cost?', 'codex').picture).toMatch(/inference/i)
  })

  it('assigns a default Gmail identity to email drafts and skips meeting-key Attio verifies', async () => {
    const dir = tmp()
    const plane = createTestPlane(dir)
    const { objective, jobs } = plane.submitObjective({
      title: 'Draft follow-up',
      intent: 'Follow up on a meeting.',
      sourceInterface: 'hermes',
    })
    const workflowId = jobs[0]?.workflowId ?? plane.snapshot().workflows[0].id
    const draft = plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: 'email.draft',
      title: 'Draft to Mounya',
      priority: 'P0',
      requiredCapabilities: ['email.draft'],
      idempotencyKey: 'draft-mounya-1',
      entityKey: 'person:mounya',
    })
    expect(draft.requiredIdentityId).toBe('alex-gmail')
    plane.heartbeat({ workerId: 'hermes-oakland' })
    const claimed = plane.claimNext('hermes-oakland')
    expect(claimed?.kind).toBe('email.draft')
    expect(claimed?.state).toBe('leased')
    if (claimed) {
      plane.completeJob({ jobId: claimed.id, workerId: 'hermes-oakland', result: { drafted: true }, verified: true })
    }

    const reconcile = plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: 'attio.reconcile',
      title: 'Meeting key reconcile',
      priority: 'P1',
      requiredCapabilities: ['attio'],
      idempotencyKey: 'recon-meeting-1',
      entityKey: 'eaa93f0e-94f3-4e1c-befd-bb3935c3b2b6',
    })
    let reconClaim = plane.claimNext('hermes-oakland')
    while (reconClaim && reconClaim.id !== reconcile.id) {
      plane.completeJob({ jobId: reconClaim.id, workerId: 'hermes-oakland', result: { ok: true }, verified: true })
      reconClaim = plane.claimNext('hermes-oakland')
    }
    expect(reconClaim?.id).toBe(reconcile.id)
    const done = plane.completeJob({
      jobId: reconcile.id,
      workerId: 'hermes-oakland',
      result: {
        attioIds: [],
        unmatched: [{ key: 'meeting:eaa93f0e-94f3-4e1c-befd-bb3935c3b2b6' }],
      },
    })
    expect(done?.state).toBe('completed')

    const blocked = plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: 'email.draft',
      title: 'Draft without identity',
      priority: 'P0',
      requiredCapabilities: ['email.draft'],
      idempotencyKey: 'draft-repair-1',
      entityKey: 'person:parth',
    })
    const raw = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8')) as {
      jobs: Array<{ id: string; requiredIdentityId: string | null; state: string; nextAction: string }>
    }
    const stuck = raw.jobs.find((item) => item.id === blocked.id)
    if (stuck) {
      stuck.requiredIdentityId = null
      stuck.state = 'blocked'
      stuck.nextAction = 'No authorized identity for this action.'
    }
    writeFileSync(`${dir}/state.json`, JSON.stringify(raw))
    const reloaded = new FleetControlPlane(new FleetStore(`${dir}/state.json`))
    const { handleFleetHttp } = await import('./api-handlers')
    const repaired = await handleFleetHttp(reloaded, 'POST', new URLSearchParams(), { action: 'repair' })
    expect(repaired.status).toBe(200)
    expect((repaired.body.repaired as { requeued: number }).requeued).toBeGreaterThan(0)
    expect(reloaded.snapshot().jobs.find((job) => job.id === blocked.id)?.state).toBe('queued')
    expect(reloaded.snapshot().jobs.find((job) => job.id === blocked.id)?.requiredIdentityId).toBe('alex-gmail')

    const rawAgain = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8')) as typeof raw
    const healed = rawAgain.jobs.find((item) => item.id === blocked.id)
    if (healed) {
      healed.requiredIdentityId = null
      healed.state = 'blocked'
    }
    writeFileSync(`${dir}/state.json`, JSON.stringify(rawAgain))
    const { getFleetPlane, resetFleetPlaneCache } = await import('./runtime')
    resetFleetPlaneCache()
    const booted = getFleetPlane({ statePath: `${dir}/state.json` })
    expect(booted.snapshot().jobs.find((job) => job.id === blocked.id)?.state).toBe('queued')
    expect(booted.snapshot().jobs.find((job) => job.id === blocked.id)?.requiredIdentityId).toBe('alex-gmail')
    resetFleetPlaneCache()
  })

  it('does not mark Toronto complete while Katherine still has a queued draft', async () => {
    const dir = tmp()
    const plane = createTestPlane(dir)
    const { objective, jobs } = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const workflowId = jobs[0]?.workflowId ?? plane.snapshot().workflows[0].id
    plane.enqueueBackgroundJob({
      objectiveId: objective.id,
      workflowId,
      kind: 'linkedin.draft',
      title: 'Draft outreach for remaining dinner targets',
      priority: 'P1',
      requiredCapabilities: ['linkedin.draft'],
      requiredIdentityId: 'katherine-byteport',
      idempotencyKey: 'toronto-gap-draft',
      entityKey: objective.id,
    })
    const raw = JSON.parse(readFileSync(`${dir}/state.json`, 'utf8')) as {
      objectives: Array<{ id: string; state: string }>
    }
    const obj = raw.objectives.find((item) => item.id === objective.id)
    if (obj) obj.state = 'completed'
    writeFileSync(`${dir}/state.json`, JSON.stringify(raw))
    const reloaded = new FleetControlPlane(new FleetStore(`${dir}/state.json`))
    expect(reloaded.status('Toronto').picture).not.toMatch(/Objective complete/)
    expect(reloaded.status('Toronto').picture).toMatch(/queued/)
    const { handleFleetHttp } = await import('./api-handlers')
    await handleFleetHttp(reloaded, 'POST', new URLSearchParams(), { action: 'repair' })
    expect(reloaded.snapshot().objectives.find((item) => item.id === objective.id)?.state).toBe('active')
  })

  it('reopens Toronto when Attio still needs a date decision', async () => {
    const plane = createTestPlane(tmp())
    const submitted = plane.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    expect(submitted.objective.title).toBe('Toronto dinner')
    const { handleFleetHttp } = await import('./api-handlers')
    const first = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'attio-task-ingest',
      tasks: [{
        taskId: '40e0ea7d-42fe-4292-b6ec-a2ed01884ac1',
        content: 'Lock a Toronto dinner date with Jia before outreach starts. Decide the room goal and ICP.',
        linkedRecordId: '062cb66c-c3c6-40fd-8fc4-2ae66467bf3b',
        deadlineAt: '2026-09-25T00:00:00.000Z',
      }],
    })
    expect(first.status).toBe(200)
    expect((first.body.ingested as { decisions: number }).decisions).toBe(1)
    const status = plane.status('Toronto')
    expect(status.objective?.state).toBe('active')
    expect(status.picture).toMatch(/Decision: Lock a Toronto dinner date/)
    const again = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'attio-task-ingest',
      tasks: [{
        taskId: '40e0ea7d-42fe-4292-b6ec-a2ed01884ac1',
        content: 'Lock a Toronto dinner date with Jia before outreach starts. Decide the room goal and ICP.',
      }],
    })
    expect((again.body.ingested as { created: number; decisions: number }).created).toBe(0)
    expect((again.body.ingested as { decisions: number }).decisions).toBe(0)
  })

  it('maps external Google Calendar events into briefing jobs', async () => {
    const { calendarEventsToFleetEvents } = await import('./calendar-ingest')
    const events = calendarEventsToFleetEvents([
      {
        id: 'evt-mounya',
        summary: 'Byteport 1st call: (Mounya Inampudi )',
        attendees: [
          { email: 'alex@byteport.com', self: true },
          { email: 'mounyainampudi@gmail.com' },
          { email: 'jayram@byteport.com' },
        ],
      },
      {
        id: 'evt-internal',
        summary: 'Internal standup',
        attendees: [
          { email: 'alex@byteport.com', self: true },
          { email: 'jayram@byteport.com' },
        ],
      },
    ])
    expect(events).toHaveLength(1)
    expect(events[0].type).toBe('calendar.external_meeting_soon')
    expect(events[0].payload.meetingKey).toBe('evt-mounya')

    const { handleFleetHttp } = await import('./api-handlers')
    const plane = createTestPlane(tmp())
    const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'calendar-ingest',
      events: [{
        id: 'evt-shreyas',
        summary: 'Chat with Shreyas Yadav',
        attendees: [
          { email: 'alex@byteport.com', self: true },
          { email: 'ssyadav3@dons.usfca.edu', displayName: 'Shreyas Yadav' },
        ],
      }],
    })
    expect(result.status).toBe(200)
    expect(result.body.ingested).toBe(1)
    expect(plane.snapshot().jobs.some((job) => job.kind === 'meeting.brief')).toBe(true)
  })

  it('exposes Tailscale mesh inventory with known Oakland/SF IPs', async () => {
    const { FLEET_MESH_HOSTS, summarizeMeshInventory, meshHostByMachineId } = await import('./fleet-mesh')
    expect(meshHostByMachineId('oakland-mini')?.tailscaleHostname).toBe('alex-mac-mini-1')
    expect(meshHostByMachineId('sf-mini')?.tailscaleIp).toBe('100.106.243.19')
    expect(summarizeMeshInventory().withKnownIp).toBeGreaterThanOrEqual(2)
    expect(FLEET_MESH_HOSTS.some((host) => host.machineId === 'backup-mini' && !host.tailscaleIp)).toBe(true)
    expect(meshHostByMachineId('backup-mini')?.lastKnownTailscaleIp).toBe('100.90.155.111')
  })

  it('enriches backup-mini IP from tailscale status peers', async () => {
    const { enrichMeshFromTailscaleStatus } = await import('./fleet-mesh')
    const enriched = enrichMeshFromTailscaleStatus({
      Self: {
        HostName: 'alex-mac-mini-1',
        TailscaleIPs: ['100.118.142.13'],
      },
      Peer: {
        a: { HostName: 'alex-agent-mini', TailscaleIPs: ['100.106.243.19'] },
        b: { HostName: 'backup-byteport-mini', TailscaleIPs: ['100.99.88.77'] },
      },
    })
    expect(enriched.selfIsOakland).toBe(true)
    expect(enriched.hosts.find((h) => h.machineId === 'backup-mini')?.tailscaleIp).toBe('100.99.88.77')
  })

  it('plans Attio note/task payloads for open commitments and stamps task evidence', async () => {
    const { planCommitmentAttioSync, commitmentsFromMeetingNotes } = await import('./commitment-sync')
    const bullets = commitmentsFromMeetingNotes(`
# Next Steps
- **Schedule technical interview with Parth for Thursday 2PM EST** (Alex)
- **Mention Parth's product interest to Jayram** (Alex)
- Follow up via email and connect with Will on LinkedIn (Parth)
`)
    expect(bullets.length).toBeGreaterThanOrEqual(2)
    expect(bullets.some((item) => /interview/i.test(item.text))).toBe(true)

    const plan = planCommitmentAttioSync({
      commitment: {
        id: 'cmt_1',
        meetingKey: 'mtg-1',
        owner: 'alex',
        text: 'Follow up on LinkedIn after Mounya returns',
        dueAt: null,
        state: 'open',
      },
      attioRecordId: 'cb857b5a-24e5-43e9-8a86-ab64b9238273',
      meetingTitle: 'Byteport 1st call: Mounya',
    })
    expect(plan.note?.parent_record_id).toBe('cb857b5a-24e5-43e9-8a86-ab64b9238273')
    expect(plan.task?.content).toMatch(/LinkedIn/)

    const { handleFleetHttp } = await import('./api-handlers')
    const plane = createTestPlane(tmp())
    plane.stampCommitmentAttio({
      commitmentId: 'missing',
      attioTaskId: 'task-x',
    })
    const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'commitment-sync',
      commitmentId: 'cmt_1',
      attioRecordId: 'cb857b5a-24e5-43e9-8a86-ab64b9238273',
      text: 'Follow up on LinkedIn after Mounya returns',
      meetingKey: 'mtg-1',
      attioTaskId: 'task_live_1',
    })
    expect(result.status).toBe(200)
    expect((result.body.plan as { task: { content: string } }).task.content).toMatch(/LinkedIn/)
  })

  it('normalizes Amplemarket and Apollo hits into signal events', async () => {
    const { amplemarketLeadsToHits, apolloPeopleToHits, externalHitsToFleetEvents } = await import('./signal-ingest')
    const hits = [
      ...amplemarketLeadsToHits([{ full_name: 'Pat VP', email: 'pat@acme.com', company_name: 'Acme', reason: 'Duo: infra signal' }]),
      ...apolloPeopleToHits([{ name: 'Sam Rivera', email: 'sam@new.com', organization_name: 'NewCo', title: 'VP Eng' }]),
    ]
    const events = externalHitsToFleetEvents(hits)
    expect(events).toHaveLength(2)
    expect(events[0].source).toBe('amplemarket')
    expect(events[1].source).toBe('apollo')
    const { handleFleetHttp } = await import('./api-handlers')
    const plane = createTestPlane(tmp())
    const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'signal-ingest',
      hits,
    })
    expect(result.body.ingested).toBe(2)
  })

  it('duo-poll fetches Amplemarket watched leads without Sumble', async () => {
    const previous = process.env.AMPLEMARKET_API_KEY
    process.env.AMPLEMARKET_API_KEY = 'ample-key'
    const originalFetch = globalThis.fetch
    const seen: string[] = []
    globalThis.fetch = (async (url: string | URL) => {
      seen.push(String(url))
      expect(String(url).includes('sumble')).toBe(false)
      return {
        ok: true,
        json: async () => ({
          duo_leads: [{
            person: { name: 'Eliott Macdonald' },
            company: { name: 'Teradyne' },
            signal: { kind: 'recent_job_changes', title: 'Was recently promoted' },
          }],
        }),
      } as Response
    }) as typeof fetch
    try {
      const { handleFleetHttp } = await import('./api-handlers')
      const plane = createTestPlane(tmp())
      const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
        action: 'duo-poll',
      })
      expect(result.status).toBe(200)
      expect(result.body.ingested).toBe(1)
      expect(seen[0]).toContain('api.amplemarket.com/duo_leads')
    } finally {
      globalThis.fetch = originalFetch
      if (previous === undefined) delete process.env.AMPLEMARKET_API_KEY
      else process.env.AMPLEMARKET_API_KEY = previous
    }
  })

  it('classifies Gmail/Unibox threads and skips OOO noise', async () => {
    const { classifyInboxThread, inboxThreadsToFleetEvents } = await import('./inbox-ingest')
    expect(classifyInboxThread({
      id: 't-ooo',
      from: 'Tim Hale <tim@acme.com>',
      subject: 'Out of Office',
      snippet: 'I am out of office until next week',
    }).classification).toBe('noise')
    const { events, skipped } = inboxThreadsToFleetEvents([
      {
        id: 't-booked',
        source: 'unibox',
        from: 'Andrew Lazer <andrew@example.com>',
        fromName: 'Andrew Lazer',
        subject: 'Re: SpaceX dinner',
        snippet: 'Booked! Chat soon',
      },
      {
        id: 't-luma',
        source: 'gmail',
        from: 'Swift Sheng <swift@example.com>',
        fromName: 'Swift Sheng',
        subject: "You're on the waitlist for Byteport Toronto",
        snippet: 'lu.ma waitlist confirmation',
      },
      {
        id: 't-ooo',
        from: 'tim@acme.com',
        subject: 'Automatic reply: OOO',
        snippet: 'I am out of office',
      },
    ])
    expect(skipped).toHaveLength(1)
    expect(events.some((event) => event.type === 'inbox.reply' && event.payload.intent === 'booked')).toBe(true)
    expect(events.some((event) => event.type === 'luma.rsvp')).toBe(true)

    const { handleFleetHttp } = await import('./api-handlers')
    const plane = createTestPlane(tmp())
    const result = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'inbox-ingest',
      threads: [{
        id: 't-imagine',
        source: 'unibox',
        from: 'Abdullah <abdullah@imagineart.com>',
        fromName: 'Abdullah',
        subject: 'Re: data movement',
        snippet: 'Interested, tell me more',
      }],
    })
    expect(result.body.ingested).toBe(1)
    expect(plane.snapshot().jobs.some((job) => job.kind === 'email.draft')).toBe(true)
  })

  it('imports LinkedIn harness.yaml identities and verifies sends against the ledger', async () => {
    const { loadHarnessIdentities, parseHarnessYamlIdentities } = await import('./harness-identities')
    const identities = loadHarnessIdentities()
    expect(identities.some((item) => item.id === 'jayram-byteport' && item.sessionHost === 'grokbot')).toBe(true)
    expect(identities.some((item) => item.id === 'alex-rootly' && item.principal === 'rootly')).toBe(true)
    expect(parseHarnessYamlIdentities('identities:\n  - id: x\n').length).toBe(0)

    const plane = createTestPlane(tmp())
    plane.seedDefaults()
    expect(plane.snapshot().identities.some((item) => item.id === 'maggie-byteport')).toBe(true)
    expect(plane.snapshot().identities.some((item) => item.id === 'alex-gmail')).toBe(true)

    const { ingestLinkedInLedgerEvents, MemoryLinkedInLedger, verifyLinkedInSend } = await import('./linkedin-ledger')
    const ledger = new MemoryLinkedInLedger()
    const report = ingestLinkedInLedgerEvents([{
      id: 'li-live-1',
      ts: new Date().toISOString(),
      identity: 'jayram-byteport',
      principal: 'byteport',
      campaign: 'toronto',
      prospect_key: 'person:vp',
      action: 'message',
      copy_hash: 'sha256:demo',
      platform: 'hermes',
      runner: 'fleet-os',
      result: 'sent',
    }, {
      id: 'li-live-1',
      ts: new Date().toISOString(),
      identity: 'jayram-byteport',
      principal: 'byteport',
      campaign: 'toronto',
      prospect_key: 'person:vp',
      action: 'message',
      copy_hash: 'sha256:demo',
      platform: 'hermes',
      runner: 'fleet-os',
      result: 'sent',
    }], ledger)
    expect(report.appended).toBe(1)
    expect(report.skipped).toBe(1)
    expect(verifyLinkedInSend(ledger, { externalRef: 'li-live-1' }).ok).toBe(true)

    const { handleFleetHttp } = await import('./api-handlers')
    const home = tmp()
    const prevHome = process.env.FLEET_OS_HOME
    process.env.FLEET_OS_HOME = home
    try {
      const ingest = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
        action: 'linkedin-ledger-ingest',
        events: [{
          id: 'li-http-1',
          ts: new Date().toISOString(),
          identity: 'katherine-byteport',
          principal: 'byteport',
          campaign: 'toronto',
          prospect_key: 'person:infra',
          action: 'connect',
          copy_hash: 'sha256:http',
          platform: 'hermes',
          runner: 'test',
          result: 'sent',
        }],
      })
      expect(ingest.body.appended).toBe(1)
      const verified = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
        action: 'linkedin-ledger-verify',
        externalRef: 'li-http-1',
      })
      expect(verified.body.verified).toBe(true)
    } finally {
      if (prevHome === undefined) delete process.env.FLEET_OS_HOME
      else process.env.FLEET_OS_HOME = prevHome
    }
  })

  it('maps Common Room activity into signal events', async () => {
    const { commonRoomHitsToHits, externalHitsToFleetEvents } = await import('./signal-ingest')
    const events = externalHitsToFleetEvents(commonRoomHitsToHits([{
      name: 'Dana',
      company: 'Acme',
      activity: 'Commented on data-movement thread',
    }]))
    expect(events[0].source).toBe('common-room')
  })

  it('suppresses prospect sends to internal domains and recent outbound touches', async () => {
    const { findSendSuppression } = await import('./suppression')
    const hit = findSendSuppression([], {
      kind: 'email.send',
      entityKey: 'person:alex@byteport.com',
      payload: { to: 'alex@byteport.com' },
    })
    expect(hit?.id).toBe('builtin:byteport.com')

    const plane = createTestPlane(tmp())
    const submitted = plane.submitObjective({
      title: 'Suppression check',
      intent: 'Do not email internal addresses.',
      sourceInterface: 'hermes',
    })
    const workflowId = submitted.jobs[0]?.workflowId ?? plane.snapshot().workflows.at(-1)!.id
    plane.enqueueBackgroundJob({
      objectiveId: submitted.objective.id,
      workflowId,
      kind: 'email.send',
      title: 'Do not email Alex internally',
      priority: 'P2',
      requiredCapabilities: ['email.send'],
      idempotencyKey: 'sup:alex-internal',
      entityKey: 'person:alex@byteport.com',
      payload: { to: 'alex@byteport.com' },
    })
    plane.heartbeat({ workerId: 'hermes-oakland' })
    const claimed = plane.claimNext('hermes-oakland')
    expect(claimed?.kind).not.toBe('email.send')
    const skipped = plane.snapshot().jobs.find((job) => job.idempotencyKey === 'sup:alex-internal')
    expect(skipped?.state).toBe('completed')
    expect(skipped?.result?.suppressed).toBe(true)
    expect(plane.snapshot().approvals.some((item) => item.jobId === skipped?.id)).toBe(false)

    const { handleFleetHttp } = await import('./api-handlers')
    const ingest = await handleFleetHttp(plane, 'POST', new URLSearchParams(), {
      action: 'inbox-ingest',
      threads: [
        {
          id: 'sent-rohit',
          from: 'alex@byteport.com',
          to: 'rsingh@nexgeniots.com',
          subject: "NexGen's infra hiring",
          snippet: 'Hi Rohit',
          labels: ['SENT'],
        },
        {
          id: 'luma-swift',
          from: 'team@byteport.com',
          to: 'luma@byteport.com',
          subject: 'New waitlist entry for Byteport Poker Night: Founders & Engineers',
          snippet: 'Swift Sheng registered for your event. Work email Ruijie.Sheng@qmfremont.com',
        },
        {
          id: 'luma-gennady',
          from: 'noreply@luma-mail.com',
          to: 'alex@byteport.com',
          subject: 'New Follower for Byteport',
          snippet: 'New Follower Gennady (gnndshnkr@gmail.com) has just followed Byteport. Unsubscribe',
        },
      ],
    })
    expect(ingest.status).toBe(200)
    const classified = ingest.body.classified as Array<{ id: string; classification: string; email?: string; eventName?: string }>
    expect(classified.find((item) => item.id === 'sent-rohit')?.classification).toBe('outbound')
    expect(classified.find((item) => item.id === 'luma-swift')?.classification).toBe('luma_rsvp')
    expect(classified.find((item) => item.id === 'luma-swift')?.email).toBe('ruijie.sheng@qmfremont.com')
    expect(classified.find((item) => item.id === 'luma-gennady')?.classification).toBe('luma_rsvp')
    expect(classified.find((item) => item.id === 'luma-gennady')?.person).toBe('gennady')
    expect(plane.snapshot().suppressions.some((item) => item.key === 'rsingh@nexgeniots.com')).toBe(true)
    expect(plane.snapshot().jobs.some((job) => job.kind === 'campaign.define' && /poker/i.test(job.title))).toBe(true)
  })

  it('merges new canonical identities into an older durable state without wiping objectives', () => {
    const dir = tmp()
    const statePath = `${dir}/state.json`
    const first = new FleetControlPlane(new FleetStore(statePath))
    first.seedDefaults()
    first.submitObjective({
      title: 'Toronto dinner',
      intent: 'Get 20 qualified infrastructure leaders to the Toronto dinner.',
      sourceInterface: 'hermes',
    })
    const before = first.snapshot().objectives[0].id
    // Simulate an older durable file that predates alex-gmail / alex-calendar.
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as { identities: Array<{ id: string }> }
    raw.identities = raw.identities.filter((item) => item.id !== 'alex-gmail' && item.id !== 'alex-calendar')
    writeFileSync(statePath, JSON.stringify(raw))
    const reloaded = new FleetControlPlane(new FleetStore(statePath))
    expect(reloaded.snapshot().identities.some((item) => item.id === 'alex-gmail')).toBe(false)
    reloaded.ensureCanonicalRegistry()
    expect(reloaded.snapshot().identities.some((item) => item.id === 'alex-gmail')).toBe(true)
    expect(reloaded.snapshot().identities.some((item) => item.id === 'alex-calendar')).toBe(true)
    expect(reloaded.snapshot().objectives[0].id).toBe(before)
  })
})
