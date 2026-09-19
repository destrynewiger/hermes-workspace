---
name: fleet-os
description: Shared GTM control plane protocol so Hermes, GrokBot, Muse, Codex, Claude Code, and Gemini Spark read and write the same objectives, jobs, and identities. Use when the user issues a GTM objective, asks where a campaign is, or work must continue across agents without re-prompting.
---

# Fleet OS

Agents are interfaces and workers. The control plane owns state.

Runtime: `packages/fleet-os` in this repo (canonical copy while hermes-workspace push is gated). HTTP when Workspace is deployed: `/api/fleet-os`. Full architecture: [`packages/fleet-os/ARCHITECTURE.md`](../../../packages/fleet-os/ARCHITECTURE.md).

## Do this in order

1. Resolve existing state with `GET /api/fleet-os?q=<objective words>` before creating anything.
2. Submit or resume with `POST /api/fleet-os` `{ "title", "intent", "sourceInterface" }`. Same title resumes the same objective.
3. Heartbeat, then `claim` jobs. Do not pick a machine by habit. Identity is a routing constraint.
4. Execute only what autonomy allows. Internal research runs. LinkedIn/email sends stay draft unless the identity lane is live.
5. Complete with evidence. If an external effect cannot be verified, leave the job in verifying.
6. Claim the next job. Prefer `runContinuousWorker` / `pnpm fleet-worker --worker <id>` so authorized work keeps draining. Do not ask whether to continue when the next step is authorized.
7. Answer status questions from shared state, not from this chat. Same title resumes even after completion.
8. For Alex natural-language commands, use `executeExecutiveCommand` / `pnpm fleet-cmd --interface hermes "<text>"` so every interface hits the same parser.
9. Luma webhooks: `POST /api/fleet-os` `{ "action": "luma", "body": <luma json> }` — normalizes RSVPs into campaign progress without Alex pasting counts.
10. Agentic-os hosts: `POST /api/fleet-os` `{ "action": "agentic-outbox" }` then `pnpm fleet-sync-ledger` (or point `FLEET_LEDGER_PATH` at the Mac Mini ledger) to append into SQLite WAL.
11. Tailscale hosts: `pnpm fleet-advertise --machine oakland-mini` (or sf-mini / backup-mini / destrys-hp) so capability/identity routing stays live.
12. Control plane host: `pnpm fleet-server --port 8787` then set `FLEET_OS_URL=http://<host>:8787` on workers.
13. Bootstrap: `./scripts/bootstrap-fleet-host.sh <machine-id>` installs LaunchAgent/daemon + `.env`.
14. Gmail Sent / Calendar: external `email.send` and `calendar.create` stay `verifying` until the proof store has the messageId/eventId. Duplicate sends to the same person/event are suppressed. Seed proofs with `POST { "action": "sot-seed" }` or `pnpm fleet-refresh-sot`.
15. Dead letters: `POST { "action": "reclaim", "jobId": "..." }` returns exhausted jobs to the queue. `POST { "action": "session-health" }` lists identities that cannot send.
16. Production readiness: `POST { "action": "readiness" }` reports DoD blockers. Live Attio SoT is satisfied by `ATTIO_API_KEY` **or** a fresh Composio/MCP proof (`attio-proof`). Tailscale still requires `FLEET_TAILSCALE_MESH=1` from host bootstrap/wizard.
17. Host cutover: `./scripts/fleet-host-wizard.sh` on each Mac Mini (Attio key + Tailscale + advertise). Oakland host is `alex-mac-mini-1`. Migration plan: `POST { "action": "migration-plan" }`. Account signals: `POST { "action": "duo-ingest", "leads": [...] }` or `POST { "action": "signal-ingest", source: "research" }`. Sumble API is unpaid; `sumble-ingest` is a deprecated alias.
18. Stuck repair: `POST { "action": "repair" }` requeues identity-less drafts onto `alex-gmail` and completes meeting-key Attio verifies. Drain and process load do this automatically.
20. Stuck motions: `Why aren't we getting meetings?` Dead letters, blocked jobs, unverified sends. Cost: `What did inference cost?`


## Never

- Maintain a private copy of a campaign.
- Send as Katherine from a worker that does not host Katherine's session.
- Cross Rootly / Byteport / Gradient principals.
- Treat attempted as completed.
- Escalate "would you like me to continue?"
- Invent Attio record IDs — reconcile against live/seeded CRM ids (Byteport company `8fc484a3-…`, Alex `6a89dc7a-…`).
