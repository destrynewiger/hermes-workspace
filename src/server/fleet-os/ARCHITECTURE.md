# Fleet OS — Autonomous GTM & Executive Control Plane

Agents are interfaces and workers. This control plane owns shared operational state.

Attio remains the GTM source of truth for people, companies, and campaign activity. Fleet OS stores workflow, job, lease, identity, and evidence state so Hermes, GrokBot, Muse, Codex, Claude Code, and Gemini Spark can continue each other's work.

This document is the current-state audit, target architecture, and migration sequence. The pushable runtime in this repo is `packages/fleet-os`. The same module also lives in `hermes-workspace` at `src/server/fleet-os/` (this cloud token cannot push that repo).

## 1. Current-state architecture

What exists today, and what actually owns each responsibility:

| Responsibility | Canonical owner today | Notes |
|---|---|---|
| Local work kernel, mandates, evidence, SQLite event ledger | `agentic-os` | Do not replace. This cloud run cannot push that private repo. |
| Durable knowledge | Obsidian / `ai-memory-vault` | Human-readable memory, not the workforce queue. |
| Hermes swarm dispatch, tmux workers, kanban JSON | `hermes-workspace` | Session-local swarm, not GTM identity routing. |
| LinkedIn send chain (intent→identity→session→copy→cadence→stage→ledger) | `destrynewiger` skill `linkedin-outreach-harness` | Contract only; no shared runtime. |
| GTM copy rules | `rootly-codex-brain` / `byteport-hermes/knowledge` | Personas and prohibited claims. |
| GTM UI companion | `gtm-command-center` | Dashboard, not orchestrator (see agentic-os ADR 0003). |
| Remote LinkedIn session host | GrokBot (xAI Linux VMs, not in this workspace) | Identity attach lives off-repo. |
| Buzz | Identity firewall / Chrome profile boundary | Not cloned here. |
| `unlazy` | External Leonxlnx skill, not present in clones | Behavior must be native, not a prompt Alex invokes. |

Nothing today is a single objective store that every interface reads and writes. Swarm kanban, agentic-os Work Items, Attio, and vault notes are parallel truths.

## 2. Fleet map

Hardware (Tailscale mesh `tail1b1137.ts.net`; Oakland is the intended hub):

| Machine | Role | Tailscale | Typical identities / models |
|---|---|---|---|
| Oakland Mac Mini (`oakland-mini`) | Coordination + local Ollama | `alex-mac-mini-1` (alias `alexs-mac-mini`) / `100.118.142.13` | Alex Byteport, Gmail, Calendar, John/Gradient, Hermes, Codex |
| Alex SF Mac Mini (`sf-mini`) | Authenticated browser sessions | `alex-agent-mini` / `100.106.243.19` | Alex / Katherine LinkedIn |
| Backup Byteport Mac Mini (`backup-mini`) | Failover research / GrokBot + Katherine LinkedIn | last-known `100.90.155.111` (probe only; not live until Oakland ping/netmap) | Katherine Byteport failover |
| DestrysHP (`destrys-hp`) | Coding / overflow | confirm IP on bootstrap | Offline unless heartbeating |
| Alex MacBook Pro | Personal (same tailnet) | `alexs-macbook-pro` / `100.73.203.75` | Not a required worker |
| GrokBot VMs | Coworker LinkedIn attach | off-repo | Jayram, Will, Laksh, Maggie (needs_attach) |

Canonical inventory: `fleet-mesh.ts`. Probe from a tailnet host: `pnpm fleet-mesh-probe --json`. Cloud VMs cannot see `100.x` addresses without Tailscale.

Workers: Hermes, GrokBot, Muse, Codex, Claude Code, Gemini Spark, local processes, APIs.

Integrations: Attio (SoT), Gmail, Calendar, Slack, Telegram, LinkedIn, X, Amplemarket Duo, page/Google research, Apollo, Common Room, Luma, Granola, Google Trends, GitHub, Tailscale. Sumble API is unpaid and retired.

Seeded identity registry in code matches the LinkedIn harness principals (`byteport`, `rootly`, `gradient`) and never crosses them.

## 3. Gap analysis

The fleet is not one system because:

