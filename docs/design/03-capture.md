# 03 — Traffic Capture & the Front Door

**Status:** Implemented — phase 1, launched browser in phase 3, WebSocket capture *and*
mocking in phase 4; gRPC records but cannot be served, and OS-level capture remains
deferred

All traffic — recording real APIs and serving mocked ones — flows through one proxy,
the **front door**. Its behavior per service is a mode, not a separate binary:

| Mode | Behavior |
|---|---|
| `record` | Forward to the real upstream, persist the scrubbed exchange |
| `mock` | Route to the service's provider (emulator or generated mock) |
| `passthrough` | Forward without recording (explicitly allowlisted hosts only) |
| `deny` | Refuse + file an issue (default for unknown hosts in sealed mode) |

**A discovered `record` pin is not a decision.** The recorder registers every host it
observes with `provider: record`, so every service learned during a recording run arrives
in serve mode still pinned to "forward to the real upstream" — which is exactly the silent
escape the fallthrough rule below exists to prevent, except reached through a *known* host
rather than an unknown one. In serve mode a running provider therefore outranks a pin
nobody wrote to `mocktown.json`, and a discovered pin with no provider up is denied under
seal rather than allowed out. A pin that *is* committed to the file is a decision and
stands — but `serve start` names every host still reaching a real upstream in its warnings,
so the escape is never the quiet option.

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
   **`NO_PROXY` is computed, not fixed.** Proxy clients match it by domain suffix, so a
   blanket `localhost` entry silently takes every `*.localhost` name with it and a
   `.localhost` upstream records nothing while looking perfectly wired up. There is no
   syntax that avoids this: a leading dot means the same thing, and port-scoped entries are
   not portable — undici and urllib honour `localhost:3000`, curl ignores the port and
   proxies the host anyway. So `planNoProxy` derives the list from what the project
   declared:
   - `127.0.0.1` and `::1` are unconditional. Loopback literals can never shadow a service,
     because a recorded service is always a hostname.
   - The bare `localhost` entry is dropped as soon as a registered service sits under that
     suffix. A `.localhost` upstream the app is meant to record outranks a convenience that
     only matters for hosts the project can name itself.
   - `noProxy` in `mocktown.json` is where the app names its own local services. Every entry
     is a hole: a host listed there can never be recorded.
   Dropping the blanket entry has a cost, so it is stated rather than assumed harmless.
   `record start` and `serve start` warn that a service reached as `localhost:<port>` by
   name now enters the front door, and a collision that cannot be resolved — under portless
   the TLD *must* bypass, which makes a `.localhost` upstream unrecordable in that mode — is
   reported by name instead of hidden. The front door recognises the other side of the trade:
   a denied request for a loopback name is filed as the app's own service, with `noProxy` as
   the fix, not as an undeclared third-party dependency.
2. **Launched browser** — for web-app client traffic: `mocktown browser launch` starts a
   Chromium-family browser on a fresh profile with `--proxy-server` set. *Trust is
   narrower than "in that profile"* (phase 3): the CA is passed as an
   `--ignore-certificate-errors-spki-list` entry, which names one public key and applies
   only to this launch. Chrome accepts a certificate whose chain contains a listed key and
   nothing else, so a stray HTTPS error in that window is still an error and **no trust is
   written to disk**. *Rejected:* editing the profile's NSS database — more
   platform-specific code, and it leaves trust behind after the window closes.
   **`--debug-port` publishes a CDP endpoint** so a driver (Playwright, Puppeteer) can
   attach to that window instead of launching an unrecorded one of its own; `0` asks Chrome
   for an ephemeral port and the resolved `webSocketDebuggerUrl` comes back on the
   procedure. It is **opt-in, because the endpoint is a capability** — anything that reaches
   it drives the browser, reads the profile's cookies and navigates it anywhere with no
   further authentication, and Chrome's only defence is that it binds to loopback. The port
   is read from the profile's `DevToolsActivePort` file rather than by polling
   `/json/version`: that is the only way to learn an ephemeral port, and the file is the
   readiness signal as well as the answer. It is deleted before launch, because a stale file
   from the last window answers the wrong port with total confidence.
   *Rejected:* **CDP as the capture mechanism** (the `Fetch`/`Network` domains in place of
   the proxy). It would be a second capture implementation feeding a second path into the
   corpus, and an interception that fails open is a silent escape with no deny wall behind
   it — the failure this product exists to prevent ([02-architecture.md](02-architecture.md)).
   `Network.getResponseBody` is also not reliably available for every response, and it sees
   only the one browser where the proxy covers browser, SDK and sandbox uniformly.
   **What this rung does not capture**, since "cooperative and best-effort" is meant
   literally — it is a flag on a process we asked nicely, not a boundary: loopback (bypassed
   by design, so a `.localhost` third party records nothing); responses served from the HTTP
   cache or a service worker, which never touch the network at all — and the profile dir
   persists across launches, so a second launch records less than the first; non-HTTP
   protocols, WebRTC's UDP ICE/STUN/TURN above all; managed-Chrome proxy *policy*, which
   takes precedence over command-line switches; pinned and HSTS-preloaded endpoints, which
   refuse the MITM cert and are filed as `pinned-client`; and the human, who can install an
   extension into that persistent profile or edit its proxy settings. Rung 3 is the answer
   to all of them, because inside the sandbox there is no route out to close.
   **What the corpus refuses to hold.** A browser's own traffic is not evidence about a
   dependency, and it dominates: measured on one attended session against a staging app, 17
   of the 22 discovered services were Chrome's and 5 were the app's — and every one of the 17
   also became a service row, an issue and a line in the feed. Two mechanisms, in this order.
   **First, do not make the request:** `browserArgs` passes the switches that disable
   component updates, Safe Browsing, sync, domain reliability, metrics and the per-page-load
   phone-homes, and starts on `about:blank` because the new tab page fetches promos, doodles
   and omnibox suggestions of its own. Measured on Chrome 152 headless through a logging
   proxy: attempted hosts 7 -> 5, attempts 23 -> 11 with the blank start page.
   **Second, `capture/noise.ts`,** for the rest — the flags do not cover everything, they are
   Chrome's alone, and rungs 1, 3 and 4 never see them. A match is dropped from the corpus,
   from service discovery and from the issue queue.
   *An ignore is not a passthrough.* It decides what is written down, never what is allowed
   out: an ignored request in serve mode still hits the deny wall, it just does not file an
   issue for a browser update.
   **A host is ignored wholesale only when it serves nothing else.** Otherwise the pattern is
   path-scoped, because the same session carried `fonts.googleapis.com/css2` (the app's web
   font) and `accounts.google.com` is where a real OAuth flow lives. A blanket
   `*.googleapis.com` would have silently eaten both — a worse failure than the noise it
   cleaned up, and the reason `accounts.google.com/ListAccounts` is a pattern and
   `accounts.google.com` is not.
   **Nothing is dropped silently.** `record stop` reports the count and the reason per
   pattern, and a session that dropped more than it kept raises it as a warning. `capture` in
   `mocktown.json` is where a project adds patterns (`ignore`), takes a default back
   (`keep`, per host or per path) or turns the built-in list off (`ignoreNoise`).
   *Deferred:* pruning noise a previous run already recorded. There is no delete path in the
   corpus at all today, so this changes what is captured next, not what is captured already.
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
  Solved by construction — with one thing that is easy to miss: **Chromium reads its own
  NSS database, not the system store**, so an in-sandbox browser needs a `certutil` entry
  as well or every mocked page is a full-screen certificate warning
  ([04-sandbox.md](04-sandbox.md)).
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

