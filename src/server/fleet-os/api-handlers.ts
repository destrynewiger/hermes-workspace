/**
 * Shared Fleet OS HTTP action handlers.
 * Used by the standalone fleet-server and mirrored by hermes `/api/fleet-os`.
 */

import { FleetControlPlane } from './control-plane'
import { executeExecutiveCommand } from './executive'
import { buildAgenticOutbox } from './agentic-bridge'
import { appendOutboxToLedger, defaultLedgerPath } from './agentic-ledger'
import { FLEET_MACHINE_SEEDS } from './heartbeat'
import { normalizeLumaWebhook } from './luma-webhook'
import { createLiveAttioAdapter, reconcileAgainstLiveAttio } from './attio-live'
import { loadAttioLiveSnapshot, upsertAttioLiveSnapshot } from './attio-cache'
import { upsertMcpSotSnapshot } from './mcp-sot-cache'
import { assessFleetReadiness } from './readiness'
import { evaluateSessionHealth } from './session-health'
import { runContinuousWorker } from './worker-loop'
import { saveAttioLiveProof, type AttioLiveProof, loadAttioLiveProof } from './attio-remote'
import { buildMigrationPlan, sumbleMonitorToFleetEvents } from './migration'
import { extractTranscript } from './meeting'
import { calendarEventsToFleetEvents, type CalendarEventInput } from './calendar-ingest'
import { FLEET_MESH_HOSTS, summarizeMeshInventory } from './fleet-mesh'
import { planCommitmentAttioSync } from './commitment-sync'
import { amplemarketLeadsToHits, externalHitsToFleetEvents, type ExternalSignalHit } from './signal-ingest'
import { inboxThreadsToFleetEvents, type InboxThreadInput } from './inbox-ingest'
import { ingestLinkedInLedgerEvents, openLinkedInLedger, verifyLinkedInSend, type LinkedInLedgerEvent } from './linkedin-ledger'

export type FleetHttpResult = {
  status: number
  body: Record<string, unknown>
}

function ok(body: Record<string, unknown>, status = 200): FleetHttpResult {
  return { status, body: { ok: true, ...body } }
}

function fail(error: string, status = 400): FleetHttpResult {
  return { status, body: { ok: false, error } }
}

