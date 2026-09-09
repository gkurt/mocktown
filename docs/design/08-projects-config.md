# 08 — Projects, Config Layering & Storage

**Status:** Implemented — phase 1

Mocktown supports multiple named **projects**. Resolution follows the git/kubectl
"context" pattern, with agent-safety guardrails.

## Project resolution order

1. `--project <name>` CLI flag
2. `MOCKTOWN_PROJECT` env var
3. Local project file: nearest `mocktown.json` walking up from cwd
4. Global default (initially `main`), set via `mocktown project use <name>`

**Rule: every command prints the resolved project in its first output line.**
Misdirection must be visible, never silent.

*Amended 2026-08-31 by the phase-1 implementation.* Resolution happens in the **surface**,
not the daemon — the daemon only ever receives a project *name*, so it cannot know which
rung produced it. The surface therefore sends `source` alongside `project`: the CLI sends
how it resolved, the MCP server sends its own resolution (neither is a model-supplied
argument), and a caller that says nothing gets `unknown` rather than a plausible guess.
Reporting a resolution that did not happen is the same failure as not reporting one.

**Rule: Mocktown-generated agent instructions always pin `MOCKTOWN_PROJECT`
explicitly** — never rely on the mutable global default. Rationale: the kubectl
current-context footgun; concurrent agents across projects would cross-contaminate
the moment one switches the default.

## The committed project file: `mocktown.json`

Lives at the repo root, **committed**, so project identity travels with the code —
a teammate or agent clones and `mocktown up` just works.

```jsonc
{
  "project": "acme-api",
  "services": {
    "api.stripe.com":        { "provider": "emulator:stripe", "seed": "seeds/stripe.yaml" },
    "internal-billing.acme": { "provider": "generated:billing" },
    "telemetry.acme":        { "provider": "passthrough" }
  },
  "sandbox": { "image": "auto" },
  "seal":    { "flows": ["bun test:integration"] }
}
```

Committed alongside: `.mocktown/mocks/` (generated mock modules) and `.mocktown/panels/`
(workspace GUI panels) — both hand-authored, both worth having on the next clone.
**Never committed:** recordings DB, CA private key, `.env.mocktown` if it embeds
ports (regenerate instead).

`.mocktown/` decides for itself what of it is committed, via a `.mocktown/.gitignore`
that `mocktown init` writes — so mocktown adds exactly one line (`.env.mocktown`) to a
`.gitignore` that belongs to the project. It is also the only form that works: git does
not descend into an ignored directory, so a repo-level `.mocktown/` would make anything
underneath it unreachable however the rules inside were written.

**That file names what mocktown derives, and ignores nothing else.** Machine-local
config, the generated JSON Schema, and the issue files mirrored from the database. The
mocks, the panels, and whatever else someone keeps beside them are committed without
needing a rule — an ignore-everything form silently swallows anything mocktown has not
been taught about, and the loss shows up on someone else's clone rather than on the
machine that caused it.

`dirs` in `mocktown.json` moves any of the three directories; `mocktown.json` and
`.env.mocktown` stay at the root, being the project's identity and a file loaded by name
from a shell.

## Config layers (lowest to highest precedence)

1. Built-in defaults
2. Global: `~/.config/mocktown/config.json` — default project, GUI prefs, telemetry
   opt-out, EKB user overrides
3. Project file: `mocktown.json` (committed, shared)
4. Local overrides: `.mocktown/config.local.json` (gitignored — machine-specific
   ports, personal passthroughs)
5. Env vars / flags

## Storage layout

```
~/.config/mocktown/config.json          # global config + project registry
~/.local/share/mocktown/<project>/      # machine-local, never committed
  ├─ mocktown.sqlite                    # recordings, issues, EKB, seal stamps, mock state
  ├─ blobs/                             # content-addressed large bodies
  ├─ sandbox.json                       # present only while the boundary is up
  └─ ca/                                # project root CA (key: 0600)
<repo>/mocktown.json                    # committed identity + service registry
<repo>/.env.mocktown                    # generated, gitignored
<repo>/.mocktown/                       # one directory, `dirs`-configurable
  ├─ .gitignore                         # generated: names the derived entries below, nothing else
  ├─ mocks/                             # committed — the agent loop's output
  ├─ panels/                            # committed — workspace GUI panels
  ├─ issues/*.json                       # mirrored from the database each session
  ├─ config.local.json                  # machine-specific
  └─ mocktown.schema.json               # generated, for the editor
```

