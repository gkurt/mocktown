# 03 — Traffic Capture & the Front Door

**Status:** Implemented — phase 1; WebSocket/gRPC mocking and OS-level capture remain deferred

All traffic — recording real APIs and serving mocked ones — flows through one proxy,
the **front door**. Its behavior per service is a mode, not a separate binary:

| Mode | Behavior |
|---|---|
| `record` | Forward to the real upstream, persist the scrubbed exchange |
| `mock` | Route to the service's provider (emulator or generated mock) |
| `passthrough` | Forward without recording (explicitly allowlisted hosts only) |
| `deny` | Refuse + file an issue (default for unknown hosts in sealed mode) |

**Implementation rule found in phase 0** ([spikes/05-scrubber](../../spikes/05-scrubber/FINDINGS.md)):
Mockttp rules stop matching once consumed unless `.always()` is set. A forwarding rule that
silently expires sends subsequent traffic to the **real** upstream — the worst failure mode
this product has. Two defences, both cheap: `.always()` on every rule, and a fallthrough
that **denies and logs** rather than passes through, so an escape is loud instead of silent.

**Two more rules found in phase 1/2, both about Mockttp's admin-server protocol** (the
daemon↔sidecar boundary, [02-architecture.md](02-architecture.md)):

- **Replace rules; never `reset()`.** `reset()` tears down the *server-side* event
  subscriptions while leaving the client-side callbacks registered, so re-subscribing
  afterwards revives every callback ever registered — each routing change would deliver
  one more copy of every event, duplicating recordings and issues. Rules are therefore
  built as data and installed with `setRequestRules`/`setWebSocketRules`, which leaves
  the subscriptions alone. Subscribe exactly once, when the proxy starts.
- **`request` and `response` events are not ordered.** When Mockttp answers a request
  itself — any `deny` rule — both events cross the protocol together and the response
  routinely arrives first. Pairing them by arrival order silently drops every
  locally-answered exchange, which is precisely the wall-hit traffic the issue engine
  exists to see. The two halves are joined by request id, whichever lands first.

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
   **`NODE_USE_ENV_PROXY=1` is required and easy to miss** — found in phase 0
   ([spikes/05-scrubber](../../spikes/05-scrubber/FINDINGS.md)): SDKs built on `fetch`
   (undici) ignore `http.Agent` entirely *and* ignore `HTTPS_PROXY` unless that variable is
   set. Octokit v22 configured with an explicit proxy agent went straight to the real
   GitHub API and came back with a genuine request id. Without this knob a large and
   growing class of modern SDKs escapes the front door in host mode while appearing
   correctly configured.
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
