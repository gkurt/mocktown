# 05 — Endpoint Redirection & the Seal

**Status:** Draft

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
apply env setup → run app flows in `sandbox record` with deny-on-unknown
   → zero wall-hits?  ──yes──▶ SEALED (stamped for this commit + config hash)
   └─no─▶ each wall-hit becomes a typed issue:
          env-var missing        → add to .env.mocktown
          SDK has no knob        → agent applies code patch
          service unknown        → record it / generate a mock
          then re-run
```

- Seal status = `{ commit, config hash, timestamp, flows exercised }`, stored in the
  DB and surfaced by CLI/GUI. A seal is only as good as the flows that were exercised;
  the stamp records which ones.
- **CI re-certification:** a new dependency or SDK bump that adds an unconfigured call
  must break the seal loudly. `mocktown seal verify` is designed to run as a CI step.
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
