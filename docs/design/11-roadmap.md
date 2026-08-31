# 11 — Roadmap

**Status:** Living — phases 0–2 done, phase 3 next

Sequencing principle: ship the thin composed version fast (the market window —
[01-product.md](01-product.md)), let the long-tail generator and EKB accrete as the
moat. Every phase ends with something usable headlessly.

## Phase 0 — Spikes (de-risk before building)

- [x] Mockttp on Bun: MITM + h2 + WebSockets under Bun's node-compat. **Outcome:
  Bun fails on h2 and WebSockets; the front door runs as a Node sidecar** — decision
  and revisit criteria in [spikes/01-mockttp-bun](../../spikes/01-mockttp-bun/FINDINGS.md),
  [02-architecture.md](02-architecture.md) amended.
- [x] oRPC on Bun: OpenAPIHandler + static serving on `Bun.serve`; validate the
  contract→CLI and contract→MCP generation path (existing adapters vs. ~200-line
  walk) with two real procedures. **Outcome: 10/10 unpatched; we own the walk (161
  lines), both candidate adapters rejected** —
  [spikes/02-orpc-bun](../../spikes/02-orpc-bun/FINDINGS.md).
- [x] emulate driven as child processes: start/stop/seed Stripe + GitHub, point real
  SDKs at them, confirm OAuth flow works end-to-end. **Outcome: 7/8 — viable as a wrapped
  child process; a provider is a supervisor for N services, and emulate binds every
  interface** — [spikes/03-emulate](../../spikes/03-emulate/FINDINGS.md),
  [06-emulation.md](06-emulation.md) and [12-scenario-controls.md](12-scenario-controls.md)
  amended.
- [x] Container seal: network namespace + DNS override + baked CA; prove a raw-socket
  escape attempt fails and files a wall-hit. **Outcome: 8/8 against a negative control —
  the seal holds; DNS must be a catch-all, not an alias list; IPv6 recorded INCONCLUSIVE
  (no IPv6 egress on the test host) and must be re-run in phase 3** —
  [spikes/04-container-seal](../../spikes/04-container-seal/FINDINGS.md),
  [04-sandbox.md](04-sandbox.md) amended.
- [x] Scrubber prototype over real recorded traffic. **Outcome: 14/14 — shape must beat
  location when labelling secrets, the entropy backstop needs a hex rule as well as a
  threshold, and two capture bugs found (`.always()` on Mockttp rules,
  `NODE_USE_ENV_PROXY` for fetch-based SDKs)** —
  [spikes/05-scrubber](../../spikes/05-scrubber/FINDINGS.md),
  [10-security.md](10-security.md) and [03-capture.md](03-capture.md) amended.

## Phase 1 — The recorder & the corpus

- [x] Daemon skeleton: API v1 on `Bun.serve`, SQLite/Drizzle (12 tables, WAL, daemon
  is the only writer), project resolution per
  [08-projects-config.md](08-projects-config.md).
- [x] Front door in `record` + `passthrough` modes, driving the Node sidecar over
  Mockttp's admin-server protocol.
- [x] `mocktown record -- <cmd>` with CA + proxy env injection (including
  `NODE_USE_ENV_PROXY`, without which fetch/undici SDKs escape while appearing
  configured).
- [x] HAR import through the same scrubber and the same normalization
  ([03-capture.md](03-capture.md)), reporting what it could not use rather than
  dropping it.
- [x] Scrubbing on by default, **before disk** — scrub, then normalize, then persist.
- [x] Drizzle Studio hookup (`mocktown studio`).

**Exit criterion met:** a real app's traffic is recorded and the scrubbed corpus is
browsable — verified end-to-end through the CLI and by `tests/loop.test.ts` against a
live upstream and a live MITM proxy.

*Amendments produced:* the admin-server protocol's subscription and event-ordering rules
([03-capture.md](03-capture.md)), `source` threading through the surfaces
([08-projects-config.md](08-projects-config.md)), Studio's Node SQLite driver
([09-gui-plugins.md](09-gui-plugins.md)).

## Phase 2 — Mock serving & the agent loop (the product becomes real)

- [x] Provider interface — a supervisor for N services, returning `service → baseUrl`.
- [x] emulate provider for the famous services, on a contiguous port run, with the
  startup banner treated as noise and readiness established by probing.
- [x] **Generated-mock pipeline v1**: agent skill + corpus export (variety-preferring
  examples, stateful hints) + replay-verify harness that compares status class and
  response *shape*, never values ([06-emulation.md](06-emulation.md)).
- [x] Issue engine with the full taxonomy, deduping on
  type/service/method/pathTemplate, reopening rather than re-filing, and materializing
  the open queue as files ([07-issues-agent-loop.md](07-issues-agent-loop.md)).
- [x] MCP server over stdio, generated from the same contract walk.
- [x] `mocktown env` generator + EKB seeded from the emulate recipes, honest about the
  services it cannot cover mechanically ([05-redirection.md](05-redirection.md)).
- [x] **Auth profiles + seed/reset + knob manifests**
  ([12-scenario-controls.md](12-scenario-controls.md)).

**Exit criterion met:** the loop closes — an unseen request is denied loudly, filed as an
`unknown-service` issue with the triggering request attached, resolved by pointing the
service at a provider, and the mock verified against the corpus by replay.

*Amendments produced:* `mock` routing is host-preserving pass-through plus a scheme
rewrite ([06-emulation.md](06-emulation.md)); `readOnlyHint`-follows-method makes a
mutating `GET` a contract defect, and renderer coverage joins the structurally-enforced
house rules ([02-architecture.md](02-architecture.md)).

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
