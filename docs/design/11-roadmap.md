# 11 — Roadmap

**Status:** Living — phases 0–3 done, phase 4 next

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

- [x] Sandbox image + devcontainer feature ([04-sandbox.md](04-sandbox.md)) — both ship;
  the image is generated per project so it trusts that project's CA and nothing else, and
  the feature carries the same certificate as an option into someone else's devcontainer.
- [x] Sealed and record modes over one boundary, with the front door left on the host and
  reached through a relay, so a sandboxed request lands in the same corpus, issue queue and
  providers as a recorded child process.
- [x] In-sandbox Chromium, reachable by Playwright and Puppeteer through the executable-path
  variables they already read.
- [x] Seal certification + `mocktown seal verify` for CI
  ([05-redirection.md](05-redirection.md)), reporting `unverifiable` rather than a false
  pass when the instrument is missing.
- [x] `mocktown sandbox verify` — spike 04's escape attempts and its negative control,
  shipped as a command so the guarantee is checkable on the user's own host.
- [x] Launched-browser interceptor for host web dev, trusting one public key for one
  window instead of touching a trust store.

**Exit criterion met:** `tests/sandbox.test.ts` runs a mock service and a flow inside the
boundary against a real container engine — unmodified code reaches the mock with TLS
verified, an escape attempt is denied and filed, the escape attempts fail against a
negative control that proves they work unsealed, and `seal verify` stamps a pass and
refuses one when a flow reaches an unregistered dependency.

*Amendments produced:* the front door stays on the host and the sandbox reaches it through
a relay ([04-sandbox.md](04-sandbox.md)); a seal run happens inside the sandbox or is
reported `unverifiable`, and redirect coverage is judged from the EKB rather than from wall
hits ([05-redirection.md](05-redirection.md)); browser trust is one key for one launch
([03-capture.md](03-capture.md)); `ok: false` in a response is a structural non-zero exit
([02-architecture.md](02-architecture.md)). IPv6 is still INCONCLUSIVE — the check now
ships, and the development host has no IPv6 egress to prove it against.

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