1. **No shared objective store.** Hermes and GrokBot cannot answer "where are we on Toronto?" from the same state.
2. **No fleet protocol.** Machines do not heartbeat capabilities, identities, models, and load into one registry.
3. **No job leases.** A crashed worker drops work or risks double-sends.
4. **Identity is not a routing constraint in runtime.** LinkedIn work can land on whichever agent Alex pinged.
5. **Model routing is per product.** Agentic OS has local model probes; Hermes has provider settings; nothing implements deterministic → local/free → cheap cloud → frontier with 429 failover.
6. **`unlazy` is a skill, not infrastructure.** Agents idle when a prompt ends.
7. **Verification is optional.** Adapter contract in agentic-os has evidence-before-completion; GTM outbound does not use it yet.
8. **Attio is not wired as the duplicate-prevention gate** for fleet jobs.

## 4. Target architecture

```text
Interfaces (Hermes, GrokBot, Muse, Codex, Claude Code, Gemini Spark, Slack, Telegram)
        │
        ▼
Control plane  — objectives, workflows, jobs, attempts, results, next actions
        │
   ┌────┼───────────────┐
   ▼    ▼               ▼
Event bus   Durable queue   State store
   │            │               │
   ▼            ▼               ▼
Dispatcher: job → worker → machine → identity → model
   │
   ├─ Policy / autonomy (action class 0–4)
   ├─ Verification (planned → attempted → verified)
   └─ Observability (picture, not logs)
```

Canonical schemas live in `src/server/fleet-os/types.ts`. HTTP protocol: `GET/POST /api/fleet-os`.

## 5. Reuse / deprecate / build

| Stay | Consolidate into Fleet OS | Do not build |
|---|---|---|
| agentic-os ledger, mandates, adapters | Objective/job/lease protocol (this repo, later mirrored into agentic-os) | A new dashboard that becomes another SoT |
| Attio as GTM SoT | Identity registry from `harness.yaml` | A second CRM |
| LinkedIn send chain skill | Native unlazy (claim-next after completion) | A new LinkedIn scraper |
| Hermes swarm for coding missions | Capability + identity dispatch | Hardcoded "LinkedIn = Hermes" |
| Obsidian vault | Operational JSON/SQLite state | Isolated per-agent memory of campaigns |

Deprecate: asking Alex to "keep going"; per-agent Toronto notes; treating swarm kanban as GTM campaign state.

## 6. Canonical schemas

See `types.ts`: `Objective`, `Workflow`, `Job`, `Attempt`, `Event`, `Machine`, `Worker`, `Identity`, `Model`, `Entity`, `Approval`, `Cost`.

Job states: `queued → leased → running → verifying → completed` with `failed`, `blocked`, `dead_letter`.

Idempotency key is required on every job. Duplicate keys do not create duplicate external work.

## 7. Cross-agent protocol

Every interface:

1. `POST /api/fleet-os` `{ title, intent, sourceInterface }` — create or resume the same objective.
2. `GET /api/fleet-os?q=Toronto` — shared picture.
3. `POST` `{ action: "heartbeat", workerId }` — advertise liveness.
4. `POST` `{ action: "claim", workerId }` — pull the next eligible job.
5. `POST` `{ action: "complete" | "fail" | "event" }` — evidence and failover.

If Hermes recorded Toronto, GrokBot's submit with the same title resumes that objective id. Workers do not keep a private copy.

## 8. Continuous-work architecture (unlazy, native)

`unlazy` (not in-tree) is effective because it: checks remaining work, expects a next action, reverifies completion, and refuses to stop while authorized work exists.

Native equivalents:

- After `completeJob`, `continueObjective` updates the picture and enqueues implied next jobs (e.g. multi-cloud research).
- Healthy workers call `claimNext` instead of exiting.
- Priority drain: P0 → P4, including bounded background work only when higher queues are empty (background kinds must still be explicit jobs).
- Never ask "would you like me to continue?" when the next step is authorized.

## 9. Model-routing architecture

`model-router.ts`:

0. Deterministic code (`attio.lookup`, cadence, dedupe, lease expiry).
1. Local/free: Ollama, Hermes/Nous free, OpenRouter free.
2. Inexpensive cloud.
3. Frontier for outbound copy, executive synthesis, architecture, ambiguous decisions.

