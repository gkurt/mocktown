# 12 — Scenario Controls: Knobs, Auth Profiles & State Lifecycle

**Status:** Implemented — phase 2; GUI knob forms remain phase 4

Generated mocks ([06-emulation.md](06-emulation.md)) must be *steerable* without
losing determinism. Three mechanisms, one contract: **same seed + same knob values +
same profile + same request sequence → byte-identical responses.**

## Knobs

A knob is an agent-declared configuration parameter on a generated mock — e.g.
`items.count: { min, max }` on a list endpoint, `latencyMs`, `errorRate`,
`pagination.pageSize`. Users tune them from the GUI; agents via API/MCP.

- **Declaration is a Zod schema** (the stack's single schema language,
  [02-architecture.md](02-architecture.md)): each generated mock exports a `knobs`
  object — schema + defaults + a one-line description per knob. The GUI auto-renders
  the form from the schema (TanStack Form); no per-mock UI work.
- **Values are project state**, persisted in SQLite, exposed at
  `GET/PUT /knobs/<service>`. A knob change is a **journaled state event**: it takes
  effect immediately, is recorded in the session journal, and therefore never breaks
  replayability — reproducing a run means replaying its knob events too.
- **Determinism under ranges**: any knob expressing variation (min/max) draws from a
  seeded PRNG, never `Math.random()`. Stream key =
  `hash(sessionSeed, service, endpoint, profile, stableRequestIdentity)` — so the
  same GET for the same profile in the same session always lands on the same value,
  regardless of request ordering elsewhere.
- **House rule for generating agents**: prefer *profile variation* (below) for
  data-shape scenarios (empty vs. populated); use knobs for cross-cutting dials
  (latency, error injection, volume scaling) and for overrides a human wants to turn
  while watching the app.

## Auth profiles (first-class)

A profile is a named persona with credentials and a distinct world of data. Profiles
are the primary axis for scenario variation: "what does this app look like for a
brand-new user vs. a power user" is a profile switch, not a knob flip.

Schema (project SQLite, editable via GUI/API):

```jsonc
{
  "name": "empty-org",
  "description": "Brand-new signup: zero items, no teammates, unverified email.
                  Use to test every empty state.",   // REQUIRED, and must say how
                                                     // it differs from other profiles
  "credentials": { "email": "empty@mocktown.test", "password": "mock-empty-1" },
  "context":     { "orgId": "org_empty01", "projectId": "prj_empty01" },
  "knobOverrides": { "internal-billing": { "items.count": { "min": 0, "max": 0 } } }
}
```

- **Sign-in is real**: generated mocks and emulators must accept each profile's
  credentials through the app's normal login flow and issue tokens/cookies tagged to
  the profile. The front door maps incoming auth → profile and passes it to the
  provider in `ctx.profile`; unauthenticated requests get the `anonymous` profile.
  *Qualified 2026-08-31 by the phase-0 spike*
  ([spikes/03-emulate](../../spikes/03-emulate/FINDINGS.md)): for **emulate-backed**
  services this is a consent-screen shortcut, not a credential exchange — emulate's
  OAuth consent page is a picker over seeded users, driven by POSTing `login=<user>`
  to `/login/oauth/callback`. The issued token does authenticate real SDK calls, so
  the profile mapping holds; but the roster must say which kind of sign-in a service
  offers, and EKB recipes for emulate-backed OAuth services must describe the consent
  POST or unattended agent runs will hang on an HTML page.
- **Discovery**: `GET /profiles`, `mocktown profiles list`, and an MCP
  `list_profiles` tool return the roster with descriptions — an agent driving a
  browser test asks for the roster, picks the persona the scenario needs, and signs
  in with its credentials. `POST /profiles/<name>/session` mints a ready-made
  token for API-level testing that skips the login UI.
- **Generation-time duty** ([07-issues-agent-loop.md](07-issues-agent-loop.md)
  house rules): agents designing mocks must seed data *per profile*, and every
  project starts with at least `default` (typical data) and `empty-org` (zero
  everything). Recorded traffic informs `default`; `empty-org` is synthesized.
- Credentials are always synthetic (`*.test` domains, generated passwords) — never
  derived from recorded real credentials ([10-security.md](10-security.md)).

## State lifecycle: seed → session → reset

- **Seed**: the initial state a generating agent decides on — fixtures per profile,
  committed to the repo alongside the mock (`mocks/<service>/seed/`). The seed IS
  the reset target; changing it is a reviewed code change.
- **Session**: one continuous run of the mock environment. Owns a `sessionSeed`
  (fixed default so runs are reproducible out of the box; override to explore),
  the journal of knob events, and all mutable state accumulated through app usage.
- **Reset**: `mocktown state reset [--service <s>] [--profile <p>]`,
  `POST /state/reset`, MCP `reset_state`. Drops mutable state and re-applies seeds —
  per service, per profile, or everything. Implementation: generated-mock state
  lives in namespaced SQLite tables keyed by (service, profile), so reset is
  drop + re-seed, cheap enough to run between test cases. Emulator providers reset
  by child-process restart with the same seed config ([06-emulation.md](06-emulation.md))
  — spike-verified, at a cost of a few seconds per reset, so emulator-backed services
  cannot be reset between every test case the way generated mocks can.
  A reset closes the session and starts a new one; recordings and issues are tagged
  by session id.
- **Later (unscheduled)**: named snapshots ("save this interesting state, branch
  from it") — the seed/reset design must not preclude it, but v1 ships without it.

## Provider interface impact

`Provider` ([06-emulation.md](06-emulation.md)) gains: `knobs?: KnobManifest`,
`reset(scope): Promise<void>`, and request context carries `ctx.profile` and
`ctx.prng`. Providers that ignore profiles (simple stateless mocks) still work —
they just serve every persona the same data.
