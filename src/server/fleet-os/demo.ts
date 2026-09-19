import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  createTestPlane,
  runSignalToDraftLoop,
  runMeetingLifecycleLoop,
  runLinkedInVerifyLoop,
  runFullGtmLoop,
} from './gtm-loop'
import { executeExecutiveCommand } from './executive'
import { normalizeLumaWebhook } from './luma-webhook'
import { buildAgenticOutbox } from './agentic-bridge'
import { appendOutboxToLedger, verifyLedgerIdempotency } from './agentic-ledger'
import { reconcileAgainstLiveAttio, BYTEPORT_LIVE_COMPANY, BYTEPORT_LIVE_ALEX } from './attio-live'
import { loadAttioLiveSnapshot } from './attio-cache'
import { runMultiHostContinuitySim } from './multi-host-sim'
import { runHttpFleetE2E } from './http-e2e'
import { buildIdentityMap } from './identity-map'
import { FLEET_MACHINE_SEEDS } from './heartbeat'

const plane = createTestPlane(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-demo-')))
const toronto = await runSignalToDraftLoop(plane)
const meetingPlane = createTestPlane(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-meet-')))
const meeting = await runMeetingLifecycleLoop(meetingPlane)
const linkedinPlane = createTestPlane(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-li-')))
const linkedin = await runLinkedInVerifyLoop(linkedinPlane)
const fullPlane = createTestPlane(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-full-')))
const full = await runFullGtmLoop(fullPlane, {
  liveCompanies: [BYTEPORT_LIVE_COMPANY],
})
const attention = executeExecutiveCommand(fullPlane, 'What needs my attention today?', 'slack')

const luma = normalizeLumaWebhook({
  type: 'guest.approved',
  data: {
    event: { name: 'Toronto dinner', api_id: 'evt_demo' },
    guest: { email: 'leader@infra.example', name: 'Infra Leader', status: 'approved' },
  },
})
if (luma) fullPlane.ingestEvent(luma.type, luma.source, luma.payload)

const liveAttio = await reconcileAgainstLiveAttio(
  [{ key: 'person:alex', name: 'Alex Newiger', email: 'alex@byteport.com' }],
  {
    companies: [BYTEPORT_LIVE_COMPANY],
    people: [BYTEPORT_LIVE_ALEX],
  },
)
const outbox = buildAgenticOutbox({
  objectives: fullPlane.snapshot().objectives,
  events: fullPlane.snapshot().events,
  jobs: fullPlane.snapshot().jobs,
  attempts: fullPlane.snapshot().attempts,
})
const ledgerFile = path.join(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-ledger-')), 'agentic-ledger.sqlite')
const ledgerSync = verifyLedgerIdempotency(outbox, ledgerFile)

const advertisePlane = createTestPlane(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-adv-')))
for (const seed of FLEET_MACHINE_SEEDS) {
  advertisePlane.applyMachineAdvertisement({ ...seed, at: Date.now() })
}
const health = advertisePlane.fleetHealth()
const snapshot = loadAttioLiveSnapshot()
const multiHost = await runMultiHostContinuitySim(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-multi-')))
const httpE2E = await runHttpFleetE2E(mkdtempSync(path.join(os.tmpdir(), 'fleet-os-http-')))
const identities = buildIdentityMap()

process.stdout.write(JSON.stringify({
  toronto: {
    hermesObjectiveId: toronto.objectiveId,
    grokbotSeesSameObjective: toronto.sameObjective,
    picture: toronto.status.picture,
    campaign: toronto.campaign,
  },
  meeting: {
    picture: meeting.status.picture,
    commitments: meeting.commitments.map((item) => ({ owner: item.owner, text: item.text, state: item.state })),
  },
  linkedin: {
    sendState: linkedin.send?.state,
    verified: linkedin.send?.evidence.some((item) => item.verified) ?? false,
  },
  fullLoop: {
    attioModeUsed: full.attioModeUsed,
    grokSameObjective: full.grokSameObjective,
    torontoPicture: full.toronto.picture,
    campaign: full.campaign,
    commitments: full.commitments.length,
    failoverRecovered: full.failover?.recovered ?? false,
    attention: attention.picture,
    eventTypes: full.eventTypes,
  },
  liveAttio: {
    mode: liveAttio.mode,
    verified: liveAttio.verified,
    attioIds: liveAttio.attioIds,
    alexRecordId: BYTEPORT_LIVE_ALEX.recordId,
    snapshotPeople: snapshot?.people.length ?? 0,
    snapshotSource: snapshot?.source ?? null,
  },
  lumaRsvp: fullPlane.campaignStatus('Toronto'),
  agenticOutbox: {
    entries: outbox.length,
    types: [...new Set(outbox.map((entry) => entry.type))].slice(0, 12),
  },
  ledgerSync: {
    filename: ledgerSync.first.filename,
    inserted: ledgerSync.first.inserted,
    reappendSkipped: ledgerSync.second.skipped,
    latestSequence: ledgerSync.first.latestSequence,
    idempotent: ledgerSync.second.inserted === 0 && ledgerSync.second.skipped === ledgerSync.first.attempted,
  },
  fleetAdvertise: {
    machines: health.onlineMachines,
    workers: health.onlineWorkers.length,
  },
  multiHost: {
    grokSameObjective: multiHost.grokSameObjective,
    oaklandOffline: multiHost.oaklandOffline,
    grokOnline: multiHost.grokOnline,
    jobsCompleted: multiHost.jobsCompleted,
    ledgerGrew: multiHost.ledger.grewOrStable,
    ledgerSequence: multiHost.ledger.afterBackup?.latestSequence ?? null,
  },
  httpFleet: {
    grokSameObjective: httpE2E.grokSameObjective,
    oaklandDrained: httpE2E.oaklandDrained,
    backupDrained: httpE2E.backupDrained,
    oaklandOffline: httpE2E.health.oaklandOffline,
    lumaCampaign: httpE2E.lumaCampaign,
    ledgerInserted: httpE2E.ledgerInserted,
    onlineMachines: httpE2E.health.onlineMachines,
  },
  identityMap: identities.map((link) => ({
    teammate: link.teammate,
    email: link.email,
    attioId: link.attioId,
    fleetIdentityId: link.fleetIdentityId,
    principal: link.principal,
  })),
}, null, 2) + '\n')
