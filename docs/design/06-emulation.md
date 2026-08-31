# 06 — Emulation: Providers, emulate, and the Long-Tail Generator

**Status:** Draft

A **provider** is anything that can serve a mocked service behind the front door.
The provider interface is the seam that keeps Mocktown independent of any one backend.

```ts
interface Provider {
  service: string                      // hostname or logical service id
  start(ctx: ProviderCtx): Promise<{ baseUrl: string }>
  stop(): Promise<void>
  reset(scope: ResetScope): Promise<void>  // back to seed; per-profile or full (12)
  knobs?: KnobManifest                 // Zod schema + defaults + descriptions (12)
  state?: StateIntrospection           // backs /api/…/state and GUI panels
  ekbEntry: EndpointRecipe             // how clients get pointed at it (05)
}
// Request context carries ctx.profile (auth profile) and ctx.prng (seeded stream) —
// see 12-scenario-controls.md for the determinism contract.
```

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
([08-projects-config.md](08-projects-config.md)) so sandbox runs are reproducible.

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
