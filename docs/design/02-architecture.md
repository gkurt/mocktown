# 02 — Architecture & Tech Stack

**Status:** Draft

One long-running **daemon** owns all logic and exposes a local HTTP/JSON API. The CLI
and GUI are thin clients of that API — no client has privileged access to anything.
This discipline is what makes the later plugin model nearly free
([09-gui-plugins.md](09-gui-plugins.md)).

## Components

```
┌────────────┐   ┌────────────┐   ┌─────────────────┐
│    CLI     │   │  GUI shell │   │  agent (MCP)     │
└─────┬──────┘   └─────┬──────┘   └────────┬────────┘
      └───────────┬────┴───────────────────┘
                  ▼  local HTTP/JSON API (per-project namespace)
┌─────────────────────────────────────────────────────┐
│                    daemon (Bun)                      │
│  ┌───────────┐ ┌───────────┐ ┌────────────────────┐ │
│  │ front door│ │ recorder  │ │ issue engine        │ │
│  │ (Mockttp) │ │ +scrubber │ │ (drift → issues)    │ │
│  └─────┬─────┘ └───────────┘ └────────────────────┘ │
│        │ routes per hostname                          │
│  ┌─────┴──────────┬──────────────────┬────────────┐ │
│  │ emulate procs  │ generated mocks  │ passthrough │ │
│  │ (child procs)  │ (Bun modules)    │ (record/deny)│ │
│  └────────────────┴──────────────────┴────────────┘ │
│                 SQLite (Drizzle ORM)                  │
└─────────────────────────────────────────────────────┘
```

- **Front door** — the MITM proxy; terminates TLS with the project CA, routes each
  request by hostname to a provider, or denies + files an issue. Details in
  [03-capture.md](03-capture.md).
- **Recorder** — persists exchanges during record mode, runs the scrubber
  ([10-security.md](10-security.md)) before anything touches disk.
- **Issue engine** — classifies unmatched/mismatched requests into typed issues
  ([07-issues-agent-loop.md](07-issues-agent-loop.md)).
- **Providers** — pluggable backends per service ([06-emulation.md](06-emulation.md)).

## Decisions

**Decision: Bun + TypeScript, single runtime.**
The proxy, generated mocks, daemon, and CLI all run on Bun. Generated mocks are plain
Bun modules, which keeps the artifact agents produce and patch in one language.
*Rejected:* bundling mitmproxy (Python) — a permanent two-runtime maintenance boundary
for its addon API; revisit only if Mockttp hits a protocol wall.

**Decision: Mockttp as the proxy engine.**
Apache-2.0, TypeScript, HTTPS MITM, HTTP/2, WebSockets, programmable rules; it is the
battle-tested core of HTTP Toolkit. Must be validated against Bun's node-compat early
(it uses Node http internals) — this is a phase-0 spike, with Node-as-sidecar the
fallback if Bun compat fails.

**Decision: SQLite + Drizzle ORM, one database file per project.**
Stores recordings, issues, endpoint knowledge base entries, seal status, and the
backing state of generated mocks. Drizzle Studio gives a free state viewer
([09-gui-plugins.md](09-gui-plugins.md)). WAL mode; the daemon is the only writer.

**Decision: headless-first.**
Every capability ships in the CLI/API before it appears in the GUI. The GUI never
grows logic of its own.

**Decision: CLI in TypeScript on Bun, one repo with the daemon, shipped as a
compiled single binary** (`bun build --compile`, per-platform artifacts). Commander
for argument parsing. Agent-first output contract: **every command supports
`--json`**; human-readable output is a rendering of the same data, never richer.
*Rejected:* Rust/Go CLI (a second language for a thin API client with no perf need);
Ink/TUI frameworks (interactivity lives in the GUI; the CLI stays scriptable and
deterministic).

**Decision: GUI is Vite + React + TypeScript, built to static files served by the
daemon** and opened in the default browser — zero packaging/signing, works over SSH
and in devcontainers. A desktop shell, if ever demanded, is **Tauri** wrapping the
same web app with the daemon as a sidecar. *Rejected:* Electron (ships a second JS
runtime + bundled Chromium to host a thin client; ~10× artifact size and a heavier
signing surface for webview consistency a dashboard doesn't need); GPUI/native
toolkits (second language; immature ecosystem; and the panels-iframe model +
embedded Drizzle Studio ([09-gui-plugins.md](09-gui-plugins.md)) require a webview
anyway, so "native" would still embed one).

**Decision: emulate runs as child processes, wrapped behind the provider interface.**
emulate is a `vercel-labs` experiment — valuable but volatile. Nothing outside the
provider layer may import or assume it. See [06-emulation.md](06-emulation.md).

## API sketch

`http://127.0.0.1:<port>/api/v1/projects/<name>/…`

- `GET  /services` · `PUT /services/<id>` — service registry & provider assignment
- `GET  /recordings?service=…` — the corpus
- `GET  /issues` · `POST /issues/<id>/resolve` — the agent loop
- `POST /record/start|stop` · `POST /seal/run` — mode control
- `GET  /env` — the generated env-var setup ([05-redirection.md](05-redirection.md))
- `GET  /state/<service>/…` — provider state introspection (backs GUI panels)

The same API is exposed to agents as an MCP server
([07-issues-agent-loop.md](07-issues-agent-loop.md)).
