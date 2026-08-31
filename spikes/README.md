# Phase 0 — Spikes

Throwaway code whose only product is a **decision**. Nothing here is imported by the real
implementation; each spike ends by writing its findings into `FINDINGS.md` and, where a
design decision changes, by editing the relevant `docs/design/*.md` block.

**Phase 0 is complete.** Every spike ran; every result is recorded in the design docs.

| Spike | Question it answers | Result |
|---|---|---|
| [01-mockttp-bun](01-mockttp-bun/) | Does Mockttp (MITM + h2 + WS) work under Bun's node-compat? | **Bun fails.** 6/6 on Node, 4/6 on Bun *after patching two dependencies*. [Details](01-mockttp-bun/FINDINGS.md) |
| [02-orpc-bun](02-orpc-bun/) | oRPC `OpenAPIHandler` + static files on `Bun.serve`; contract → CLI and → MCP | **10/10**, unpatched. [Details](02-orpc-bun/FINDINGS.md) |
| [03-emulate](03-emulate/) | emulate as managed child processes: start/stop/seed, real SDKs, OAuth | **7/8.** Viable wrapped; it binds every interface. [Details](03-emulate/FINDINGS.md) |
| [04-container-seal](04-container-seal/) | netns + DNS override + baked CA; raw-socket escape must fail | **8/8** against a negative control; IPv6 inconclusive. [Details](04-container-seal/FINDINGS.md) |
| [05-scrubber](05-scrubber/) | Scrubbing real recorded traffic without destroying it | **14/14** over a real captured corpus. [Details](05-scrubber/FINDINGS.md) |

## Decisions phase 0 produced

1. **The front door is a Node sidecar; everything else stays on Bun.** Mockttp under Bun
   loses HTTP/2 (Bun's `SNICallback` suppresses ALPN) and WebSockets (Bun's builtin `ws`
   shadows the npm package and lacks the socket-wrapping constructor), and can segfault.
   Neither is fixable from userland. → [02-architecture.md](../docs/design/02-architecture.md)
2. **We own the contract walk (161 lines), not an adapter.** `orpc-mcp` is a 0.x
   single-maintainer package; `trpc-cli` is tRPC-only. Owning it also lets house rules —
   MCP `readOnlyHint` from the HTTP method, `--json` on every command — be structural.
   → [02-architecture.md](../docs/design/02-architecture.md)
3. **A provider is a supervisor for N services, not one object per service**, because one
   emulate process serves several on consecutive ports. Its startup banner is not a
   readiness signal — probe, don't parse. → [06-emulation.md](../docs/design/06-emulation.md)
4. **The sandbox's DNS override must be a catch-all, not an alias list**, or unknown hosts
   become NXDOMAIN instead of filed evidence. → [04-sandbox.md](../docs/design/04-sandbox.md)
5. **Scrubbing classifies by shape first, location second**, so a Stripe key in an
   `Authorization` header is labelled `stripe-secret-key` and replay can re-inject a
   correctly-shaped fake. And no single rule deletion may leak a credential — a testable
   property, now tested. → [10-security.md](../docs/design/10-security.md)

## Open items carried into later phases

- **IPv6 seal is unverified** (spike 04). The test host had no IPv6 egress, so the sealed
  container's failure to reach IPv6 proves nothing. Re-run in phase 3 on a host with IPv6.
- **emulate exposes mock services to the LAN** (spike 03). Sandbox mode solves it by
  construction; host mode must warn, and a `--host` flag is worth upstreaming.
- **Two Bun bugs and two upstream PRs** are described in spike 01: a `httpolyglot` PR and a
  Mockttp PR (both small, both behaviour-preserving on Node), plus Bun bug reports for the
  ALPN/`SNICallback` and builtin-`ws` defects.
- **`NODE_USE_ENV_PROXY=1` belongs in the launch wrapper** (spike 05): without it,
  `fetch`-based SDKs escape the front door in host mode while appearing configured.

## Running them

Each spike has its own README with the exact command and pass/fail criteria. From the repo
root, `bun install` first; spike 01 additionally needs
`python3 spikes/01-mockttp-bun/apply-bun-patches.py` after every install, and spike 04
needs two `docker build` commands.
