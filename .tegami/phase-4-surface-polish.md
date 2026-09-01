---
packages:
  - mocktown: minor
---

### Added

- **`mocktown gui`** — a local shell served by the daemon on its own port: dashboard,
  live feed, issues, services, corpus, provider state, seal/sandbox/drift, and panels. It
  is a client of the same contract as the CLI, and the API token is injected as the page is
  served rather than built into it.
- **A live feed on every surface.** `mocktown feed` shows what the front door, the issue
  engine and the providers just did; `--follow` streams it. Body-free and bounded, and it
  tells you when events were dropped instead of showing a feed with a hole in it.
- **Panels** — a panel is one self-contained HTML file plus a manifest in
  `.mocktown/panels/`. `mocktown panels list` shows what was found, and why a manifest
  could not be used. Panel documents are served with no route off this origin. A
  provider-state panel ships as the worked example, and `mocktown skills get --name
  write-panel` is the prompt pack for writing one.
- **State introspection across providers** — `mocktown state list` covers every registered
  service, and a provider that cannot report its state says why rather than being left out.
- **`mocktown drift check`** and a daemon-side schedule: re-record your own flows against
  the **real** services, replay that evidence against your mocks, and file
  `provider-drift` issues for the divergences. Off until `mocktown.json` asks for it — a
  run spends real quota.
- **WebSocket recording and mocking.** Sockets land in the corpus as whole transcripts with
  frame directions written from the client's point of view, the corpus export carries them,
  and a generated mock declares channels in a `sockets` array. A channel the mock does not
  declare is refused at the handshake and filed.
- **gRPC is recorded and refused with the reason.** A generated mock cannot serve gRPC —
  `Bun.serve` does not accept HTTP/2 — so the boundary says so, in the response and in the
  issue, along with the two approaches that do work.
- **Optional stable local names via portless.** With `portless.enabled`, each service gets
  `https://<service>.<project>.localhost` instead of a fresh port per daemon restart, and
  `.env.mocktown` uses it. Mocktown proves the whole path end to end before claiming a
  name; `mocktown env portless get` shows the verdict or the reason.

### Fixed

- `.env.mocktown` set `HTTP_PROXY` with no `NO_PROXY`, so a client pointed at its mock's
  loopback URL had that request proxied into the front door, which denied it as an unknown
  host. Loopback is never proxied now.
- The daemon could only find the workspace of the project whose `mocktown.json` sat above
  its own working directory. Every other project silently lost issues on disk, generated
  mocks, panels and `env write`; resolution now falls back to the workspace recorded in the
  project registry.
- Binary request and response bodies were dropped or corrupted rather than stored. They are
  kept base64 and marked `unscrubbable-binary`, because pattern rules cannot see inside
  them and the corpus should say so.