(macOS/Windows: platform-appropriate XDG equivalents; paths resolved by one module.)

The registry in global config maps project name → data dir, so `mocktown --project
foo` works from anywhere; a repo-local `mocktown.json` naming an unregistered project
auto-registers it on first use.

*Amended 2026-09-01 by the phase-4 implementation:* the registry also maps project name →
**workspace**, and resolution now falls back to it. It has to: the daemon serves every
project from wherever it happened to be started, so for all but one of them there is no
`mocktown.json` above its cwd — and until this landed, everything workspace-dependent
(issues on disk, generated mocks, panels, `env write`) was silently missing for those
projects rather than reported. The registered workspace is only used when it still holds a
`mocktown.json` naming that project, so a moved or deleted repo degrades to "no workspace"
instead of resolving to a stale path.

## Removing a project

*Added 2026-09-09.* Registration only ever accreted: a registry entry outlived the checkout
it named, and nothing could take it out again. `mocktown project remove --name <p>` is the
safe half — it unregisters and leaves the data where it is, which is the fix for an entry
pointing at a repo that has moved or gone.

`--data` is the other half, and it is the most destructive thing in the product: the corpus,
the issue history, the seal stamps and the project's **root CA** all live in that directory.
Four things guard it, and each one is guarding against a different mistake:

- **The confirmation is an input, not a flag.** `--confirm <name>` must repeat the project's
  own name. A flag is one keystroke away from a command that only meant to unregister, and
  an agent calling the MCP tool has no way to express "I meant it" that a bare flag would
  not also satisfy by accident. Since the CLI, the MCP server and the GUI are all clients of
  one contract, a guard that lives anywhere but the procedure is not a guard.
- **A running front door or an up sandbox refuses the delete** rather than being silently
  orphaned. The sandbox is asked about through its topology file, which exists only while the
  boundary is up — so the question can be answered without building a runtime for a project
  that is being deleted.
- **The project's runtime is retired first.** The daemon keeps one runtime per project for
  its whole lifetime, holding an open SQLite handle. Unlinking under it succeeds on macOS and
  Linux while the process keeps writing to files that no longer have names, and is refused
  outright on Windows. Nothing in this path may call `runtimeFor` on the target either: it
  creates on miss and calls `ensureDirs`, which would recreate the directory the call came to
  delete.
- **A project name must be a single path segment.** The name arrives from `--project`,
  `MOCKTOWN_PROJECT` and a committed `mocktown.json`, validated only as a non-empty string —
  so `../../x` was a legal name resolving a data directory outside `mocktown/` entirely.
  Reading and writing there was already wrong; with a delete path it is a traversal with an
  `rm -rf` on the end of it, so the check lives in `config/paths.ts` where every path is
  built rather than in the handler that noticed.

Two consequences of resolution order that the command reports rather than hides:

- **The resolved project cannot remove itself.** Every command re-registers the project it
  resolves to, so the removal would be undone by the next one — and `--data` would delete a
  directory the same command recreates. Run it from outside the repo, or with `--project`
  naming another.
- **A repo whose `mocktown.json` still names the project will re-register it.** That is
  auto-registration working as designed, and silence about it would make the project's
  reappearance look like the removal having failed.

Removing the global default moves it back to `main`, because a default is a name rather than
a reference: left pointing at a removed project it would resolve every later command to
something that is not there.

**Not in the GUI, deliberately.** Every GUI page is scoped to one resolved project, and this
is the one operation that acts across projects and cannot be undone. The `--confirm <name>`
gesture is what makes it safe, and a typed name belongs in a terminal; a button that opens a
dialog to collect it would be a worse version of the command. `mocktown project remove` is
the whole interface.

## CLI shape (illustrative)

```
mocktown init [name]            # write mocktown.json, register project
mocktown project list|use <n>   # manage global default
mocktown project remove         # unregister, and optionally delete the data (irreversible)
mocktown record -- <cmd>        # host-mode recording (03)
mocktown sandbox up|record      # sealed environment (04)
mocktown env                    # emit .env.mocktown + agent task list (05)
mocktown seal verify            # certification run, CI-friendly exit code (05)
mocktown issues [list|show]     # the loop (07)
mocktown status                 # resolved project, services, providers, seal state
```
