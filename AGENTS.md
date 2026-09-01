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
spikes/                Throwaway investigations, kept for their FINDINGS.md
docs/design/           Per-subsystem design docs — the source of truth for intent
```

`packages/mocktown/src`:

| Path | Responsibility |
| --- | --- |
| `daemon/` | The long-running server that owns all logic. `server.ts` serves the API, `runtime.ts` holds per-project state, `router.ts` wires the oRPC contract. |
| `contract/` | The oRPC contract — the single API definition the CLI, HTTP API, and MCP surface all derive from. |
| `frontdoor/` | The capture proxy. `controller.ts` is the daemon half; `sidecar.ts` is the **Node** half that hosts Mockttp. `ca.ts` handles TLS, `routing.ts` decides record vs. serve vs. deny. |
| `capture/` | Turning proxied traffic into rows: `recorder.ts` persists, `normalize.ts` derives route keys, `har.ts` imports HAR, `launch.ts` runs the child under capture. |
| `scrub/` | Secret scrubbing. Runs **before** anything reaches disk — `scrubber.ts` plus the rule set in `rules.ts`. |
| `mocks/` | The corpus and mock serving: `corpus.ts` exports the agent-legible corpus, `loader.ts`/`host.ts` serve generated mocks, `match.ts` matches requests, `state.ts` is the stateful store, `verify.ts` checks mocks against recordings. |
| `providers/` | The provider seam (`types.ts`) and its two implementations: `emulate.ts` supervises an `emulate` process, `generated.ts` serves our own mocks. |
| `issues/` | The issue engine — every unservable request becomes a self-contained work item. |
| `sandbox/` | The sealed boundary: `engine.ts` is the container-runtime seam, `images.ts` generates the Dockerfiles, `sandbox.ts` owns the topology, `verify.ts` runs the escape attempts against a negative control, `devcontainer.ts` emits the feature. |
| `seal/` | Certification: `certify.ts` runs the flows inside the sandbox, `stamp.ts` records and ages the stamp. |
| `scenario/` | Runtime knobs and auth profiles. |
| `cli/`, `mcp/`, `skills/` | The three agent/human surfaces, all clients of the daemon API. |
| `db/` | Drizzle schema and client; migrations live in `packages/mocktown/drizzle/`. |
| `config/` | Project resolution, config schema, on-disk paths. |

Design rationale lives in [`docs/design`](docs/design/README.md). Read the file for the
subsystem you are touching, not all of them.

## Architecture

- **One daemon owns everything.** The CLI, HTTP API, and MCP server are all thin clients
  of the daemon's local HTTP/JSON API. Add capability to the contract, not to a surface.
- **The front door runs Mockttp in a Node sidecar, not in Bun.** Mockttp's native TLS
  path segfaults under Bun (see `spikes/01-mockttp-bun/FINDINGS.md`). The sidecar is
  spawned as a real `node` process — which is why `bunfig.toml` deliberately omits
  `[run] bun = true`, since that setting shims `node` to Bun inside `bun run` scripts
  and silently breaks the front door.
- **Every Mockttp rule sets `.always()`**, and the fallthrough denies loudly. A rule that
  silently expires would forward traffic to the real upstream — the worst failure this
  product has.
- **Scrub before disk.** The corpus you can browse is the corpus that exists.
- **The sandbox does not run a second front door.** The proxy stays on the host; the sealed
  network reaches it through a relay container that only forwards bytes, so sandboxed
  traffic lands in the same corpus, issue queue and providers as a recorded child process —
  and the CA private key never enters a container.
- **A response with `ok: false` exits the CLI non-zero.** That is what makes
  `mocktown seal verify` usable as a CI step; do not add per-command exit-code flags.

## Key Conventions

- **Runtime**: Bun. **Language**: TypeScript (strict, ESNext, `nodenext` modules).
- **Formatting**: Biome — 2-space indent, single quotes, 140 char line width, LF.
- **Imports**: use `.ts` extensions in source imports (`verbatimModuleSyntax` is on).
- **Zod**: always `import * as z from 'zod/v4'` — never bare `zod` or `zod/v3`. Enforced by Biome.
- **No parameter properties.** `erasableSyntaxOnly` is on; declare fields explicitly and
  assign them in the constructor body.

## Coding Conventions

- Prefer colocation.
- Use TypeScript with strict typing. Avoid `any` unless absolutely necessary.
- Always use top-level `import type` for type imports. Never use inline
  `import('./module.ts').Type` syntax in type annotations.
- Avoid verbose code comments; write self-explanatory code. Comments are acceptable for:
  - Explaining complex logic, workarounds, or decisions
  - Documenting public APIs (functions, classes, modules)
  - TODO/FIXME notes
  - When the user specifically asks for comments
- Prefer concise, clear code:
  - Prefer early returns to reduce nesting.
  - Prefer single-line `if` statements for simple conditions.
- If a file gets too long (e.g. >600 lines), refactor into smaller modules.
- Check for existing utilities/hooks/components before creating new ones. Avoid duplication.
- Remove dead and commented-out code; don't preserve old APIs unless asked.
- When moving or relocating code (functions, components, utilities), don't leave a re-export behind for backwards compatibility. Update every importer to point at the new location and delete the old definition, so there is a single source of truth.

## Documentation

When changing user-facing APIs, update all relevant docs in the same change:
docs pages, README.md, SKILL.md, AGENTS.md, llms.txt. Documentation must not go stale.

## Changelogs

Releases are managed by [Tegami](https://tegami.fuma-nama.dev) (config in
`scripts/tegami.mts`). When asked to commit with a changelog entry, run
`bun run tegami` or add a `.tegami/*.md` file directly. Each entry has
`packages:` frontmatter (package + bump type) and a body with at least one
heading. Keep entries concise — user-facing changes only, no implementation detail.

`packages/mocktown` is still `private: true`, so Tegami versions it and writes the
changelog but skips the npm publish. Only `packages/*` is releasable; `spikes/*` are
workspace members for dependency installation and are never versioned.
