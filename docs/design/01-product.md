# 01 — Product Thesis & Positioning

**Status:** Draft

Mocktown is the **dependency plane of the agent sandbox**. Compute isolation
(containers, microVMs, worktrees) is commoditized; nothing on the market isolates an
application's *dependencies* — the third-party and internal APIs it calls — while
keeping them realistic enough that the application behaves as it would in production.
Mocktown fills that slot.

## The core loop

1. **Record** — capture an application's real outbound traffic (HTTP/S) during normal
   development use.
2. **Emulate** — serve those dependencies back: well-known services via stateful
   emulators, the long tail via mocks generated from recordings by coding agents.
3. **Seal** — run the app (and any agents driving it) inside a boundary where mocked
   services are the only reachable network, so nothing can touch staging or prod.
4. **Heal** — any request that matches no mock becomes an **issue**; agents consume
   issues and incrementally patch the mocks. The mock environment stays alive as the
   real APIs drift.

## Who it's for

- **Coding agents** (primary): run unattended against a full-fidelity fake world.
  Every CLI output, config file, and error message is designed to be agent-legible.
- **Developers** (secondary): fast, offline, deterministic local dev against mocked
  dependencies; a launched, proxy-configured browser for web apps.
- **CI** (tertiary): the sealed environment as a deterministic integration-test bed;
  the seal certification re-runs on every commit.

## Competitive landscape (as of 2026-08)

| Tool | What it covers | What it lacks |
|---|---|---|
| [Keploy](https://github.com/keploy/keploy) | eBPF record → mocks/tests, "production sandboxes" | Linux/container-centric; fixtures for replay, not a living mock environment |
| [HTTP Toolkit / Mockttp](https://httptoolkit.com/) | Cross-platform HTTPS interception, one-click mock rules | Rules live in-tool; no standalone mock output, no agent loop |
| WireMock / Mockoon / MockServer / Hoverfly | Proxy-record → stub generation; WireMock logs unmatched near-misses | Stateless stubs; no agent-driven maintenance; per-service, not an environment |
| [vercel-labs/emulate](https://github.com/vercel-labs/emulate) | Stateful, SDK-compatible emulators for ~14 famous services incl. OAuth | Only famous services; no recording, no long tail, no capture/seal |
| E2B / Daytona / microsandbox / Modal | Compute isolation for agents | No dependency mocking at all |

**Differentiators:** (a) the closed loop *unseen request → issue → agent patches mock*;
(b) recordings as an agent-legible corpus, not just replay fixtures; (c) one front door
composing emulators + generated mocks + deny-by-default; (d) the seal certification
that makes cooperative env-var setups verifiable.

**Window risk:** emulate's existence proves the giants see this space. Ship the thin
composed version fast; the long-tail generator and endpoint knowledge base are the
accreting moats.

## Non-goals and deferrals

- **Deferred, not banned: OS-level transparent capture** (macOS network extensions,
  Windows drivers, Linux eBPF). Mocktown records the developer's *own* app, and for
  an app you control the launch of, the cooperative ladder (launch wrapper →
  sandbox-record → HAR import, [03-capture.md](03-capture.md)) delivers the same
  coverage without the signing/entitlement cost. OS-level capture becomes worth
  building only if we later target apps users *can't* launch on their own terms —
  revisit criteria live in [03-capture.md](03-capture.md).
- **Intercepting certificate-pinned clients.** Documented as out of scope.
- **Mobile app capture.** Desktop, web, and server-side applications only (for now).
- **Being a general observability/debugging proxy.** Charles/Proxyman/HTTP Toolkit own
  that; recording exists to *build mocks*, not to browse traffic.

## Glossary

- **Project** — a named Mocktown workspace: its services, recordings, mocks, config.
- **Service** — one upstream dependency (e.g. `api.stripe.com`, `internal-billing`).
- **Provider** — something that can serve a mocked service: an *emulator* (from
  emulate), a *generated mock* (agent-built from recordings), or *passthrough*.
- **Recording** — a captured request/response exchange, post-scrubbing.
- **Issue** — a request that reached the front door and matched no provider, or
  mismatched an existing one (drift).
- **Seal** — the verified property that a given codebase+config leaks zero requests
  past the mocks. See [05-redirection.md](05-redirection.md).
- **Front door** — the single proxy all traffic flows through; routes per-hostname to
  providers. See [03-capture.md](03-capture.md).
- **Panel** — a single-file HTML plugin visualizing a service's state.
  See [09-gui-plugins.md](09-gui-plugins.md).
