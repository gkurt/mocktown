# Apply the redirect recipes

`mocktown env` emits everything settable mechanically into `.env.mocktown`, plus a task
list for the services that need more. This file is that task list.

```bash
mocktown env write          # writes .env.mocktown and the AGENTS.md section
mocktown ekb list           # the recipes known for each service
```

## The preference order

1. **Standard env var** — `AWS_ENDPOINT_URL`, `GITHUB_API_URL`, `OPENAI_BASE_URL`, and so
   on. Already handled by `.env.mocktown`; nothing for you to do.
2. **SDK constructor option** — Stripe's `host`/`port`/`protocol`, Octokit's `baseUrl`.
   Read the option from an env var with the production URL as the default, so the change
   is inert outside development.
3. **Code patch** — for SDKs with no endpoint knob. Add one: read `<SERVICE>_ENDPOINT`
   and fall back to the production URL. Never hard-code a mock URL.

## Rules

- **Presence = emulated.** One variable per service, no global mode flag, so real and
  mocked dependencies can mix per service. Do not add a `MOCK_MODE` switch.
- **Record what you learn.** Any recipe you work out belongs in the knowledge base:
  `mocktown ekb add --service <s> --rung <1|2|3> --env-var <VAR> --snippet '<code>'`.
  The EKB is an accreting asset; a recipe you leave undocumented costs the next run.
- **Emulate-backed OAuth services need the consent step described.** Their consent screen
  is a picker over seeded users, not a login form — you proceed by POSTing `login=<user>`
  to the callback. An unattended run that expects a password prompt hangs on an HTML page.
- **`NODE_USE_ENV_PROXY=1` is required** for anything built on `fetch`/undici. Without it
  an SDK ignores `HTTPS_PROXY` entirely and reaches the real API while looking configured.

## Checking your own work as you go

`seal verify` is the verdict, not the loop. The loop is running the app's own tests inside
the boundary, where an SDK you have not redirected fails instead of quietly reaching the
real API:

```bash
mocktown sandbox up                       # the sealed network, the relay, the app container
mocktown sandbox exec -- bun test         # the agent surface for flows and tests
mocktown issues list --type redirect-gap  # what is still pointed at production
```

Every hostname inside there resolves to the front door, so a test that passes outside and
fails inside has found exactly the dependency you are looking for. `mocktown sandbox
verify` proves the boundary itself holds on this host — run it once, not per change.

## How the work is checked

```bash
mocktown seal verify --json
```

It runs the project's flows **inside the sealed sandbox**, where every hostname resolves to
the front door, and stamps the result against the current commit and config. Two things
follow for you:

- A service the flows exercised that is still not mechanically redirected becomes a
  `redirect-gap` issue — that is the dependency that would reach production the moment
  the app ran outside the sandbox. Your job is done when those are empty, not when the
  tests pass.
- `unverifiable` is not a pass. With no container engine there is no boundary, so an
  unconfigured SDK would reach the real API and the run would look green. Do not report a
  seal you did not get.
