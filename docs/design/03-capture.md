# 03 — Traffic Capture & the Front Door

**Status:** Draft

All traffic — recording real APIs and serving mocked ones — flows through one proxy,
the **front door**. Its behavior per service is a mode, not a separate binary:

| Mode | Behavior |
|---|---|
| `record` | Forward to the real upstream, persist the scrubbed exchange |
| `mock` | Route to the service's provider (emulator or generated mock) |
| `passthrough` | Forward without recording (explicitly allowlisted hosts only) |
| `deny` | Refuse + file an issue (default for unknown hosts in sealed mode) |

## Capture tiers

**Decision: explicit (cooperative) capture for now; OS-level capture is deferred,
not banned.**
The app reaches the front door via `HTTP(S)_PROXY` env vars, SDK endpoint config, or —
in the sandbox — DNS override ([04-sandbox.md](04-sandbox.md)). Rationale: Mocktown
records the developer's *own* app; when you control the launch, the escalation ladder
below matches or beats OS-level capture's coverage at zero signing/entitlement cost.

The escalation ladder — each rung covers the previous rung's failure case:
1. **Launch wrapper** — `mocktown record -- <command>`: injects proxy env vars and CA
   knobs (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`,
   `JAVA_TOOL_OPTIONS`, …) into the child process tree. Covers well-behaved runtimes,
   which is most of them.
2. **Launched browser** — for web-app client traffic: fresh browser profile,
   `--proxy-server` set, CA trusted in that profile only (HTTP Toolkit's pattern).
3. **In-sandbox record mode** — for code that ignores proxy env vars: inside the
   namespace there is no "direct"; everything transits the front door by construction.
4. **HAR import** — `mocktown import <file.har>`: the escape hatch for traffic only
   observable with another tool (Charles, Proxyman, mitmproxy, browser DevTools).
   Imported exchanges run through the same scrubber and land in the same corpus.

**Future improvement (much later stage): OS-level transparent capture** — macOS
`NETransparentProxyProvider` system extension, Windows WFP, Linux eBPF. Revisit when
we want to capture apps the user *cannot* launch on their own terms (third-party
desktop apps, system services), or when ladder rungs 1–3 demonstrably fail for a
significant user segment. Prerequisites recorded in [10-security.md](10-security.md):
Apple entitlement + notarization, Windows driver attestation, process-filtering UX
for machine-wide noise. Agents: do not treat OS-level capture as forbidden — treat it
as unscheduled and gated on those criteria, to be proposed with its own design doc.

## TLS

Each project gets its own root CA (generated at project creation, key in the project
data dir, never committed).

- **Sandbox:** CA baked into the image trust store + every runtime knob at build time.
  Solved by construction.
- **Host:** we do *not* touch the system trust store by default. `mocktown record`
  injects per-runtime env (`NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`,
  `CURL_CA_BUNDLE`, Java via `-Djavax.net.ssl.trustStore` guidance). `mocktown trust`
  exists for users who want system-level trust and prompts for admin explicitly.
- **Pinned clients:** detected (TLS handshake fails post-MITM), reported as a
  `pinned-client` issue, documented as out of scope.

## Recording format

An exchange is stored as one row (see [02-architecture.md](02-architecture.md) for the
DB): `service`, `method`, normalized `path` + template guess (`/orders/{id}`), query
params, request/response headers (scrubbed), bodies (scrubbed, content-addressed blobs
for large payloads), timing, and a `session` tag grouping one recording run.
Normalization (path templating, volatile-header stripping) happens at write time so
the corpus is immediately agent-legible — the raw exchange is *not* kept after
scrubbing ([10-security.md](10-security.md)).

## Explicitly deferred

- HTTP/3 / QUIC (deny at the front door so clients fall back to h2)
- WebSocket *mocking* (recording yes; generated mocks treat WS as passthrough or deny
  until [11-roadmap.md](11-roadmap.md) phase 3)
- gRPC (record as opaque h2 first; typed support later)
