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

Committed alongside: `mocks/` (generated mock modules), `seeds/`, curated fixtures.
**Never committed:** recordings DB, CA private key, `.env.mocktown` if it embeds
ports (regenerate instead). `mocktown init` writes the `.gitignore` entries.

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
  └─ ca/                                # project root CA (key: 0600)
<repo>/mocktown.json                    # committed identity + service registry
<repo>/mocks/ · seeds/                  # committed artifacts
<repo>/.mocktown/                       # local: issues/*.json, config.local.json (gitignored)
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

## CLI shape (illustrative)

```
mocktown init [name]            # write mocktown.json, register project
mocktown project list|use <n>   # manage global default
mocktown record -- <cmd>        # host-mode recording (03)
mocktown sandbox up|record      # sealed environment (04)
mocktown env                    # emit .env.mocktown + agent task list (05)
mocktown seal verify            # certification run, CI-friendly exit code (05)
mocktown issues [list|show]     # the loop (07)
mocktown status                 # resolved project, services, providers, seal state
```