A 429/credits/unavailable error marks the model unavailable and requeues the job onto the next capable model. Production workflows must not die on one provider.

## 10. Implementation sequence

1. Audit (this document + seeded registries).
2. Canonical state + HTTP protocol in hermes-workspace (**this PR**).
3. Mirror the protocol into agentic-os when that repo is writable.
4. Live heartbeats from Oakland / SF / Backup / GrokBot.
5. Wire Attio reconcile as a real adapter (read-only first).
6. Verification adapters for Gmail sent, calendar, LinkedIn stage ledger.
7. Event campaign object for dinners (Luma + RSVP).
8. Executive command surfaces on every interface.

## 11. First end-to-end workflow

**signal → research → Attio reconcile → identity-aware LinkedIn draft.**

Implemented in-process by `runSignalToDraftLoop`. External sends stay Level 2 (draft + approval). That is the smallest loop that proves shared state, identity routing, and unlazy continuation without risking live LinkedIn.

## 12. Reliability and observability

| Failure | Handling |
|---|---|
| Worker crash | Lease expires, job returns to queue, another eligible worker claims it |
| Machine offline | Dispatcher skips it; Backup Mini can steal research jobs, not Katherine's session |
| Provider 429 | Model marked unavailable; job requeued with fallback |
| Session expired | Autonomy blocks send; approval/login ticket, no identity swap |
| Duplicate retry | Idempotency key |
| Coordinator restart | State file survives; new process reloads objectives |
| Stuck workflow | `dead_letter` after max attempts; picture names the decision |
| External action | `verifying` until evidence.verified; Gmail Sent / Calendar lookups required for `email.send` / `calendar.create` |
| Dead letter | `reclaimDeadLetters` / HTTP `action: reclaim` returns the job to `queued` with extra attempts |
| Duplicate email/calendar | Same identity+recipient or identity+title is suppressed against the proof store |

`picture()` is the operator view: active objectives, running/queued jobs, human decisions. Not cron logs.

## 13. Cost model

Track `CostRecord` by workflow, job, provider, model, machine, task type, success.

Default spend: deterministic + Ollama/OpenRouter free for classify/extract/triage. Frontier only for copy and judgments that change external outcomes. Goal is completed useful work per dollar, not minimum tokens.

## 14. Migration plan

1. New objectives go through Fleet OS immediately (safe: no live sends).
2. Keep existing LinkedIn runners and Attio workflows as adapters.
3. Swarm kanban stays for coding missions; GTM campaigns do not move there.
4. agentic-os remains the Mac kernel; Fleet OS is the cross-agent GTM protocol until the ledger can host it.
5. Cut over live sends only after verification adapters and identity heartbeats are real.
6. **Account signal wrap (gtm-command-center):** after each run, Duo leads POST `{ action: "duo-ingest" }` and page/Google findings POST `{ action: "signal-ingest", source: "research" }` to `FLEET_OS_URL` (opt-out `FLEET_OS_INGEST=0`). Paid Sumble API is retired; `sumble-ingest` is a deprecated alias. Private SQLite stays; Fleet OS gets the shared signal events.
7. **Daily brief wrap (byteport-hermes):** `reportDailyBriefToFleet` emits `{ action: "event", type: "job.completed", source: "byteport-hermes" }` so other agents see briefing progress in the shared picture.
8. See `migration.ts` / `POST { action: "migration-plan" }` for the reuse/wrap/deprecate inventory.

## 15. What this PR builds

