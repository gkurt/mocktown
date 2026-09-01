# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Commands

```bash
bun run test       # Run all tests
bun typecheck      # Type check (TypeScript 7, native tsc)
bun run lint       # Lint
bun run format     # Format
bun run fix        # Lint + format + autofix
bun run checks     # Everything: check + typecheck + test
bun run gui:build  # Build the GUI shell the daemon serves
bun run gui:dev    # Vite dev server for the shell (needs MOCKTOWN_GUI_DIST or a built shell)
```

Prefer these scripts over ad-hoc commands. Do not prefix them with `bun run` when
a bare alias exists (`bun check`, `bun typecheck`) — those are whitelisted for
agent use.

Package-level extras, from `packages/mocktown`:

```bash
bun run daemon         # Start the daemon in the foreground
bun run db:generate    # Regenerate Drizzle migrations after editing src/db/schema.ts
```

## Project Structure

```
packages/mocktown/     The product: daemon, front door, corpus, providers, surfaces
packages/gui/          The GUI shell: a Vite/React SPA served by the daemon
spikes/                Throwaway investigations, kept for their FINDINGS.md
docs/design/           Per-subsystem design docs — the source of truth for intent
```

`packages/mocktown/src`:

| Path | Responsibility |
| --- | --- |
| `daemon/` | The server that owns all logic: `server.ts` (API), `runtime.ts` (per-project state), `router.ts` (contract wiring). |
| `contract/` | The oRPC contract — the single API definition every surface derives from. |
| `frontdoor/` | The capture proxy. `controller.ts` is the daemon half, `sidecar.ts` the **Node** half hosting Mockttp; `routing.ts` resolves a service to record/serve/deny. |
| `capture/` | Turning proxied traffic into rows: recorder, URL normalization, HAR import, the launch wrapper. |
| `scrub/` | Secret scrubbing, and the rule set it runs. |
| `mocks/` | The corpus and mock serving: `corpus.ts` exports it, `loader.ts`/`host.ts` serve generated mocks, `state.ts` is the stateful store. |
| `providers/` | The provider seam (`types.ts`) and its two implementations, `emulate.ts` and `generated.ts`. |
| `issues/` | The issue engine — every unservable request becomes a self-contained work item. |
| `sandbox/` | The sealed boundary: `engine.ts` is the container-runtime seam, `sandbox.ts` owns the topology, `verify.ts` runs the escape attempts. |
| `seal/` | Certification: running the flows inside the sandbox, and the stamp that ages. |
| `scenario/` | Runtime knobs and auth profiles. |
| `drift/` | Drift watch: re-recording the flows against the real services and diffing. |
| `redirect/` | The portless seam — stable local names, wrapped and optional. |
| `gui/` | Serving the shell (token injection, CSP) and the panels. |
| `cli/`, `mcp/`, `skills/` | The three agent/human surfaces, all clients of the daemon API. |
| `db/` | Drizzle schema and client; migrations in `packages/mocktown/drizzle/`. |
| `config/` | Project resolution, config schema, on-disk paths. |

Design rationale lives in [`docs/design`](docs/design/README.md). Read the file for the
subsystem you are touching, not all of them.

## Architecture

- **One daemon owns everything.** The CLI, HTTP API, and MCP server are all thin clients
  of the daemon's local HTTP/JSON API. Add capability to the contract, not to a surface.
- **The front door runs Mockttp in a Node sidecar, not in Bun** — its native TLS path
  segfaults under Bun (`spikes/01-mockttp-bun/FINDINGS.md`). The sidecar must stay a real
  `node` process, which is why `bunfig.toml` omits `[run] bun = true`: that setting shims
  `node` to Bun and silently breaks the front door.
- **Nothing reaches a real upstream silently** — the worst failure this product has. Every
  Mockttp rule sets `.always()` (one that expires forwards upstream), the fallthrough
  denies loudly, and any new path that resolves a service to a mode defaults to deny rather
  than forward.
- **Scrub before disk.** The corpus you can browse is the corpus that exists.
- **The sandbox does not run a second front door.** The proxy stays on the host and the
  sealed network reaches it through a relay that only forwards bytes, so sandboxed traffic
  lands in the same corpus and issue queue as a recorded child process. The CA private key
  never enters a container.
- **A response with `ok: false` exits the CLI non-zero.** That is what makes
  `mocktown seal verify` usable as a CI step; do not add per-command exit-code flags.
- **The GUI is a client of the contract, not a second implementation.** It imports
  `mocktown/contract` and builds the same `OpenAPILink` client the CLI uses; every hook in
  `packages/gui/src/hooks.ts` is one procedure and nothing else.
- **The GUI's bearer token is injected by the daemon** as a `<meta name="mocktown-boot">`
  element when it serves the HTML. Never bundle it, never put it in a URL.
- **A panel document may not reach the network.** Panels are served under
  `default-src 'none'; connect-src 'self'` with no external origin; the iframe sandbox is not
  the boundary, the CSP is.
- **Drift and portless are both off by default and must stay that way.** A drift run calls
  real third-party APIs; portless binds 443 with sudo and touches the system trust store.
- **gRPC cannot be served by a generated mock** — `Bun.serve` does not accept HTTP/2. Record
  it, deny it with the reason, and do not add a route-matching path for it.

## Key Conventions

- **Runtime**: Bun. **Language**: TypeScript (strict, ESNext, `nodenext` modules).
- **Formatting**: Biome — 2-space indent, single quotes, 140 char line width, LF.
- **Imports**: use `.ts` extensions in source imports (`verbatimModuleSyntax` is on).
- **Zod**: always `import * as z from 'zod/v4'` — never bare `zod` or `zod/v3`. Enforced by Biome.
- **No parameter properties.** `erasableSyntaxOnly` is on; declare fields explicitly and
  assign them in the constructor body.

## Coding Conventions

- Avoid `any`. Always use top-level `import type`, never inline `import('./module.ts').Type`.
- **Comments carry the *why*, at the density of the code around them.** This codebase
  explains decisions, workarounds and invariants in prose, and new code is expected to do
  the same — a non-obvious choice with no comment is incomplete. Never restate what the line
  already says.
- Prefer early returns over nesting, and single-line `if` for simple conditions.
- **One source of truth.** Look for an existing utility before adding one; delete dead code
  rather than commenting it out; when you move something, update every importer instead of
  leaving a re-export behind.
- Refactor a file that grows past ~600 lines.

## Documentation

When you change user-facing behavior, update it in the same change: the subsystem's file in
`docs/design/`, `packages/mocktown/README.md`, and the prompt packs in
`packages/mocktown/src/skills/index.ts` when the change affects what an agent is told to do.
Documentation must not go stale.

## Changelogs

Releases are managed by [Tegami](https://tegami.fuma-nama.dev) (config in
`scripts/tegami.mts`). When asked to commit with a changelog entry, run
`bun run tegami` or add a `.tegami/*.md` file directly. Each entry has
`packages:` frontmatter (package + bump type) and a body with at least one
heading. Keep entries concise — user-facing changes only, no implementation detail.
