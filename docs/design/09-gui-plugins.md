# 09 — GUI, State Visibility & the Panels Plugin Model

**Status:** Draft — only the Drizzle Studio hookup is built (phase 1); the GUI and panels are phase 4

The GUI is a **thin shell over the daemon API** ([02-architecture.md](02-architecture.md)).
It never gains logic of its own — that is the one architectural line that must hold,
because it's what makes the plugin model nearly free and what keeps headless (CLI/CI/
agent) use at full parity.

## Phase 1: ship visibility cheaply

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

## The panels plugin model (later phase — but the constraints apply now)

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

## Explicitly later

- Custom recordings-diff/timeline views (Drizzle Studio covers browsing until then)
- Panel distribution/sharing between projects
- Desktop shell packaging
