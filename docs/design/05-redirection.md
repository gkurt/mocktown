# 05 — Endpoint Redirection & the Seal

**Status:** Implemented — `mocktown env` + EKB in phase 2, seal certification in phase 3

Env-var / SDK-endpoint redirection is a **first-class mode**, not a fallback. It is
how humans do everyday local dev and how most server-side SDKs are pointed at mocks.
Its relationship to the sandbox ([04-sandbox.md](04-sandbox.md)) is:

> **The sandbox is the instrument that certifies the env-var setup; the env-var setup
> is the everyday artifact developers and agents actually use.**

Cooperative config can't be guaranteed by construction — but it can be **certified by
measurement**. That certification is the *seal*.

## Endpoint knowledge base (EKB)

Per service, the redirect recipe in order of preference:

1. **Standard env var** — `AWS_ENDPOINT_URL`, `OPENAI_BASE_URL`, `GITHUB_API_URL`,
   `FIRESTORE_EMULATOR_HOST`-style, etc.
2. **SDK constructor option** — Stripe's `host/port/protocol`, Octokit's `baseUrl` —
   with a per-language snippet.
3. **Code-patch recipe** — for SDKs with no knob: a description an agent can apply
   ("read `X_ENDPOINT` env var, default to production URL").

Sources: seeded from emulate's per-service SKILL.md files for famous services;
**every long-tail mock the generator produces must add its own EKB entry**
([06-emulation.md](06-emulation.md)). The EKB lives in the project DB and is an
accreting asset — treat contributions to it as first-class work.

## The generator: `mocktown env`

Emits three artifacts:

1. `.env.mocktown` — every variable settable mechanically, pointing at the front
   door / provider ports. **Convention: presence = emulated.** One variable per
   service, no global mode flag, so real and mocked dependencies can mix per-service
   (the Firebase emulator pattern).
2. A human-readable report of coverage.
3. An **agent task list** for the remainder — services needing constructor options or
   code patches, with exact file/recipe references. Also exposed via MCP and written
   into the project's `AGENTS.md` section so coding agents self-configure.

## Seal certification

```
run app flows inside the sandbox with deny-on-unknown
   → zero wall-hits and zero uncovered dependencies?
        ──yes──▶ SEALED (stamped for this commit + config hash)
        └─no─▶ each failure becomes a typed issue:
               unknown host at the wall  → unknown-service: record it / generate a mock
               exercised but unredirected → redirect-gap: env var, SDK option, or patch
               then re-run
```

**Decision (phase 3): a seal run happens inside the sandbox, or it does not happen.**
`mocktown seal verify` reports three outcomes — `sealed`, not sealed, and
**`unverifiable`** — and a run with no container engine is always the third. The reason is
the asymmetry the whole design turns on: outside the boundary, an SDK that ignores proxy
variables reaches the real API *without ever touching the front door*, so the run records
zero wall-hits and the seal comes back green while the app talks to production. Inside the
boundary there is no "direct". A command that could return a false SEALED would be worse
than no command at all. *Rejected:* a host-mode seal run behind a warning — the warning is
not what gets read six months later; the stamp is.

Two further consequences, both deliberate:

- **The flows run unmodified, with no Mocktown environment applied.** Inside the sandbox
  every hostname resolves to the front door anyway, so applying `.env.mocktown` would test
  our own environment setup rather than the app. It also means the flow list is ordinary
  project commands, not something Mocktown-flavoured.
- **Redirection coverage is judged separately, from the EKB.** A wall hit cannot detect a
  missing env var for a *registered* service, because inside the sandbox that service is
  served either way. So every service the flows actually exercised that `mocktown env`
  reports as not mechanically covered becomes a `redirect-gap` issue — that is precisely
  the dependency that would reach production the moment the app ran outside the sandbox.
  Un-exercised services are not judged; a seal should not fail over a dependency the flows
  never touch.

- Seal status = `{ commit, config hash, timestamp, flows exercised, wall hits }`, stored
  in the DB and surfaced by CLI/GUI. A seal is only as good as the flows that were
  exercised; the stamp records which ones, and a run with an empty flow list is refused
  rather than passed.
- **A stale stamp is not a pass.** `mocktown seal` compares the stamp's commit and config
  hash — the service registry, the generated variable names and the flow list — against
  the working tree, and reports why it no longer applies. Treating "sealed once, against a
  different configuration" as sealed is how a new dependency reaches production behind a
  green check.
- **CI re-certification:** a new dependency or SDK bump that adds an unconfigured call
  must break the seal loudly. `mocktown seal verify` is designed to run as a CI step, and
  exits non-zero when the verdict is anything but sealed:

  ```yaml
  - run: mocktown serve start --sealed
  - run: mocktown seal verify --json
  ```

- A sealed env-var setup is trustworthy *empirically*, never presented as equivalent
  to the sandbox guarantee.

## Footnotes

- Browser/client-side code does not read env vars; frontend redirection is build-time
  config and leaks third-party scripts — for client traffic see the launched-browser
  and in-sandbox-browser paths ([03-capture.md](03-capture.md),
  [04-sandbox.md](04-sandbox.md)).
- [portless](https://github.com/vercel-labs/portless) integration: stable
  `<service>.localhost` names + trusted local certs for the host/dev mode. Optional
  dependency, same treatment as emulate (wrapped, not load-bearing).
