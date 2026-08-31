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
│  │ (Mockttp, │ │ +scrubber │ │ (drift → issues)    │ │
│  │ Node proc)│ │           │ │                     │ │
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

**Decision: Bun + TypeScript everywhere except the front door, which is a Node
sidecar.** The daemon, API, CLI, and generated mocks run on Bun; generated mocks are plain
Bun modules, which keeps the artifact agents produce and patch in one language. The proxy
runs as a separate Node process, driven by the daemon over Mockttp's own admin-server
protocol (a supported configuration, not a workaround).
*Amended 2026-08-31 by the phase-0 spike* ([spikes/01-mockttp-bun](../../spikes/01-mockttp-bun/FINDINGS.md)):
single-runtime Bun was the original decision, but Mockttp under Bun loses HTTP/2 (Bun's
`SNICallback` suppresses ALPN) and WebSockets (Bun's builtin `ws` shadows the npm package
and lacks the socket-wrapping constructor), and can segfault on the WebSocket path. Neither
is fixable from userland. The blockers are confined to the proxy — nothing else in the stack
touches `node:tls` internals or `ws` — so the boundary is drawn there rather than moving
everything to Node. Revisit criteria and the re-verification harness are in the spike.
*Rejected:* bundling mitmproxy (Python) — a permanent two-runtime maintenance boundary
for its addon API; moving the whole daemon to Node (gives up single-binary compile, startup
time, and Bun's SQLite for problems only the proxy has).

**Decision: Mockttp as the proxy engine, on Node.**
Apache-2.0, TypeScript, HTTPS MITM, HTTP/2, WebSockets, programmable rules; it is the
battle-tested core of HTTP Toolkit. *Validated 2026-08-31:* it passes the full capability
matrix on Node unpatched (6/6) and fails it on Bun (4/6, and only after patching two of its
dependencies) — hence the sidecar above. Details, reproductions, and the criteria for
revisiting Bun: [spikes/01-mockttp-bun](../../spikes/01-mockttp-bun/FINDINGS.md).

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

**Decision: the API layer is oRPC with Zod v4 contracts — one procedure
definition, three surfaces.** Procedures are defined once (Zod input/output,
explicit REST-ish paths) and served by oRPC's OpenAPIHandler directly on
`Bun.serve` — so the daemon API stays plain HTTP/JSON for panels, `curl`, and
non-TS agents, with a generated OpenAPI spec as free agent-facing documentation.
The GUI consumes it via the typed oRPC client + `@orpc/tanstack-query`; the CLI via
the same client over an HTTP link (`--json` = the raw response); the MCP server
(phase 2) is generated by walking the contract — the MCP TS SDK accepts Zod schemas
for tool inputs. *Validated 2026-08-31* ([spikes/02-orpc-bun](../../spikes/02-orpc-bun/FINDINGS.md)):
10/10 on Bun, unpatched. **The walk is ours, not an adapter's** — `orpc-mcp` is a 0.x
single-maintainer package with ~330 downloads/week and `trpc-cli` is tRPC-only, while the
walk measured 161 lines and keeps oRPC's internals behind one function. It also lets us
set house rules an adapter wouldn't: MCP `readOnlyHint` is derived from the HTTP method,
and `--json`-on-every-command is structural rather than per-command discipline. *Rejected:* tRPC (own wire
dialect; OpenAPI is a bolted-on afterthought, and plain-JSON access is a hard
requirement here); bare REST handlers (no shared types, three surfaces drift);
adding a web framework (Hono/Elysia/Express) — oRPC handlers + static file serving
on `Bun.serve` cover the daemon's needs.

**Decision: Zod v4 (pinned) is the single schema language.** oRPC contracts,
`mocktown.json` and scrub-rule validation, MCP tool inputs, and `drizzle-zod`-derived
row schemas all share it. No second validation library may be introduced.

**Decision: GUI framework set is React 19 + TanStack Router + TanStack Query
(+ `@orpc/tanstack-query`) + TanStack Form (latest v2.x) + TanStack Store (latest), as a Vite SPA.** Forms
(service registry editing, scrub-rule config, seed editors) use TanStack Form with
Zod adapters — same schema objects as the oRPC contract, so form validation and API
validation cannot drift. State split: **TanStack Query owns all server state**
(daemon API data — never mirrored into a store); TanStack Store holds the small
client-only remainder (UI preferences, panel layout, feed filters). *Rejected:*
Zustand/Jotai/Redux (a second state idiom outside the TanStack set for the same
narrow job). TanStack **Start is not adopted**: it
is an SSR/full-stack framework (still RC as of 2026-06) whose value — SEO, server
functions, streaming — a daemon-served local dashboard cannot collect; TanStack's
own guidance is Router-alone for authenticated dashboards. Deferred, not banned:
revisit only if a hosted/cloud GUI ever leaves "deliberately unscheduled"
([11-roadmap.md](11-roadmap.md)).

**Decision: styling and components are Tailwind v4 + shadcn/ui on Base UI.**
Base UI is shadcn's default for new projects as of 2026-07 (Radix remains
supported; a migration command exists both ways).

**Decision: utility hooks come from the owner's shadcn registry —
`@gkurt` (https://gkurt.com/shadcn/).** Registered in `components.json` as
`"@gkurt": "https://gkurt.com/shadcn/r/{name}.json"`; installed per-item via
`npx shadcn@latest add @gkurt/<name>` (hooks like `use-stable-callback`, the
`use-control` family, `use-promise`, plus utilities such as `poly` and
`tv-pick`). Precedence rules:

1. **Library-owned hooks win over registry hooks on collision.** If TanStack
   Form/Query/Store/Router or Base UI ships a hook for the job, use it; the
   registry covers what the locked libraries don't. No data-fetching hooks outside
   TanStack Query, ever.
2. Registry hooks install as source into `src/hooks/` (shadcn model — we own the
   copy).
3. **Any modification to an installed registry hook, and any new reusable hook
   written locally, must carry a `// TODO(registry):` marker** with a one-line
   reason — these are upstreaming candidates for the registry, and the marker is
   how they're found later.

*Rejected:* @mantine/hooks (owner veto); ahooks (data-layer hooks duplicate
TanStack Query's domain); react-use (maintenance pace, uneven quality).

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

Defined as oRPC procedures with explicit paths (see decision above); rendered over
HTTP as:

`http://127.0.0.1:<port>/api/v1/projects/<name>/…`

- `GET  /services` · `PUT /services/<id>` — service registry & provider assignment
- `GET  /recordings?service=…` — the corpus
- `GET  /issues` · `POST /issues/<id>/resolve` — the agent loop
- `POST /record/start|stop` · `POST /seal/run` — mode control
- `GET  /env` — the generated env-var setup ([05-redirection.md](05-redirection.md))
- `GET  /state/<service>/…` — provider state introspection (backs GUI panels)
- `GET/PUT /knobs/<service>` · `GET /profiles` · `POST /profiles/<n>/session` ·
  `POST /state/reset` — scenario controls ([12-scenario-controls.md](12-scenario-controls.md))

The same API is exposed to agents as an MCP server
([07-issues-agent-loop.md](07-issues-agent-loop.md)).
