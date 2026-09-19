# Fleet OS — Autonomous GTM & Executive Control Plane

Agents are interfaces and workers. This control plane owns shared operational state.

Attio remains the GTM source of truth for people, companies, and campaign activity. Fleet OS stores workflow, job, lease, identity, and evidence state so Hermes, GrokBot, Muse, Codex, Claude Code, and Gemini Spark can continue each other's work.

This document is the current-state audit, target architecture, and migration sequence. The pushable runtime in this repo is `packages/fleet-os`. The same module also lives in `hermes-workspace` at `src/server/fleet-os/` (this cloud token cannot push that repo).