export async function handleFleetHttp(
  plane: FleetControlPlane,
  method: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): Promise<FleetHttpResult> {
  if (method === 'GET') {
    const q = query.get('q')
    if (q) {
      const status = plane.status(q)
      return ok({ ...status, picture: status.picture })
    }
    return ok({
      picture: plane.picture(),
      health: plane.fleetHealth(),
      snapshot: plane.snapshot(),
      attio: {
        mode: createLiveAttioAdapter().mode,
        snapshotPeople: loadAttioLiveSnapshot()?.people.length ?? 0,
        readiness: assessFleetReadiness(plane),
      },
    })
  }

  if (method !== 'POST' || !body) return fail('POST JSON body required', 400)
  const action = typeof body.action === 'string' ? body.action : 'submit'

  if (action === 'heartbeat') {
    if (typeof body.workerId !== 'string') return fail('workerId required')
    plane.heartbeat({
      workerId: body.workerId,
      machineId: typeof body.machineId === 'string' ? body.machineId : undefined,
      load: typeof body.load === 'number' ? body.load : undefined,
    })
    return ok({ picture: plane.picture(), health: plane.fleetHealth() })
  }

  if (action === 'claim') {
    if (typeof body.workerId !== 'string') return fail('workerId required')
    const job = plane.claimNext(body.workerId)
    return ok({ job })
  }

  if (action === 'complete') {
    if (typeof body.jobId !== 'string' || typeof body.workerId !== 'string') {
      return fail('jobId and workerId required')
    }
    const job = plane.completeJob({
      jobId: body.jobId,
      workerId: body.workerId,
      result: (body.result as Record<string, unknown>) ?? {},
      verified: body.verified === true,
    })
    return ok({ job, picture: plane.picture() })
  }

  if (action === 'fail') {
    if (typeof body.jobId !== 'string' || typeof body.workerId !== 'string' || typeof body.error !== 'string') {
      return fail('jobId, workerId, and error required')
    }
    const job = plane.failJob({
      jobId: body.jobId,
      workerId: body.workerId,
      error: body.error,
      modelId: typeof body.modelId === 'string' ? body.modelId : undefined,
    })
    return ok({ job })
  }

  if (action === 'event') {
    if (typeof body.type !== 'string' || typeof body.source !== 'string') return fail('type and source required')
    const event = plane.ingestEvent(
      body.type,
      body.source,
      (body.payload as Record<string, unknown>) ?? {},
    )
    return ok({ event })
  }

  if (action === 'advertise') {
    if (typeof body.machineId !== 'string') return fail('machineId required')
    const seed = FLEET_MACHINE_SEEDS.find((item) => item.machineId === body.machineId)
    if (!seed) return fail(`Unknown machine ${body.machineId}`, 404)
    plane.applyMachineAdvertisement({ ...seed, at: Date.now() })
    for (const worker of seed.workers ?? []) {
      plane.heartbeat({ workerId: worker.id, machineId: seed.machineId, at: Date.now() })
    }
    return ok({ machineId: seed.machineId, health: plane.fleetHealth(), picture: plane.picture() })
  }

  if (action === 'command') {
    if (typeof body.text !== 'string' || typeof body.sourceInterface !== 'string') {
      return fail('text and sourceInterface required')
    }
    const result = executeExecutiveCommand(plane, body.text, body.sourceInterface)
    return ok({ ...result })
  }

  if (action === 'luma') {
    const normalized = normalizeLumaWebhook(body.body ?? body, {
      campaignId: typeof body.campaignId === 'string' ? body.campaignId : undefined,
      objectiveId: typeof body.objectiveId === 'string' ? body.objectiveId : undefined,
      eventName: typeof body.eventName === 'string' ? body.eventName : undefined,
    })
    if (!normalized) return fail('Not an RSVP-class Luma payload', 422)
    const event = plane.ingestEvent(normalized.type, normalized.source, normalized.payload)
    return ok({
      event,
      idempotencyKey: normalized.idempotencyKey,
      campaign: plane.campaignStatus(normalized.payload.eventName ?? 'dinner'),
    })
  }

  if (action === 'agentic-outbox') {
    const snap = plane.snapshot()
    const outbox = buildAgenticOutbox({
      objectives: snap.objectives,
      events: snap.events,
      jobs: snap.jobs,
      attempts: snap.attempts,
    })
    return ok({ count: outbox.length, outbox })
  }

  if (action === 'sync-ledger') {
    const snap = plane.snapshot()
    const outbox = buildAgenticOutbox({
      objectives: snap.objectives,
      events: snap.events,
      jobs: snap.jobs,
      attempts: snap.attempts,
    })
    const report = appendOutboxToLedger(outbox, {
      filename: typeof body.ledgerPath === 'string' ? body.ledgerPath : defaultLedgerPath(),
    })
    return ok({ outboxEntries: outbox.length, ...report })
  }

  if (action === 'reclaim') {
    const jobs = plane.reclaimDeadLetters({
      jobId: typeof body.jobId === 'string' ? body.jobId : undefined,
    })
    return ok({ reclaimed: jobs.length, jobs, picture: plane.picture() })
  }

  if (action === 'session-health') {
    const identities = plane.snapshot().identities.map((identity) => evaluateSessionHealth(identity))
    return ok({
      identities,
      unhealthy: identities.filter((item) => !item.healthy),
    })
  }

  if (action === 'readiness') {
    plane.ensureCanonicalRegistry()
    return ok({ readiness: assessFleetReadiness(plane) })
  }

  if (action === 'ensure-registry') {
    plane.ensureCanonicalRegistry()
    return ok({
      identities: plane.snapshot().identities.map((item) => item.id),
      readiness: assessFleetReadiness(plane),
    })
  }

  if (action === 'attio-proof') {
    const people = Array.isArray(body.people) ? body.people as AttioLiveProof['people'] : []
    const companies = Array.isArray(body.companies) ? body.companies as AttioLiveProof['companies'] : []
    if (!people.length && !companies.length) return fail('people or companies required')
    const nowIso = new Date().toISOString()
    const clientVerified = typeof body.verifiedAt === 'string' ? body.verifiedAt : nowIso
    const verifiedAt = Date.parse(clientVerified) > Date.now() + 1000 ? nowIso : clientVerified
    const proof = {
      verifiedAt,
      source: (body.source === 'attio-mcp' || body.source === 'attio-http' ? body.source : 'composio') as AttioLiveProof['source'],
      workspace: typeof body.workspace === 'string' ? body.workspace : 'byteport',
      people,
      companies,
    }
    saveAttioLiveProof(proof)
    return ok({ proof: { ...proof, people: proof.people.length, companies: proof.companies.length }, readiness: assessFleetReadiness(plane) })
  }

  if (action === 'migration-plan') {
    return ok({ plan: buildMigrationPlan() })
  }

  if (action === 'sumble-ingest') {
    const events = sumbleMonitorToFleetEvents((body.summary as {
      researched?: number
      newSignals?: number
      domains?: string[]
      signals?: Array<{ company?: string; detail?: string; kind?: string }>
    }) ?? body)
    const ingested = events.map((event) => plane.ingestEvent(event.type, event.source, event.payload))
    return ok({
      deprecated: 'sumble-api-unpaid',
      replacement: 'duo-ingest or signal-ingest',
      ingested: ingested.length,
      events: ingested,
      picture: plane.picture(),
    })
  }

  if (action === 'duo-ingest') {
    const leads = (Array.isArray(body.duo_leads) ? body.duo_leads : Array.isArray(body.leads) ? body.leads : []) as Parameters<typeof amplemarketLeadsToHits>[0]
    const events = externalHitsToFleetEvents(amplemarketLeadsToHits(leads))
    const ingested = events.map((event) => plane.ingestEvent(event.type, event.source, event.payload))
    return ok({ ingested: ingested.length, events: ingested, picture: plane.picture() })
  }

  if (action === 'duo-poll') {
    const apiKey = process.env.AMPLEMARKET_API_KEY
    if (!apiKey) return fail('AMPLEMARKET_API_KEY is required for Duo poll; Sumble API is retired')
    const status = typeof body.status === 'string' ? body.status : 'pending'
    const page = typeof body.page === 'number' ? body.page : 1
    const pageSize = typeof body.pageSize === 'number' ? body.pageSize : 10
    const params = new URLSearchParams({
      status,
      page: String(page),
      page_size: String(pageSize),
    })
    const response = await fetch(`https://api.amplemarket.com/duo_leads?${params}`, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
    })
    if (!response.ok) return fail(`Amplemarket Duo HTTP ${response.status}`)
    const listed = await response.json() as { duo_leads?: unknown[]; leads?: unknown[] }
    const leads = (listed.duo_leads ?? listed.leads ?? []) as Parameters<typeof amplemarketLeadsToHits>[0]
    const events = externalHitsToFleetEvents(amplemarketLeadsToHits(leads))
    const ingested = events.map((event) => plane.ingestEvent(event.type, event.source, event.payload))
    return ok({ ingested: ingested.length, events: ingested, picture: plane.picture() })
  }

  if (action === 'granola-ingest') {
    const meetingKey = typeof body.meetingKey === 'string' ? body.meetingKey
      : typeof body.meetingId === 'string' ? body.meetingId
        : typeof body.id === 'string' ? body.id
          : null
    if (!meetingKey) return fail('meetingKey required')
    const text = typeof body.transcript === 'string' ? body.transcript
      : typeof body.text === 'string' ? body.text
        : typeof body.summary === 'string' ? body.summary
          : ''
    const attendees = Array.isArray(body.attendees)
      ? body.attendees.map((item) => typeof item === 'string' ? item : String((item as { name?: string }).name ?? ''))
        .filter(Boolean)
      : []
    const extraction = extractTranscript({ meetingKey, text, attendees })
    const event = plane.ingestEvent('granola.transcript_available', 'granola', {
      meetingKey,
      title: typeof body.title === 'string' ? body.title : undefined,
      attendees,
      transcript: text,
      extraction,
    })
    const recorded = plane.recordCommitments({
      meetingKey,
      attioRecordId: typeof body.attioRecordId === 'string' ? body.attioRecordId : null,
      commitments: extraction.commitments,
    })
    return ok({
      meetingKey,
      event,
      extraction,
      commitments: recorded.map((item) => ({ id: item.id, owner: item.owner, text: item.text })),
      picture: plane.picture(),
    })
  }

  if (action === 'calendar-ingest') {
    const events = Array.isArray(body.events) ? body.events as CalendarEventInput[] : []
    if (!events.length) return fail('events required')
    const fleetEvents = calendarEventsToFleetEvents(events, {
      onlyExternal: body.onlyExternal !== false,
    })
    const ingested = fleetEvents.map((event) => plane.ingestEvent(event.type, event.source, event.payload))
    return ok({
      ingested: ingested.length,
      skipped: events.length - fleetEvents.length,
      events: ingested,
      picture: plane.picture(),
    })
  }

  if (action === 'mesh-inventory') {
    return ok({
      hosts: FLEET_MESH_HOSTS,
      summary: summarizeMeshInventory(),
      note: 'Static inventory only. Run pnpm fleet-mesh-probe on a Tailscale host to prove reachability.',
    })
  }

  if (action === 'attio-task-ingest') {
    const raw = Array.isArray(body.tasks) ? body.tasks : []
    const tasks = raw.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const task = item as Record<string, unknown>
      const taskId = typeof task.taskId === 'string' ? task.taskId : typeof task.id === 'string' ? task.id : ''
      const content = typeof task.content === 'string' ? task.content : ''
      if (!taskId || !content) return []
      return [{
        taskId,
        content,
        isCompleted: task.isCompleted === true || task.is_completed === true,
        deadlineAt: typeof task.deadlineAt === 'string' ? task.deadlineAt : typeof task.deadline_at === 'string' ? task.deadline_at : null,
        linkedRecordId: typeof task.linkedRecordId === 'string' ? task.linkedRecordId : null,
      }]
    })
    if (!tasks.length) return fail('tasks required')
    const ingested = plane.ingestAttioTasks(tasks)
    return ok({
      ingested,
      picture: plane.picture(),
      promises: plane.promiseBoard().picture,
    })
  }

  if (action === 'commitment-sync') {
    const commitmentId = typeof body.commitmentId === 'string' ? body.commitmentId : null
    const attioRecordId = typeof body.attioRecordId === 'string' ? body.attioRecordId : null
    const text = typeof body.text === 'string' ? body.text : null
    if (!commitmentId || !attioRecordId || !text) {
      return fail('commitmentId, attioRecordId, and text required')
    }
    const plan = planCommitmentAttioSync({
      commitment: {
        id: commitmentId,
        meetingKey: typeof body.meetingKey === 'string' ? body.meetingKey : 'meeting',
        owner: typeof body.owner === 'string' ? body.owner : 'alex',
        text,
        dueAt: typeof body.dueAt === 'number' ? body.dueAt : null,
        state: 'open',
      },
      attioRecordId,
      meetingTitle: typeof body.meetingTitle === 'string' ? body.meetingTitle : undefined,
      assigneeWorkspaceMemberId: typeof body.assigneeWorkspaceMemberId === 'string'
        ? body.assigneeWorkspaceMemberId
        : undefined,
    })
    const attioTaskId = typeof body.attioTaskId === 'string' ? body.attioTaskId : null
    const attioNoteId = typeof body.attioNoteId === 'string' ? body.attioNoteId : null
    if (attioTaskId || attioNoteId) {
      plane.stampCommitmentAttio({ commitmentId, attioTaskId, attioNoteId })
    }
    return ok({
      plan,
      stamped: Boolean(attioTaskId || attioNoteId),
      picture: plane.picture(),
      note: attioTaskId
        ? 'Attio task evidence recorded.'
        : 'Plan ready — create the Attio note/task via MCP/HTTP, then POST again with attioTaskId.',
    })
  }

  if (action === 'signal-ingest') {
    const hits = Array.isArray(body.hits) ? body.hits as ExternalSignalHit[] : []
    if (!hits.length) return fail('hits required')
    const events = externalHitsToFleetEvents(hits)
    const ingested = events.map((event) => plane.ingestEvent(event.type, event.source, event.payload))
    return ok({ ingested: ingested.length, events: ingested, picture: plane.picture() })
  }

  if (action === 'inbox-ingest') {
    const threads = Array.isArray(body.threads) ? body.threads as InboxThreadInput[] : []
    if (!threads.length) return fail('threads required')
    const { events, skipped, classified } = inboxThreadsToFleetEvents(threads)
    const ingested = events.map((event) => plane.ingestEvent(event.type, event.source, event.payload))
    const suppressed = []
    const touchWindowMs = 14 * 24 * 60 * 60 * 1000
    for (const item of classified) {
      if (item.classification !== 'outbound' || !item.toEmail) continue
      const record = plane.addSuppression({
        channel: 'email',
        key: item.toEmail,
        reason: `Recent outbound: ${item.thread.subject ?? item.thread.id}`,
        source: 'inbox',
        expiresAt: Date.now() + touchWindowMs,
      })
      suppressed.push({ email: item.toEmail, suppressionId: record.id })
    }
    return ok({
      ingested: ingested.length,
      skipped: skipped.length,
      suppressed,
      classified: classified.map((item) => ({
        id: item.thread.id,
        classification: item.classification,
        reason: item.reason,
        email: item.email,
        person: item.person,
        eventName: item.eventName,
      })),
      events: ingested,
      picture: plane.picture(),
    })
  }

  if (action === 'linkedin-ledger-ingest') {
    const events = Array.isArray(body.events) ? body.events as LinkedInLedgerEvent[] : []
    if (!events.length) return fail('events required')
    const report = ingestLinkedInLedgerEvents(events, openLinkedInLedger())
    return ok({
      ...report,
      note: 'LinkedIn harness ledger is the send verification source of truth.',
    })
  }

  if (action === 'linkedin-ledger-verify') {
    const externalRef = typeof body.externalRef === 'string' ? body.externalRef : undefined
    const identity = typeof body.identity === 'string' ? body.identity : undefined
    const prospect_key = typeof body.prospect_key === 'string' ? body.prospect_key : undefined
    const actionName = typeof body.linkedinAction === 'string' ? body.linkedinAction : undefined
    const result = verifyLinkedInSend(openLinkedInLedger(), {
      externalRef,
      identity,
      prospect_key,
      action: actionName,
    })
    return ok({ verified: result.ok, reason: result.reason, event: result.event })
  }

  if (action === 'attio-refresh') {
    const companies = Array.isArray(body.companies) ? body.companies as Array<{ recordId: string; name: string; domain?: string }> : []
    const people = Array.isArray(body.people) ? body.people as Array<{ recordId: string; name: string; email?: string; linkedinUrl?: string; companyKey?: string }> : []
    if (!companies.length && !people.length) return fail('companies or people required')
    const snapshot = upsertAttioLiveSnapshot({
      companies,
      people,
      workspace: typeof body.workspace === 'string' ? body.workspace : 'byteport',
      source: typeof body.source === 'string' ? body.source : 'attio-mcp',
    })
    return ok({
      snapshot: {
        fetchedAt: snapshot.fetchedAt,
        people: snapshot.people.length,
        companies: snapshot.companies.length,
        source: snapshot.source,
      },
      mode: createLiveAttioAdapter().mode,
    })
  }

  if (action === 'sot-seed') {
    const gmailSent = Array.isArray(body.gmailSent) ? body.gmailSent as Array<{ messageId: string; identity: string; to: string; subject?: string; at: number }> : []
    const calendarEvents = Array.isArray(body.calendarEvents) ? body.calendarEvents as Array<{ eventId: string; calendarId: string; identity: string; title: string; at: number }> : []
    if (!gmailSent.length && !calendarEvents.length) return fail('gmailSent or calendarEvents required')
    const snapshot = upsertMcpSotSnapshot({
      gmailSent,
      calendarEvents,
      source: typeof body.source === 'string' ? body.source : 'mcp',
    })
    return ok({
      snapshot: {
        fetchedAt: snapshot.fetchedAt,
        gmailSent: snapshot.gmailSent.length,
        calendarEvents: snapshot.calendarEvents.length,
        source: snapshot.source,
      },
    })
  }

  if (action === 'attio-reconcile') {
    const people = Array.isArray(body.people) ? body.people as Array<{
      recordId: string; name: string; email?: string; linkedinUrl?: string; companyKey?: string
    }> : []
    const companies = Array.isArray(body.companies) ? body.companies as Array<{
      recordId: string; name: string; domain?: string
    }> : []
    if (people.length || companies.length) {
      saveAttioLiveProof({
        verifiedAt: new Date().toISOString(),
        source: body.source === 'composio' || body.source === 'attio-http' ? body.source : 'attio-mcp',
        workspace: typeof body.workspace === 'string' ? body.workspace : 'byteport',
        people,
        companies: companies.length ? companies : (loadAttioLiveProof()?.companies ?? []),
      })
    }
    const targets = Array.isArray(body.targets)
      ? body.targets as Array<{ key: string; name: string; email?: string; company?: string; linkedinUrl?: string }>
      : [
        { key: 'person:alex', name: 'Alex Newiger', email: 'alex@byteport.com', company: 'Byteport' },
        { key: 'person:jayram', name: 'Jayram Palamadai', email: 'jayram@byteport.com', company: 'Byteport' },
      ]
    const result = await reconcileAgainstLiveAttio(targets)
    plane.recordEntities(result.entities)
    return ok({ reconcile: result, readiness: assessFleetReadiness(plane) })
  }

  if (action === 'repair') {
    plane.ensureCanonicalRegistry()
    const repaired = plane.repairStuckJobs()
    return ok({ repaired, picture: plane.picture(), stuck: plane.stuckBoard() })
  }

  if (action === 'drain') {
    if (typeof body.workerId !== 'string') return fail('workerId required')
    plane.ensureCanonicalRegistry()
    plane.repairStuckJobs()
    const { adapter } = createLiveAttioAdapter()
    const result = await runContinuousWorker(plane, body.workerId, {
      maxTicks: typeof body.ticks === 'number' ? body.ticks : 10,
      attio: adapter,
      linkedinLedger: openLinkedInLedger(),
    })
    return ok({ drain: result, picture: plane.picture() })
  }

  if (action === 'submit' || body.title || body.intent) {
    if (typeof body.title !== 'string' || typeof body.intent !== 'string' || typeof body.sourceInterface !== 'string') {
      return fail('title, intent, and sourceInterface required')
    }
    const result = plane.submitObjective({
      title: body.title,
      intent: body.intent,
      sourceInterface: body.sourceInterface,
      createdBy: typeof body.createdBy === 'string' ? body.createdBy : undefined,
      priority: body.priority as 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | undefined,
      campaignId: typeof body.campaignId === 'string' ? body.campaignId : null,
    })
    return ok({ ...result, picture: plane.status(body.title).picture })
  }

  return fail(`Unknown action: ${action}`)
}
