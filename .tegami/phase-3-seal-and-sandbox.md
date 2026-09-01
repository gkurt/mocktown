---
packages:
  - mocktown: minor
---

### Added

- **The sealed sandbox.** `mocktown sandbox up` builds a network with no route out except
  the front door, resolves every hostname to it, and trusts the project CA — so unmodified
  code reaches its mocks and an unregistered dependency hits the deny wall instead of
  production. `mocktown sandbox exec -- <command>` runs inside it.
- **`mocktown sandbox verify`** — the escape attempts, run first on an ordinary network as
  a negative control. Reports `pass`, `fail` and `inconclusive` as three distinct outcomes.
- **`mocktown seal verify`** — runs the project's flows inside the sandbox and stamps the
  result against the commit and config hash. Exits non-zero when the verdict is anything
  but sealed, and reports `unverifiable` rather than a false pass when there is no
  container engine. A stale stamp is not a pass.
- **In-sandbox Chromium**, reachable through the executable-path variables Playwright and
  Puppeteer already read.
- **`mocktown sandbox devcontainer`** — the same boundary as a devcontainer feature, for a
  repo that already has one.
- **`mocktown browser launch`** — a browser for host web dev, trusting one public key for
  one window instead of editing a trust store.

### Changed

- A response carrying `ok: false` now exits the CLI non-zero, on every command.