## WebSockets

*Added 2026-09-01 by the phase-4 implementation.* A socket is one corpus row plus its frames
in order, and a generated mock declares channels in a `sockets` array next to its `routes`.
Four decisions came out of building it:

- **Direction is written from the client's point of view.** Mockttp reports it from the
  proxy's, so a `websocket-message-received` event becomes a `sent` frame in the corpus.
  Getting this backwards would produce mocks that reply where the upstream replied and stay
  silent where the client spoke — a bug that only shows up as a hang.
- **A row lands at close, not at upgrade**, because the transcript is the artifact. The live
  feed gets `open`/`close` lifecycle events so a long-lived socket is still visible while it
  is running.
- **Frames are capped at 500 per socket** and the corpus marks a capped transcript. An
  agent building a mock from a truncated conversation must know the conversation went on
  rather than assume it ended there.
- **An undeclared channel is refused at the handshake** with a 501 and a filed issue naming
  the channels the mock does declare. A socket that connects and then says nothing is the
  hardest kind of mock bug to diagnose, so the failure is made loud where it is cheap.

Bodies that are not valid UTF-8 — binary frames, and binary HTTP bodies — are stored base64
and the row is marked `unscrubbable-binary`. That is an honest hole in
[10-security.md](10-security.md)'s promise, not a silent one: pattern rules cannot see inside
protobuf, so the corpus says so instead of implying the body was checked. Text-vs-binary is
decided by a UTF-8 round trip, never by `content-type` — a body labelled
`application/json` that is really gzip is exactly the case a header check gets wrong.

## gRPC: recorded, and not servable

*Added 2026-09-01 by the phase-4 implementation.* gRPC needs HTTP/2 with trailers, and
`Bun.serve` answers a prior-knowledge h2 connection with a protocol error — verified
directly against a `node:http2` client, not inferred. The generated-mock host therefore
cannot serve gRPC at all, and pretending otherwise would send agents to edit a mock that
can never work.

So gRPC calls are recorded opaquely (`kind: 'grpc'`, bodies base64) and **denied at the mock
boundary with the reason in the response body and in the filed issue**, along with the two
things that do work: point the service at `record` so its calls reach the real service and
land in the corpus, or run a real gRPC test double and register that host as `passthrough`.
The corpus export lists the gRPC methods it has seen under their own heading, and the
generation skill's house rules tell agents not to write routes for them.

**Revisit when** either the mock host stops being a `Bun.serve` — a Node sidecar already
exists for the front door, and a second one for gRPC is the obvious path — or Bun ships h2
server support. The blocker is the runtime, not the design.

## Explicitly deferred

- HTTP/3 / QUIC (deny at the front door so clients fall back to h2)
- Typed gRPC support: reflection or a `.proto`, message decoding, and mockable service
  methods. Blocked on the runtime above; opaque recording ships in the meantime.
