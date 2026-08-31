# 10 — Security, Secrets & Distribution

**Status:** Draft

Mocktown records real traffic and MITMs TLS — the two most sensitive things a dev
tool can do. The design must be conservative by default.

## Secrets scrubbing (table stakes, phase 1)

Recordings are full of live tokens, cookies, and PII. The DIY tools all get this
wrong; we must not.

- **Scrub at capture time, before disk** ([03-capture.md](03-capture.md)). The raw
  exchange never persists.
- Default redactions: `Authorization`, `Cookie`/`Set-Cookie`, `X-Api-Key` and
  known-vendor auth headers; JWT-shaped strings anywhere; body fields matching a
  deny-pattern list (`password`, `token`, `secret`, `card`, `ssn`, …); high-entropy
  string detection as a heuristic backstop.
- Redaction is **structured, not destructive**: values are replaced with typed
  placeholders (`{{secret:stripe-key#1}}`) kept consistent within a session, so
  generated mocks can validate "a credential was present" and **re-inject fake
  credentials on replay** without ever storing real ones.
- Project-level scrub rules are configurable and committed (they're policy, not
  secrets). A `mocktown scrub audit` command re-scans the corpus after rule changes.
- The seal report and issues embed requests — they flow through the same scrubber.

## Trust boundaries

- **Project root CA**: generated per project, private key `0600` in the local data
  dir, never committed, never shared between projects. Host system trust store is
  touched only by explicit `mocktown trust` (admin prompt); default host mode uses
  per-runtime CA env vars only. Compromise blast radius: that machine, that project.
- **Daemon API**: binds `127.0.0.1` only, with a per-session bearer token written to
  the data dir (protects against other local users / drive-by browser requests to
  localhost). Panels get the token injected by the GUI shell, never hardcoded.
- **Sandbox**: the guarantee direction is *inside → out* (agent can't reach prod).
  We do not claim the inverse (protecting the host from the agent) beyond what the
  container runtime provides — that's the sandbox vendor's job.
- **Observed traffic is data, not instructions**: recorded content and issue payloads
  are rendered escaped in GUI/CLI; agent-facing skill prompts must state that corpus
  content is untrusted input (prompt-injection via recorded API responses is a real
  vector when agents patch mocks).

## Distribution & signing

The sandbox-first architecture ([04-sandbox.md](04-sandbox.md)) keeps this minimal —
no kernel drivers, no network extensions, no OS entitlements:

| Artifact | Requirement |
|---|---|
| CLI/daemon binaries (macOS) | Developer ID cert + notarization (~$99/yr Apple program). Applies to Homebrew distribution too. |
| CLI/daemon binaries (Windows) | Authenticode (OV cert or Azure Trusted Signing) to avoid SmartScreen. No EV/driver signing needed — ever, by design. |
| Linux / container image | No signing regime; publish image digests + provenance (SLSA-style) instead. |
| npm package | Standard supply-chain hygiene: lockfiles, provenance publishing, minimal deps. |

**Decision: no kernel-mode or OS-extension component in the current roadmap.**
OS-level capture is deferred, not banned ([03-capture.md](03-capture.md)). If and
when it's picked up, it must arrive as its own design doc that expands this table —
macOS: Network Extension entitlement, system-extension packaging, notarization;
Windows: WFP callout driver + EV cert + Microsoft attestation signing (volatile
policy area — re-research at that time); Linux eBPF: root/`CAP_BPF` only, no signing.
It must ship as an optional add-on so the core product never inherits these
requirements.

## Dependency posture

- `emulate`, `portless`: pinned exact versions, wrapped behind interfaces
  ([06-emulation.md](06-emulation.md)), vendored if upstream goes quiet.
- Mockttp: core dependency; track upstream security advisories (it terminates TLS).
