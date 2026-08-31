# 11 — Roadmap

**Status:** Draft

Sequencing principle: ship the thin composed version fast (the market window —
[01-product.md](01-product.md)), let the long-tail generator and EKB accrete as the
moat. Every phase ends with something usable headlessly.

## Phase 0 — Spikes (de-risk before building)

- [ ] Mockttp on Bun: MITM + h2 + WebSockets under Bun's node-compat. Fallback
  decision (Node sidecar) made here, not later.
- [ ] emulate driven as child processes: start/stop/seed Stripe + GitHub, point real
  SDKs at them, confirm OAuth flow works end-to-end.
- [ ] Container seal: network namespace + DNS override + baked CA; prove a raw-socket
  escape attempt fails and files a wall-hit.
- [ ] Scrubber prototype over real recorded traffic from one of our own apps.

## Phase 1 — The recorder & the corpus

Daemon skeleton (API v1, SQLite/Drizzle, project resolution per
[08-projects-config.md](08-projects-config.md)) · front door in `record` +
`passthrough` modes · `mocktown record -- <cmd>` with CA env injection · HAR import
([03-capture.md](03-capture.md)) · scrubbing on by default · Drizzle Studio hookup. **Exit criterion:** record a real app's traffic,
browse the scrubbed corpus.

## Phase 2 — Mock serving & the agent loop (the product becomes real)

Provider interface · emulate providers for famous services · **generated-mock
pipeline v1**: agent skill + corpus export + replay-verify harness
([06-emulation.md](06-emulation.md)) · issue engine with the full taxonomy
([07-issues-agent-loop.md](07-issues-agent-loop.md)) · MCP server · `mocktown env`
generator + EKB seeded from emulate skills. **Exit criterion:** the loop closes —
unseen request → issue → agent patch → verified replay — on a real project.

## Phase 3 — The seal & the sandbox

Sandbox image + devcontainer feature ([04-sandbox.md](04-sandbox.md)) · sealed and
record modes · in-sandbox Chromium · seal certification + `mocktown seal verify` for
CI ([05-redirection.md](05-redirection.md)) · launched-browser interceptor for host
web dev. **Exit criterion:** an unattended coding agent runs a web app's integration
flows inside the sandbox with zero real egress, and CI enforces the seal.

## Phase 4 — Surface polish

GUI shell (dashboard, live feed, issues) · panels model
([09-gui-plugins.md](09-gui-plugins.md)) · state introspection across providers ·
drift watch (scheduled re-record + `provider-drift` issues) · WebSocket/gRPC mocking
per [03-capture.md](03-capture.md) deferred list · portless integration for host mode.

## Deliberately unscheduled

Team/cloud sync of projects, hosted sandboxes, panel marketplace, mobile capture,
**OS-level transparent capture** (deferred with explicit revisit criteria in
[03-capture.md](03-capture.md) — capturing apps the user can't launch themselves) —
revisit only with real usage evidence.
