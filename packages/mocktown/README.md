# mocktown

Record an app's outbound traffic, serve it back as stateful mocks, and keep those mocks
alive as the real services change.

This package is the whole product as of phases 1–4: the daemon, the front door, the
corpus, the providers, the issue engine, the sealed sandbox, drift watch, and the surfaces
(CLI, HTTP API, MCP, and the GUI shell in `packages/gui`).
Design rationale lives in [`docs/design`](../../docs/design/README.md) — read the file for
the subsystem you are touching, not all of them.

## Quick start

From the repo root, install and put `mocktown` on your PATH:

```bash
bun install && cd packages/mocktown && bun link
```

Then, in the app you want to mock:

```bash
mocktown init
```

Record a run, then look at what it captured:

```bash
mocktown record --label first-run -- node server.js
```

```bash
mocktown recordings list
```

Everything is scrubbed **before** it reaches disk, so the corpus you browse is the corpus
that exists. `mocktown scrub audit` re-scans it with the current rules.

## The loop

1. `mocktown record -- <cmd>` captures real traffic through the front door.
2. `mocktown mocks scaffold --service <host>` writes a `BRIEF.md` and a module stub from
   the corpus.
3. A coding agent fills in the module — `mocktown skills get --name generate-mock` is the
   prompt pack for exactly that job.
4. `mocktown serve start --sealed` serves it — a mock you have written takes over the
   service the recorder discovered, without a registry edit. Anything unserved is **denied
   loudly** and filed: `mocktown issues list`.
5. `mocktown mocks verify --service <host>` replays the corpus against the mock,
   comparing status class and response *shape* — never values.

Resolving an issue is a patch to a mock plus `mocktown issues resolve --id <id>`. A fix
that does not hold reopens the same issue rather than filing a new one.

A mock that is broken — will not import, or throws while seeding — leaves *its* service
denied and says why in `mocktown providers list`; the rest keep serving. Any host still
pointed at a real upstream is named in `mocktown serve start`'s warnings, so serving and
escaping never look alike.

> **`NO_PROXY` is computed from the project, and every entry in it is a hole.** Proxy
> clients match it by domain suffix, so a blanket `localhost` entry takes every
> `*.localhost` name with it — a `.localhost` upstream would record nothing while looking
> perfectly wired up. Mocktown drops that entry as soon as a service sits under the suffix,
> keeps `127.0.0.1` and `::1` unconditionally, and lets the app name its own local services:
>
> ```jsonc
> { "noProxy": ["localhost", "db.internal"] }
> ```
>
> The trade is stated, never assumed: `record start` and `serve start` warn that a service
> reached as `localhost:<port>` by name now goes through the front door, and a request for a
> loopback name that hits the wall is filed as *your own service* — with `noProxy` as the
> fix — rather than as a missing dependency. A collision that cannot be resolved is named
> too: under portless the TLD has to bypass, so a `.localhost` upstream is unrecordable in
> that mode.

## The seal

Everything above is cooperative: an SDK that ignores proxy variables reaches the real API
without ever touching the front door. The sandbox is where that stops being possible.

```bash
mocktown sandbox up              # sealed network, DNS catch-all, CA in the trust store
mocktown sandbox exec -- bun test
mocktown sandbox verify          # the escape attempts, against a negative control
mocktown seal verify             # run the flows inside, stamp the result — exits non-zero
```

Inside the boundary there is no route out except the front door, so an unregistered
dependency hits the deny wall and becomes an issue instead of reaching production. That is
also why `mocktown seal verify` refuses to run outside the sandbox: with no container
engine it reports `unverifiable`, never a pass. `mocktown sandbox devcontainer` writes the
same boundary as a devcontainer feature for a repo that already has one.

## Watching it work

The live feed is one procedure, so it is on every surface:

```bash
mocktown feed --follow
```

```bash
mocktown gui
```

`mocktown gui` opens the shell the daemon serves on its own port — dashboard, live feed,
issues, services, corpus, provider state, seal and sandbox, and panels. The bearer token is
injected by the daemon as it serves the page, so the build on disk carries no capability.
Build it first (once) with `bun run gui:build` from the repo root.

A **panel** is one self-contained HTML file plus a manifest in `.mocktown/panels/`:

```jsonc
// .mocktown/panels/stripe-state.json
{ "name": "Stripe state", "service": "api.stripe.com", "entry": "stripe-state.html" }
```

