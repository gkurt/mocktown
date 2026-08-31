# 06 — Emulation: Providers, emulate, and the Long-Tail Generator

**Status:** Draft

A **provider** is anything that can serve a mocked service behind the front door.
The provider interface is the seam that keeps Mocktown independent of any one backend.

```ts
interface Provider {
  services: string[]                   // hostnames or logical service ids this backend serves
  start(ctx: ProviderCtx): Promise<Map<string, string>>   // service -> baseUrl
  stop(): Promise<void>
  reset(scope: ResetScope): Promise<void>  // back to seed; per-profile or full (12)
  knobs?: KnobManifest                 // Zod schema + defaults + descriptions (12)
  state?: StateIntrospection           // backs /api/…/state and GUI panels
  ekbEntries: EndpointRecipe[]         // how clients get pointed at each (05)
}
// Request context carries ctx.profile (auth profile) and ctx.prng (seeded stream) —
// see 12-scenario-controls.md for the determinism contract.
```

*Amended 2026-08-31 by the phase-0 spike*
([spikes/03-emulate](../../spikes/03-emulate/FINDINGS.md)): a provider is a **supervisor for
a set of services**, not one object per service. `emulate start -s stripe,github -p 4400` is
one process listening on 4400 for Stripe and 4401 for GitHub — a base port plus an offset per
service. Port allocation must therefore reserve a contiguous *run* of free ports, and base
URLs are discovered by parsing emulate's startup banner (a fragile step, which is why it
lives behind the provider seam).

## Provider kinds

### 1. Emulators (vercel-labs/emulate)

Stateful, SDK-compatible emulators for famous services (Stripe, GitHub, Google, AWS,
Slack, Okta, Clerk, Twilio, …) including OAuth flows with RS256 tokens.

**Decision: emulate is wrapped, never load-bearing.** It is a `vercel-labs`
experiment: valuable, volatile, possibly abandoned tomorrow. It runs as child
processes managed by its provider; nothing outside the provider layer imports it or
assumes its config format. If it dies, famous services degrade to recorded/generated
mocks — the interface doesn't change. Pin exact versions; track upstream releases.

Seed data (test customers, repos, users) is part of project config
([08-projects-config.md](08-projects-config.md)) so sandbox runs are reproducible. The
restart-based reset that [12-scenario-controls.md](12-scenario-controls.md) specifies for
emulator providers is spike-verified: after a restart with the same seed, seeded entities
are present and runtime-created ones are gone. Cost is a few seconds — fine for
`mocktown state reset`, too slow to run between every test case.

*Two caveats found in spike* ([spikes/03-emulate](../../spikes/03-emulate/FINDINGS.md)):

- **`--seed` is additive to emulate's built-in defaults**, not a replacement — a Stripe
  emulator with no seed file already contains a default customer. The reproducible baseline
  is "our seeds plus whatever this emulate version ships", which sharpens the case for
  pinning exact versions. Tests and generated mocks must assert against specific seeded
  entities, never against counts.
- **emulate binds every network interface and offers no way to restrict it** — not via
  `emulate start`, not via its programmatic API. Its internal `serve()` threads an
  `options.hostname` through to `listen()` but no caller ever sets it. Mock services,
  including GitHub's OAuth token issuance, are therefore reachable from the LAN in host
  mode. Sealed sandbox mode ([04-sandbox.md](04-sandbox.md)) solves this by construction;
  host mode must warn when a non-loopback interface is present, and a `--host` flag is
  worth upstreaming.

### 2. Generated mocks (the long tail — **this is the moat**)

For internal APIs and niche vendors nobody emulates. Pipeline:

```
recordings corpus (03) ──▶ agent generates a mock module ──▶ served by the daemon
        ▲                                                        │
        └────── drift issues (07) ── agent patches ◀─────────────┘
```

- A generated mock is a **plain Bun/TypeScript module** in the project workspace:
  routes derived from normalized paths, response synthesis derived from observed
  pairs, state backed by project SQLite (via Drizzle) when the recordings show
  create/read coupling (`POST /orders` → `GET /orders/{id}` must return the created
  order — verbatim replay is explicitly not the bar; emulate set the fidelity bar at
  *emulator, not stub*).
- Generation is performed **by a coding agent, not by templating code**. Mocktown's
  contribution is the harness: the corpus in agent-legible form, a generation prompt/
  skill with house rules, a test run that replays recorded sessions against the fresh
  mock and diffs, and the issue loop for everything that slips through.
- Generated mocks are committed to the repo (they contain no recorded payloads beyond
  scrubbed, reviewed fixtures) so the team and CI share them.

### 3. Passthrough

Explicit allowlist only (e.g. a telemetry host the team doesn't care to mock). Every
passthrough is visible in `mocktown status` — silent passthroughs are forbidden.

## Routing

The front door routes by hostname (SNI/Host header) using the project's service
registry: `hostname → provider | record | passthrough | deny`. Unknown hostname in
sealed mode → deny + issue. Conflicts (two providers claiming one host) are a
config-validation error, not a runtime race.

## State introspection

Providers *should* implement `state` (list entities, dump tables) — it powers
`GET /state/<service>` and GUI panels ([09-gui-plugins.md](09-gui-plugins.md)).
For generated mocks this is free (their state is our SQLite). For emulate it's
best-effort: whatever its processes expose; gaps here are acceptable.