- Durable JSON state store (`FLEET_OS_HOME` for tests).
- Objective resume across interfaces, including status queries after completion.
- Capability + identity dispatcher.
- Leases, work stealing, model failover.
- Native continuous worker loop (`runContinuousWorker` / `runFleetUntilIdle`) — unlazy behavior without a prompt.
- Attio reconcile adapter (memory now; `HttpAttioAdapter` when `ATTIO_API_KEY` is set; writes gated by `ATTIO_ALLOW_WRITES=1`).
- Meeting lifecycle: `calendar.external_meeting_soon` → brief → Granola transcript → commitments → follow-up drafts.
- Event campaigns with RSVP gap tracking and decision-shaped status (`8/20 RSVPs. Decision: …`).
- LinkedIn send verification against the outreach harness ledger; draft-only lanes create approvals instead of sending.
- Executive command layer: `executeExecutiveCommand` / `pnpm fleet-cmd` so Hermes, GrokBot, Muse, Codex, Claude Code, Gemini Spark, and Slack share one intent parser.
- Signal engine: normalize Amplemarket Duo / page-view / Google research / inbox into strength-scored signals that enqueue research or drafts.
- Full GTM loop helper: signal → Attio → draft → reply → meeting → Granola → commitments → failover → cross-agent status.
- Attio bridge: HTTP when keyed, otherwise memory/seeded from live CRM hits (Byteport record verified via Attio MCP).
- Luma RSVP webhook normalizer (`normalizeLumaWebhook`) + campaign resolution by event name/geography when `campaignId` is absent.
- Agentic-os ledger protocol bridge (`buildAgenticOutbox` / `ledgerEventsFromOutbox`) so Mac hosts can append Fleet OS state into the SQLite WAL without a second SoT.
- Live Attio helpers (`createLiveAttioAdapter`, `reconcileAgainstLiveAttio`) binding reconcile to real Attio record IDs.
- Heartbeat TTL / `expireStaleHeartbeats` / `fleetHealth` so silent machines drop offline and release leases; DestrysHP seeded in the machine roster.
- Campaign `contacted` counts outreach jobs only (research volume no longer inflates progress).
- Agentic-os SQLite ledger appender (`appendOutboxToLedger` / `pnpm fleet-sync-ledger`) — same WAL schema as agentic-os event-ledger; idempotent by eventId.
- Continuous machine advertise CLI (`pnpm fleet-advertise --machine oakland-mini`) for Tailscale hosts (local state or `FLEET_OS_URL`).
- Attio key resolver checks `ATTIO_API_KEY` / `FLEET_ATTIO_API_KEY` and common hermes `.env` files; live Alex person id `6a89dc7a-…` verified via MCP.
- Host bootstrap (`scripts/bootstrap-fleet-host.sh`) writes LaunchAgent/daemon + `.env` for advertise + ledger sync on each Tailscale machine.
- Env-driven model pool (`discoverModelPool`) so free/local providers register automatically with frontier available when keys exist.
- Durable Attio live snapshot (`data/attio-live-snapshot.json`) refreshed from Attio MCP with Byteport company + team people; used when HTTP key is absent.
- Multi-host continuity sim (`runMultiHostContinuitySim`): Oakland Hermes and Backup GrokBot share one FleetStore file + ledger.
- Optional auto ledger sync from continuous workers when `FLEET_LEDGER_PATH` / `FLEET_AUTO_SYNC_LEDGER=1` is set.
- Standalone HTTP control plane (`pnpm fleet-server`, default `:8787`) + `runHttpFleetE2E` proving advertise/command/drain/luma/ledger over the wire — the same protocol Tailscale hosts use via `FLEET_OS_URL`.
- Process singleton (`getFleetPlane`) so `/api/fleet-os` does not drop objectives between requests; durable `state.json` survives process restart.
- Session health: live LinkedIn/email sends fail closed when the identity session is `needs_login` / locked / unknown. HTTP `session-health` lists unhealthy identities.
- Gmail Sent + Google Calendar verification stores (`sot-verify.ts`): `email.send` / `calendar.create` are unverified until messageId/eventId exists; duplicate recipient/title is suppressed.
- MCP SoT cache (`data/mcp-sot-snapshot.json`) refreshed from live Gmail Sent + Calendar; `sot-seed` / `fleet-refresh-sot --prove` verifies real message and event ids.
- Dead-letter reclaim (`reclaimDeadLetters` / HTTP `action: reclaim`) so exhausted jobs re-enter the queue instead of disappearing.
- `alex-gmail` and `alex-calendar` identities on Oakland; calendar creates require approval unless the lane is live, same as sends.
- Fleet readiness (`assessFleetReadiness` / HTTP `action: readiness`) fails closed until live Attio SoT (HTTP key **or** fresh Composio/MCP proof) and `FLEET_TAILSCALE_MESH=1` are proven — seeded workers alone do not count.
- Live Attio proof via Composio (`data/attio-composio-proof.json`, HTTP `attio-proof`) verifying production record IDs without shipping secrets.
- Migration inventory (`migration.ts` / HTTP `migration-plan`, `duo-ingest`, deprecated `sumble-ingest`) wrapping the Duo + page/Google research monitor, daily-brief, LinkedIn harness, and agentic-os ledger instead of rebuilding them.
- Command `Follow up on everything I promised this week` reads the promise board instead of creating a second follow-through objective. Attention answers lead with Alex-owned open promises.
- `Why aren't we getting meetings?` reports dead letters, blocked identity/session jobs, and unverified sends. `What did inference cost?` rolls up recorded spend by provider. `picture()` includes both.
- Stuck-job repair (`repairStuckJobs` / HTTP `action: repair`, also on drain and process load): email drafts without a sender get `alex-gmail`; meeting-key Attio reconciles skip fake CRM verifies; objectives with leftover queued work (for example Katherine LinkedIn drafts) are reopened instead of reporting complete. Durable state heals on `getFleetPlane()` instead of waiting for Alex.
- Attio task ingest (`POST attio-task-ingest`): open CRM tasks become shared commitments. A human decision that names an existing objective (Toronto date lock) reopens that objective and blocks on the decision instead of reporting the synthetic loop complete.
- Calendar ingest (`POST calendar-ingest`) turns Google Calendar events with external attendees into `calendar.external_meeting_soon` → `meeting.brief` jobs.
- Commitment sync (`commitment-sync.ts` / `POST commitment-sync` / job `attio.commitment_sync`) plans Attio notes+tasks and stamps live task/note IDs so meeting promises land in CRM.
- Signal ingest (`POST signal-ingest`) normalizes Amplemarket Duo / Apollo / Common Room hits into `signal.detected` events.
- Inbox ingest (`POST inbox-ingest`) classifies Gmail/Unibox threads: OOO and newsletters are discarded; prospect replies become `inbox.reply`; Luma waitlist emails become `luma.rsvp`.
- LinkedIn harness.yaml identities are imported into the registry (Jayram/Will/Laksh/Maggie/Alex Rootly/John). `POST linkedin-ledger-ingest` / `linkedin-ledger-verify` use the outreach ledger as the send verification SoT.
- Suppression (`suppression.ts`): internal domains and recent outbound recipients are not sent again. `claimNext` completes those jobs as suppressed instead of asking for approval. Unmatched Luma event names open a campaign-define job.
- Fleet mesh inventory (`fleet-mesh.ts` / `pnpm fleet-mesh-probe` / HTTP `mesh-inventory`) encodes Tailscale IPs for Oakland (`100.118.142.13`) and SF (`100.106.243.19`).
- Host cutover wizard (`scripts/fleet-host-wizard.sh`) for Attio key + Tailscale + bootstrap on Oakland/SF/Backup/DestrysHP.
- Live Attio refresh/reconcile HTTP (`attio-refresh`, `attio-reconcile`) binding production record IDs (Byteport company `8fc484a3-…`, Alex `6a89dc7a-…`).
- Identity map linking Attio live people (Alex/Jayram/…) to fleet sender identities.
- Cost recording per completed model-backed job.
- `fleet-worker` CLI for machines (`pnpm fleet-worker --worker hermes-oakland`).
- Agent skill `.claude/skills/fleet-os`.
- HTTP `/api/fleet-os` in hermes-workspace (local clone; GitHub push currently 403) with advertise/command/luma/agentic-outbox actions.
- Tests for Toronto cross-agent loop, continuous drain, Attio dedupe, verification, failover, Luma RSVPs, ledger outbox, and ledger idempotent append.

Not yet production-complete: live Tailscale processes running `fleet-advertise` / `fleet-host-wizard.sh` on Oakland/SF/Backup/DestrysHP with `FLEET_TAILSCALE_MESH=1`, installing `ATTIO_API_KEY` on those workers for offline HTTP (cloud path already proven via Composio live find + MCP snapshot), pointing `FLEET_LEDGER_PATH` at the Mac Mini agentic-os ledger file, and hermes-workspace GitHub push. Ask `POST { "action": "readiness" }` for the current blocker list. Those are next milestones on the same contracts, not a second architecture.
