# mocktown

Record an app's outbound traffic, serve it back as stateful mocks, and keep those mocks
alive as the real services change.

This package is the whole product as of phases 1–3: the daemon, the front door, the
corpus, the providers, the issue engine, the sealed sandbox, and the three surfaces (CLI,
HTTP API, MCP).
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
4. `mocktown serve start --sealed` serves it. Anything unserved is **denied loudly** and
   filed: `mocktown issues list`.
5. `mocktown mocks verify --service <host>` replays the corpus against the mock,
   comparing status class and response *shape* — never values.

Resolving an issue is a patch to a mock plus `mocktown issues resolve --id <id>`. A fix
that does not hold reopens the same issue rather than filing a new one.

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
container engine is installed. None of it is mocked, which is the point: the failures this
product must not have are integration failures.
