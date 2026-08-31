# 10 — Security, Secrets & Distribution

**Status:** Implemented in part — scrubbing and CA handling shipped in phase 1; distribution and signing remain

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
- **Shape beats location when labelling.** A Stripe key in an `Authorization` header is
  `{{secret:stripe-secret-key#1}}`, not `{{secret:auth-header#1}}` — the kind is what a
  generated mock reasons about, and what lets replay re-inject a correctly-shaped fake.
  Location-based rules supply the kind only when nothing recognises the value's shape.
- **No single rule deletion may leak a credential.** The named-field and shape/entropy
  passes are meant to overlap; in the phase-0 corpus a GitHub PAT was covered three times
  over (vendor pattern, header rule, entropy backstop). This is a testable property, not a
  happy accident — the spike asserts it.
- **The entropy backstop needs a character-class rule, not just a threshold.** A 48-char
  hex session id measures 3.59 bits/char, *below* an ISO timestamp's 3.49-safe threshold;
  no single cutoff separates them. Treat any token of ≥32 chars that is pure hex as a
  secret regardless of entropy. Everything else stays conservative — a false positive
  silently corrupts the corpus mocks are generated from.
- **Card numbers are decided by Luhn, not by length**, so amounts in minor units and epoch
  timestamps survive.
- Redaction is structure-preserving: JSON stays JSON, form encoding stays form encoding,
  cookie names and attributes survive with only values replaced, and auth schemes
  (`Bearer`, `token`) survive with only credentials replaced — otherwise 03-capture.md's
  "immediately agent-legible" corpus doesn't survive the scrubber.

*All of the above verified 2026-08-31 against a real captured corpus:*
[spikes/05-scrubber](../../spikes/05-scrubber/FINDINGS.md) (14/14).
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
| Bundled Node runtime (front door) | The proxy is a Node sidecar ([02-architecture.md](02-architecture.md)), so a Node runtime ships alongside the Bun-compiled binaries and must be notarized/signed with them, and installed in the sandbox image. |
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
