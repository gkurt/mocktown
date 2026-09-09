# mocktown

Record an app's outbound traffic, serve it back as stateful mocks, and keep those mocks
alive as the real services change.

This package is the whole product as of phases 1–4: the daemon, the front door, the
corpus, the providers, the issue engine, the sealed sandbox, drift watch, and the surfaces
(CLI, HTTP API, MCP, and the GUI shell, which is built from `packages/gui` and ships inside
this package).
Design rationale lives in
[`docs/design`](https://github.com/gkurt/mocktown/blob/main/docs/design/README.md) — read
the file for the subsystem you are touching, not all of them.

## Install

```bash
bun add -g mocktown
```

Mocktown runs on **Bun** — the CLI is TypeScript executed directly, so `bun` has to be the
thing that installs and runs it. Additionally, the front door is Mockttp in a Node process,
so a `node` binary has to be on the PATH of the shell that first starts the daemon — Bun
alone is not enough. `MOCKTOWN_NODE=<path>` names one explicitly.

Working on Mocktown itself instead? From the repo root:

```bash
bun install && cd packages/mocktown && bun link
```

## Quick start

In the app you want to mock:

```bash
mocktown init
```

If a coding agent is going to do the work, give it the skill:

```bash
mocktown skills install
```

That writes the pack into `.mocktown/skills/` and hands the directory to
[`skills`](https://github.com/vercel-labs/skills), which knows where each agent looks —
`.claude/skills/mocktown/` for Claude Code. The pack lives at this repo's root, so the same
installer reaches it without mocktown installed at all:

```bash
npx skills add gkurt/mocktown
```

It is one skill with the job as its argument:
`/mocktown generate-mock`, `/mocktown fix-issues`, `/mocktown record-flow`,
`/mocktown apply-redirects`, `/mocktown write-panel`. `--agent claude-code` picks the target
rather than being asked, `--global` installs for every project, and re-running it is how a
newer pack lands. Without an installer, `mocktown skills export` writes the same directory
and `mocktown skills get --name mocktown --topic <job>` prints one file.

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
3. A coding agent fills in the module — `mocktown skills install` puts the `mocktown`
   skill where the agent will find it, and `/mocktown generate-mock` is the prompt pack
   for exactly that job.
4. `mocktown serve start --sealed` serves it — a mock you have written takes over the
   service the recorder discovered, without a registry edit. Anything unserved is **denied
   loudly** and filed: `mocktown issues list --status outstanding` — open plus the ones
   whose last fix failed verification.
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

## Recording browser traffic

`mocktown record -- <cmd>` covers server-side SDKs by injecting proxy variables into a
child process. For the traffic a *page* makes, rung 2 of the ladder launches the browser
itself:

```bash
mocktown browser launch --url http://localhost:3000
```

The front door has to be running first — `record start` to capture what the browser does,
`serve start` to browse against mocks. **No system extension, and nothing added to the
system trust store.** The window gets a profile the project owns
(`--user-data-dir`), and the CA is passed as `--ignore-certificate-errors-spki-list`,
which names *one* public key for *this launch*: a stray HTTPS error in that window is
still an error, and no trust is written to disk. Chromium-family only.

Loopback is in Chrome's default proxy bypass, which is what you want — your dev server
stays direct while third-party scripts transit the front door.

### Driving it

`--debug-port` publishes a CDP endpoint so a driver — `agent-browser`, Playwright,
Puppeteer — can attach to that window and keep its capture:

```bash
mocktown browser launch --debug-port 0 --json
```

```bash
agent-browser connect ws://127.0.0.1:<port>/devtools/browser/<id>
```

`0` asks for an ephemeral port; the response carries the resolved
`debug.webSocketDebuggerUrl`, which is also what `chromium.connectOverCDP()` takes. It is
off by default because the endpoint is a **capability**: anything that reaches it drives
the browser, reads the profile's cookies and navigates it anywhere, with no further
authentication. Chrome's only defence is that it binds to loopback.

### Driving a browser of its own

A CLI browser that brings its own Chromium is rung 1, not rung 2: run it with the recorded
env and it transits the front door like any other child process. `agent-browser` reads
`HTTP_PROXY` and `NO_PROXY` on its own; what it cannot work out is the certificate, because
Chrome's verifier reads none of the CA variables. So the recorded env also carries the
project CA's public key in the form Chrome's own flag takes:

```
MOCKTOWN_CA_SPKI=<base64 sha256 of the CA's SubjectPublicKeyInfo>
AGENT_BROWSER_ARGS=--ignore-certificate-errors-spki-list=<the same key>
```

That names one key for that process. **Never substitute `--ignore-https-errors`**: it
accepts any certificate at all, and a certificate error in a recorded run is information —
the wrong project's CA, or a pinned endpoint that belongs in an issue.

A flow is usually more than one command, so open the session first and load the env:

```bash
mocktown record start --label checkout
mocktown env write
set -a && . ./.env.mocktown && set +a
agent-browser open https://app.example.com/checkout
agent-browser snapshot -i
mocktown record stop
```

The **first** agent-browser command launches the browser and fixes its proxy and its trust
for every command after it — `agent-browser close` before a differently configured run, or
you drive the previous one and record nothing. `/mocktown record-flow` is this page written
for an agent.

### What is not recorded

A real browser talks to its own vendor constantly, and none of it is evidence about a
dependency. Measured on one attended session against a staging app: **17 of the 22
discovered services were Chrome's own** — component updates, Safe Browsing lists, sign-in
probes, new-tab-page furniture, telemetry — and 5 were the app's. Two mechanisms handle it,
both on by default:

1. **The launch does not make the requests.** `browser launch` passes the flags that switch
   this traffic off at the source, and starts on `about:blank` rather than the new tab page.
2. **The corpus refuses the rest.** A known-noise request is not recorded, does not become
   a discovered service, and files no issue.

Filtering decides what is *written down*, never what is allowed out: an ignored request in
serve mode still hits the deny wall, it just does not queue an issue for a browser update.

**Most patterns are path-scoped, because these hostnames are shared.** The same session
that produced the list also contained `fonts.googleapis.com/css2` — the app's own web font
— and `accounts.google.com` is where a real OAuth flow lives. So `accounts.google.com/ListAccounts`
is noise and `accounts.google.com/o/oauth2/*` is not; `www.gstatic.com/og/` is noise and
`www.gstatic.com/your-app/` is not. A blanket `*.googleapis.com` rule would have silently
eaten a real dependency, which is worse than the noise it cleaned up.

Nothing is dropped silently. `record stop` reports the count and the reason per pattern, and
a session that dropped more than it kept says so as a warning.

```jsonc
// mocktown.json
{
  "capture": {
    "ignoreNoise": true,                        // the built-in list; true by default
    "ignore": ["telemetry.vendor.com", "cdn.vendor.com/beacon"],
    "keep": ["accounts.google.com"]             // record it anyway — a real OAuth dependency
  }
}
```

`keep` wins over everything, per host or per path prefix. `ignoreNoise: false` drops the
built-in list entirely and leaves your own `ignore` entries in force.

### Taking recordings back out

The corpus accretes, and sometimes it accretes something you do not want: a route recorded
against the wrong environment, a stray host, or — the case this exists for — a capture whose
secret the scrubber's rules did not match.

```bash
mocktown recordings delete --service noise.test --dry-run   # counts, writes nothing
mocktown recordings delete --service noise.test
mocktown recordings delete --service api.test --method GET --path-template '/v1/orders/{orderId}'
mocktown recordings delete --session ses_...                # one recording run
mocktown recordings delete --id rec_...                     # one exchange
```

A delete needs a subject — `--id`, `--session` or `--service`. `--method` and
`--path-template` narrow one of those and are not filters on their own: "every GET this
project ever recorded" reads like a filter and behaves like a wipe. There is no way to empty
the corpus by leaving arguments out.

Four things are worth knowing before you run it:

- **A spilled body shared with a surviving recording is not unlinked.** Large bodies are
  content-addressed, so a delete reference-counts rather than deleting by hash.
- **Emptying a service is reported loudly.** With no recordings left, a generated mock for
  that service is unbacked and `mocktown mocks verify` passes because it has nothing to
  replay — the one outcome here that could be mistaken for success.
- **An issue that cited a deleted row loses the link, not the issue.** The dead link is
  stripped and the issue's file rewritten; the issue keeps the whole scrubbed request it
  carries inline, so it stays actionable.
- **Generated mocks, the registry and the seal stamp are untouched.** A delete narrows the
  evidence, not the setup — a mock whose evidence is gone keeps serving exactly as before.

The GUI's Corpus page does the same thing per route and per service, armed by a first click
and run by a second.

### What still escapes this window

The note on every launch says the traffic is captured *cooperatively and best-effort*, and
that is meant literally — a flag on a process we asked nicely, not a boundary. Specifically:

- **Loopback.** By design, per above — but it means a third-party service reached under a
  `.localhost` name records nothing while looking perfectly wired up, the same trap the
  `NO_PROXY` note describes. Nothing at loopback is captured.
- **The HTTP cache and service workers.** A response served from disk cache or Cache
  Storage never touches the network, so it never reaches the front door. The profile
  **persists across launches**, so a second `browser launch` records less than the first.
  Delete the profile dir for a cold run, or drive `Network.setCacheDisabled` over CDP.
- **Anything that is not HTTP.** WebRTC's ICE/STUN/TURN is UDP and goes direct; an HTTP
  proxy cannot carry it.
- **Managed-Chrome proxy policy**, which takes precedence over command-line switches. On a
  corporate-managed machine the flag can be silently overridden.
- **Pinned and HSTS-preloaded endpoints**, which refuse the MITM certificate. Detected and
  filed as a `pinned-client` issue, out of scope by design.
- **The user.** It is an ordinary browser window with a normal route to the internet: a new
  browser process it spawns, an extension installed into that persistent profile, or the
  proxy settings edited in that window all reach the real internet.

Only the sandbox closes these, because inside it there is no route out to close. Never
present a launched browser as carrying the seal's guarantee. For traffic you can only
observe with another tool, `mocktown import --path <file.har>` is rung 4.

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
mocktown ui
```

`mocktown ui` (`mocktown gui` still works) opens the shell the daemon serves on its own port
— dashboard, live feed, issues, services, corpus, provider state, seal and sandbox, and
panels. When portless has claimed a stable name it opens `http://ui.mocktown` and prints the
loopback address beside it; `--loopback` forces the direct one. The bearer token is injected
by the daemon as it serves the page, so the build on disk carries no capability. The shell
ships inside the published package; working from a checkout, build it first (once) with
`bun run gui:build` from the repo root.

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

## Projects, and removing one

A project is a name, a data directory under `~/.local/share/mocktown/<name>/`, and a
registry entry in `~/.config/mocktown/config.json`. `mocktown init` writes the committed
`mocktown.json`; every command afterwards re-registers whatever project it resolves to, so
cloning a repo and running anything just works.

```bash
mocktown project list                                # every registered project, and the default
mocktown project use <name>                          # set the global default
mocktown project remove --name <name>                # unregister; the data stays
mocktown project remove --name <name> --data --confirm <name>   # delete the data too
```

Unregistering is the common one and it is safe: a registry entry outlives the checkout it
names, and `project list` marks a workspace that has gone. `--data` is the destructive one —
the corpus, the issue history, the seal stamps and the project's **root CA** all live in that
directory — so it will not run unless `--confirm` repeats the project's name. That is an
argument rather than a flag on purpose: `--data` alone is one keystroke from a command that
only meant to unregister, and an agent calling the MCP tool has no way to mean it that a bare
flag would not also satisfy by accident.

It refuses in three more cases, each with the fix in the message: while that project's front
door is running, while it has a sandbox up, and when the project is the one the command
itself resolved to — every command re-registers the project it resolves to, so removing it
there would be undone by the next one. Run it from another directory, or with `--project`
naming a different project.

Two things it tells you rather than hides: a repo whose `mocktown.json` still names the
project will register it again on the next command run there, and removing the global default
moves it back to `main`.

There is no GUI button for this. Every GUI page is scoped to one project, and the safety here
is a typed name, which belongs in a terminal.

## Stable local names (optional)

With [portless](https://github.com/vercel-labs/portless) installed and
`portless.enabled` in `mocktown.json`, each service gets a stable
`https://<service>.<project>.<tld>` name instead of a fresh loopback port on every
daemon restart, and `.env.mocktown` uses it. Mocktown proves the whole path works — it
registers a throwaway name and fetches it back through the proxy — before it claims a name,
and reports the reason if it cannot. `mocktown env portless get` shows the verdict.

`portless.tlds` is an ordered list, `["mocktown.localhost"]` by default. URLs are built from the
first one that *works*, not the first one configured: each is probed through the proxy, so
`.env.mocktown` picks up a fallback by itself on a machine where the preferred name cannot be
reached. `mocktown env portless get` lists both what answered and what did not, with the fix for
each — a TLD the proxy is not serving needs the proxy restarted, one it serves that does not
resolve needs `portless hosts sync`.

A bare `.mocktown` is supported, just not the default:

```json
{ "portless": { "enabled": true, "tlds": ["mocktown", "mocktown.localhost"] } }
```

It reads better and it is the same proxy, but it resolves only because portless writes
`/etc/hosts`, and it is under no reserved TLD — so keep the `.localhost` spelling behind it, and
expect your dev server to need it allowlisted (Vite, for one, permits `.localhost` and nothing
else by default).

One override: while the proxy has no TLS, a `.localhost` spelling leads even if you preferred
another. Browsers only keep a `Secure` cookie on a trustworthy origin, and over plain http
that means `localhost` and its subdomains — so a session on `http://…mocktown` is dropped
silently and the app bounces back to its login page. Start the proxy with TLS to get your
preference back.

The daemon's GUI is claimed the same way, as `ui.mocktown.localhost` (or `ui.mocktown`, under a
project that prefers it).
`portless alias` takes a name and not a TLD, so the proxy serves that name under every TLD it
has — including any you did not configure. What mocktown will not do is take the name from
something else: a `ui.*` route already pointing at another port is left alone and reported.

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
| `src/skills/` | Serving the shipped skill — the pack itself is `skills/mocktown/` at the repo root |
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