The shell lists panels and iframes them. A panel reads the API base and token from the
`<meta name="mocktown-boot">` element the daemon injects, and is served under a CSP with no
external origin in it — it can talk to this daemon and nowhere else. `mocktown panels list`
shows what was found, and why any manifest could not be used. The shipped
`provider-state.html` panel is the worked example to copy.

## Keeping mocks honest as the real services change

```bash
mocktown drift check
```

A drift run re-records your own flows against the **real** services, replays that fresh
evidence against your mocks, and files `provider-drift` issues for the divergences. It is a
re-record rather than a replay because the corpus holds no credentials — only your app can
authenticate. It spends real quota, so the schedule is off until `mocktown.json` asks for it:

```jsonc
{ "drift": { "enabled": true, "intervalHours": 24, "flows": ["bun run test:integration"] } }
```

## Stable local names (optional)

With [portless](https://github.com/vercel-labs/portless) installed and
`portless.enabled` in `mocktown.json`, each service gets a stable
`https://<service>.<project>.localhost` name instead of a fresh loopback port on every
daemon restart, and `.env.mocktown` uses it. Mocktown proves the whole path works — it
registers a throwaway name and fetches it back through the proxy — before it claims a name,
and reports the reason if it cannot. `mocktown env portless get` shows the verdict.

## Layout

| Path | What lives there |
|---|---|
| `src/contract/` | The one procedure definition. CLI, HTTP API and MCP are all walks of it |
| `src/daemon/` | The runtime state machine, the oRPC router, the `Bun.serve` server |
| `src/frontdoor/` | The Node sidecar and the controller that drives Mockttp over its admin protocol |
| `src/capture/` | Recorder, HAR import, URL normalization, the launch wrapper |
| `src/scrub/` | Rules and the two-pass scrubber, with `reinject()` for replay |
| `src/providers/` | The provider interface, the emulate supervisor, the generated-mock host |
| `src/mocks/` | The public mock-authoring API, matching/diagnosis, corpus export, replay verify |
| `src/issues/` | The issue engine and the `.mocktown/issues` file queue |
| `src/db/` | Drizzle schema and the per-project SQLite client |
| `src/sandbox/` | The container engine seam, the generated images, the topology, the escape-attempt harness |
| `src/seal/` | Seal certification and its staleness-aware stamp |
| `src/skills/` | The prompt packs shipped for the recurring agent jobs |
| `src/drift/` | Drift watch: the re-record run and the daemon-side schedule |
| `src/redirect/` | The portless seam — stable local names, wrapped and optional |
| `src/gui/` | Serving the shell and the panels, plus the built-in panels themselves |

## House rules worth knowing before you edit

These are enforced by tests over the contract walk (`tests/surfaces.test.ts`), not by
review:

- **Every procedure is on all three surfaces**, with a summary, a REST route, and
  `project` in its input.
- **`--json` is the raw response; human output is a projection of it, never richer.** A
  procedure with no renderer fails the suite.
- **`readOnlyHint` follows the HTTP method.** A `GET` that mutates anything is a defect,
  not a style choice — that is why `env.get` and `env.write` are separate procedures.

And two the front door enforces structurally, because getting them wrong leaks traffic to
the real upstream:

- Every Mockttp rule is `always()`; a consumed rule silently forwards to production.
- The fallthrough **denies and files**; it never passes through.

One more, because CI depends on it:

- **A response carrying `ok: false` exits non-zero.** The verdict is a field of the
  contract, not a flag on a command.

## Testing

```bash
bun test
```

`tests/loop.test.ts` runs a real front door against a real upstream and asserts both phase
exit criteria. `tests/emulate.test.ts` spawns a real `emulate` process. `tests/sandbox.test.ts`
builds real images and asserts the seal against a negative control, skipping itself when no
container engine is installed. `tests/sockets.test.ts` holds a real WebSocket conversation
with a real mock host and captures another through the real front door.
`tests/gui.test.ts` fetches the shell and a panel from a real daemon to check the injected
token, the CSP and path containment. `tests/portless.test.ts` runs the portless seam against
a stub binary and a Host-routing reverse proxy, because portless itself binds 443 with sudo
and installs a CA — not something a test suite gets to do to a machine. None of it is mocked,
which is the point: the failures this product must not have are integration failures.
