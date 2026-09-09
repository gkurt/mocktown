# 09 — GUI, State Visibility & the Panels Plugin Model

**Status:** Implemented — Drizzle Studio hookup in phase 1; the shell, the live feed and the
panels model in phase 4

The GUI is a **thin shell over the daemon API** ([02-architecture.md](02-architecture.md)).
It never gains logic of its own — that is the one architectural line that must hold,
because it's what makes the plugin model nearly free and what keeps headless (CLI/CI/
agent) use at full parity.

## What the shell shows

- **Dashboard**: resolved project, services + provider status, seal state, live
  request feed (from the front door's event stream), issue list. All of it renders
  data from existing API endpoints.
- **Database viewer**: embed/link **Drizzle Studio** (`drizzle-kit studio`) over the
  project SQLite. Recordings, issues, EKB, mock state — browsable on day one with
  ~zero custom UI work. This satisfies "see into the saved state" until panels exist.
  *Amended 2026-08-31 by the phase-1 implementation:* `drizzle-kit` runs under Node, which
  cannot use `bun:sqlite`, so Studio needs its own SQLite driver (`@libsql/client`). It is
  an **optional** dependency — a platform where it fails to build should lose the viewer,
  not the product — and `mocktown studio` says which driver to install rather than letting
  drizzle-kit's own error surface. Studio reads the file directly, so the daemon remains
  the only writer.

**Decision: GUI is a local web app (Vite + React + TypeScript) served by the
daemon**, opened in the default browser. Stack rationale and rejected alternatives
(Electron, GPUI/native) are recorded in [02-architecture.md](02-architecture.md).
*Deferred:* a desktop shell is a Tauri wrapper around this same web app with the
daemon as a sidecar — pick it up only on real demand, since it adds
signing/distribution work ([10-security.md](10-security.md)) before there's UI worth
packaging.

*Amended 2026-09-01 by the phase-4 implementation:*

- **The shell is `packages/gui`** — Vite + React 19 + TanStack Router + TanStack Query +
  Tailwind v4 — built to static files and served by the daemon on the daemon's own port.
  One origin is what makes the token injection and the panel CSP below possible at all; a
  second dev-server port would have needed CORS and a second place to hold a capability.
- **It is a client of the same contract as everyone else.** The GUI imports
  `mocktown/contract` and builds an `OpenAPILink` client, exactly as the CLI and the MCP
  server do, so a procedure that changes shape breaks the GUI's typecheck instead of its
  runtime. `mocktown` gained a `./contract` export for this; the contract module pulls in
  only Zod, so nothing daemon-side reaches the browser bundle.
- **No TanStack Form or Store.** The shell's only write is a single-field mutation
  (a service's provider), so a form library and a second state store would have been
  machinery around a `<select>` and an invalidate. Revisit when a real form appears.
- **shadcn components are deliberately not vendored yet.** The five primitives the shell
  needs are hand-written and marked `TODO(registry)` where the house `@gkurt`
  shadcn-on-Base-UI registry should replace them — the swap wants a real dialog or combobox
  to justify it, not a table wrapper. *Partly superseded 2026-09-09: the registry's
  `scroll-utils` are vendored and DialKit owns the inputs — see below.*
- **The project comes from the daemon and `?project=` overrides it.**
  [08-projects-config.md](08-projects-config.md)'s rule is that the resolved project is
  always visible, not that the GUI owns resolution.
- **Nothing is startable from the GUI that costs containers or real money.** `seal verify`,
  `sandbox up` and `drift check` are read-only in the shell and named as CLI commands; a
  button that spends quota is a decision, and the CLI is where decisions are made.

*Amended 2026-09-09 — what the shell may destroy, and how it asks:*

- **The state reset is not confirmed.** [12-scenario-controls.md](12-scenario-controls.md)
  designed it to be cheap enough to run between test cases, so a guard would put friction on
  the fast path it exists for — and unlike a delete it has a defined result rather than a
  lost one: seeds re-apply, and what happened before stays in the corpus under the session it
  closed. What the page owes the reader instead is the *consequence*, so the new session id
  and any provider that had to restart are reported rather than the screen just refreshing.
  The State page had been showing state it could not reset, which reads as a missing button
  rather than a decision.
- **Every corpus delete is armed first.** It is irreversible, and the corpus is what mocks
  are generated and verified from ([03-capture.md](03-capture.md)). The delete lives on the
  Corpus page because that is the only screen on which a stray host or a route recorded from
  the wrong environment is *visible*; putting it elsewhere would mean reading it here and
  acting on it there.
- **Arming happens in place, not in a dialog.** "Delete these 14 recordings" is a row-level
  decision, and a modal that restates it in the middle of the screen adds a step without
  adding information the row did not already show. The button disarms itself, because one
  left armed behind a scroll is a trap for the next click that lands near it. The
  `TODO(registry)` for a real `alert-dialog` stays, for a confirmation that needs more room
  than a button holds.
- **Project removal is deliberately not here.** Every page is scoped to one resolved
  project, and that is the one operation that acts across projects and cannot be undone; its
  safety comes from typing the project's name, which belongs in a terminal
  ([08-projects-config.md](08-projects-config.md)).

*Amended 2026-09-09 — the inputs, the schemes, and where a row's detail goes:*

- **DialKit owns the dials and the inputs** (`packages/gui/src/dials.tsx`). Only the
  individual controls are mounted, which the package exports for exactly this; `DialRoot`,
  the preset menu and the timeline dock stay behind, and the `--dial-*` tokens are rebound
  to this app's palette in `styles.css`. What it buys is the part that is tedious and easy
  to get subtly wrong: a slider you can drag, scroll, arrow-key and type a number into, a
  select with a positioned keyboard-driven popup, an autosizing text field — behind one
  labelled row shape, so a `mocktown.json` setting, a scenario knob and a service's provider
  all read as the same kind of control.

  The Settings page is what made the case. Both halves of it were four-column tables with an
  input wedged into the second column, which is the wrong shape twice over: a knob declaring
  `minimum` and `maximum` — `latencyMs: 0–10000` is the canonical one — was a box to type
  JSON into rather than something to sweep, and the description, the only text that says what
  a knob *does*, was competing for width with the value it describes. The control is picked
  from the knob's own JSON Schema, so a mock that declares a bounded number gets a slider
  with no edit to the GUI ([12-scenario-controls.md](12-scenario-controls.md)'s "render their
  forms from the manifest", finally meant literally).

- **The controls commit; they are not live.** Every change on these screens is an API call
  that writes to a committed file or to project state, so the wrappers decide when a gesture
  is finished — a text dial on Enter, a slider a beat after the last movement rather than on
  every frame of a drag. Each holds the value it sent until the daemon reports the same one
  back; dropping it at commit time put the *old* value on screen for the length of the round
  trip, which reads as the control refusing what was just done to it.

- **A row's detail is a drawer, not an expanded row.** An expansion put the detail *below*
  the table: the row that opened it was pushed off screen by the thing it opened, every other
  row moved under the cursor, and an issue's diagnosis relaid out the page each time one was
  clicked. A drawer leaves the list where it was, so clicking down a queue compares issues
  instead of relayouting around them. It is a native `<dialog>` — modality, the top layer,
  focus containment, inert background and Escape are all platform behaviour, and being in the
  top layer is also what keeps it out of the containment the scroll fades create on the page
  behind it.

  Services joined Issues in using one. Its provider is the single decision on that screen —
  it decides whether a service records, denies or reaches the real world — and a `<select>`
  in a table cell read as one more column of data rather than as the one control there that
  changes what the front door does.

- **There is a light and a dark scheme, and following the OS stays a choice.** The palette is
  still written once with `light-dark()`; the setting only changes `color-scheme`, so native
  widgets follow it too and there is no second copy of the tokens. `system` is the absence of
  the attribute, and it is the default — a two-state toggle can only ever leave a reader
  pinned to one scheme.

  The stored value is applied by `public/theme.js`, a plain blocking script ahead of the
  bundle: every module is deferred, so by the time the bundle runs the page has painted once
  in the OS's scheme, and it cannot be inlined either, because the shell is served under
  `script-src 'self'`.

  **A panel gets the scheme in its query string**, next to the project. `color-scheme` does
  not cross a frame boundary — an iframe inherits the property but the document inside still
  resolves `prefers-color-scheme` against the OS — so a shell pinned to dark was framing a
  white panel. The shell reaching into the frame's document to fix that would be the shell
  knowing something about what a panel is; a query parameter is the convention a panel
  already reads the project from.

- **Scrollable regions fade at the edge and hide their scrollbar.** The registry's
  `scroll-utils` are vendored at `packages/gui/src/scroll-utils.css`: a thin bar that is
  transparent until the region is hovered or focused, and a mask that fades whichever edge
  can still be scrolled toward. The fade is pure CSS (`animation-timeline: scroll(self)`), so
  it costs no scroll handler and degrades to no mask where scroll-driven animations are
  missing.

- **Dashboard widgets are capped and scroll inside themselves.** Three of them grow without
  limit — the feed, the service table, the provider list — so one busy recording session
  decided the height of the whole page and left the seal state below the fold. One cap for
  every card rather than a number per card: matching heights are the point of a grid. The cap
  brings the fade's paint containment with it, which makes a capped card the wrong place for
  a dial, whose popup would be clipped to the card instead of escaping it.

- **No stylesheet in the build may reach off the machine.** DialKit's stylesheet opens with
  an `@import` for a Google-hosted font, which this shell may not fetch — it is served under
  a CSP with no external origin, so the request is refused and logged on every load, and a
  tool whose premise is that nothing leaves the machine silently has no business asking
  Google for a font. `vite.config.ts` strips remote `@import`s from any stylesheet in the
  build and says which, so the next dependency that ships one is caught by the build rather
  than by a console refusal.

### The token is injected, never bundled

The daemon inserts a `<meta name="mocktown-boot">` element carrying the API base, the
resolved project and the bearer token as it serves any HTML — the shell and panels alike —
with `Cache-Control: no-store`. A build sitting on disk therefore carries no capability, and
the token never appears in a URL, where it would land in shell and browser history.

A `<script type="application/json">` block would have read better and was tried first:
Chrome applies `script-src` to inline `<script>` elements whatever their type, so the data
was still readable but every page load logged a CSP refusal. A meta element has no argument
with the policy.

### The live feed is a long poll, not a stream

The feed is `GET /feed` with a cursor: the daemon parks the request for up to 25s, returns
whatever happened, and the client asks again with the cursor it was handed. An oRPC event
iterator was the obvious alternative and was rejected — an async iterator cannot be rendered
by the CLI or returned by MCP, so the feed would have become the one capability that exists
on a single surface. As a procedure it is one `fetch` in a loop, which a build-step-free
panel can do too, and `mocktown feed --follow` is the same call from a terminal.

Two properties the clients depend on: the cursor advances over the *unfiltered* window, so a
client watching one kind neither re-sees events nor parks forever on a quiet kind; and the
window is bounded (500 events), so a client that fell behind is told `gap: true` rather than
shown a feed with a hole in it. The feed carries no bodies, drops query strings and runs
path templates through the scrubber — a credential in a path segment is a real pattern.

## The panels plugin model

**Decision: no plugin *system*; plugins are single-file HTML panels.**
A panel is one self-contained HTML file in `<repo>/.mocktown/panels/` (or shipped
with a provider), with a tiny manifest:

```jsonc
// panels/stripe-state.json
{ "name": "Stripe state", "service": "api.stripe.com", "entry": "stripe-state.html" }
```

The GUI shell lists panels and iframes them; a panel talks to the same local API
(`GET /state/<service>/…`) as everyone else. No SDK, no build step, no version
matrix, no registry. This is deliberately the artifact coding agents are best at
producing — "write me a dashboard for the emulated Stripe state" is a one-shot
against a JSON API.

*Rejected:* a real plugin system (loading, sandboxing, API versioning, marketplace)
— a tax paid before knowing what plugins need, and the API would be designed wrong.
Revisit only if single-file panels demonstrably hit a wall.

### What we DO commit to from day one (the cheap discipline)

1. Everything visible in the GUI comes through the public daemon API.
2. Providers expose `state` introspection where feasible
   ([06-emulation.md](06-emulation.md)) → `GET /state/<service>` is the stable
   surface panels build on.
3. The API is versioned (`/api/v1/`) so panels don't break silently.
4. Panels are iframed with a restrictive sandbox attribute and same-origin API access
   only — they're local and low-risk, but the request feed contains scrubbed traffic,
   so no external network access from panel documents
   ([10-security.md](10-security.md)).

*Amended 2026-09-01 by the phase-4 implementation:*

- **The CSP is the boundary, not the sandbox attribute.** A panel needs the API, so its
  frame runs with `allow-scripts allow-same-origin`, and that combination is escapable by
  design. What actually holds is the response header: panel documents are served with
  `default-src 'none'; connect-src 'self'; script-src 'unsafe-inline'; style-src
  'unsafe-inline'; img-src 'self' data:` and no external origin of any kind — an image URL
  exfiltrates as well as a `fetch` does.
- **Panel URLs are paths from an untrusted document**, so they resolve through one function
  that refuses anything outside the two panel directories, and `..` cannot reach the repo.
- **Built-in panels ship with the product** under `source: 'builtin'`, and a workspace panel
  with the same name replaces one — the built-ins exist to be copied and edited. One ships
  now: a provider-state panel, which is the worked example the docs point at.
- **A manifest that cannot be used is reported, not dropped.** `panels.list` returns
  `problems` alongside `panels`; a panel that silently fails to appear reads as a bug in the
  shell rather than a typo in a file.

## Explicitly later

- Custom recordings-diff/timeline views (Drizzle Studio covers browsing until then)
- Panel distribution/sharing between projects
- Desktop shell packaging
- Registry components in the shell, and a real form once one is needed
- A project picker that lists projects: the API has no `projects.list`, and until it does the
  shell reads the daemon's resolved project and accepts `?project=`
