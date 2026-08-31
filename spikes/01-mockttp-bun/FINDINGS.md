# Spike 01 — Mockttp on Bun

**Status:** Complete · **Date:** 2026-08-31 · Bun 1.4.0, Node 24.20.0, Mockttp 4.6.1

## The question

[02-architecture.md](../../docs/design/02-architecture.md) locked in "Bun + TypeScript,
single runtime" with Mockttp as the proxy engine, and flagged the risk itself:

> Must be validated against Bun's node-compat early (it uses Node http internals) — this
> is a phase-0 spike, with Node-as-sidecar the fallback if Bun compat fails.

## Verdict

**Bun compat fails for the front door. Run the front door as a Node sidecar.**

Mockttp under Bun needs two dependency patches just to complete a TLS handshake, and even
then loses **HTTP/2** and **WebSockets** to two Bun runtime defects that cannot be fixed
from userland. Under Node it passes everything, unpatched.

| Capability (`spike.ts`) | Node | Bun (patched) |
|---|:--:|:--:|
| HTTPS MITM, HTTP/1.1, real upstream | PASS | PASS |
| HTTP/2 client through the MITM | PASS | **FAIL** — silently downgraded to h1.1 |
| Mock served for a non-existent host (sealed mode) | PASS | PASS |
| Passthrough to a self-signed local upstream | PASS | PASS *(needs patch 2)* |
| WebSocket over TLS through the MITM | PASS | **FAIL** — throws, then hangs or segfaults |
| Plain HTTP proxying on the same port | PASS | PASS |
| | **6/6, unpatched** | **4/6, patched** |

Reproduce: `node spike.ts` · `SKIP=5 bun run spike.ts` (test 5 kills the Bun process, so it
must be run alone: `ONLY=5 bun run spike.ts`). Patches: `python3 apply-bun-patches.py`,
re-run after every `bun install`.

## The five defects, in the order they bite

Each has a standalone reproduction in `repros/` that runs under both runtimes and prints
PASS/FAIL, so none of this rests on reading Mockttp's source.

### 1. `net.Server`'s constructor listener is invisible to `emit('connection')` — **fixed in Bun 1.4.1**

`repros/01-net-server-emit-connection.ts`

Node registers the callback passed to `net.createServer(fn)` (or `super(fn)` in a subclass)
as a real `'connection'` event listener. Bun does not. Every MITM proxy re-injects the
tunnelled socket after CONNECT via `server.emit('connection', socket)` — under Bun that
silently does nothing, so the handshake never starts and the client hangs with **no error
on either side**. This is what `@httptoolkit/httpolyglot` (Mockttp's port multiplexer) does.

Fixed by patch 1: call `super()` then `this.on('connection', …)` explicitly. One line,
no behaviour change on Node.

**Fixed upstream in Bun 1.4.1** by [oven-sh/bun#40920](https://github.com/oven-sh/bun/pull/40920),
merged 2026-08-30 — ten days after the 1.4.0 we tested on, and one day before we filed
[#41060](https://github.com/oven-sh/bun/issues/41060), which was closed as a duplicate of
[#40917](https://github.com/oven-sh/bun/issues/40917). That PR gives the real mechanism,
which is sharper than what we inferred: the callback was stashed in the options bag and
each accept path called `prependOnceListener` immediately before its own emit, so it
existed as a listener only for the duration of that internal emit. Hence genuine inbound
connections worked while `listenerCount('connection')` read 0 and a manual emit reached
nobody.

Patch 1 stays for now, since we pin 1.4.0; drop it when we move to 1.4.1 and confirm
`repros/01` passes unpatched.

### 2. `@SECLEVEL=0` in a cipher string is rejected — *patchable*

`repros/02-seclevel-cipher.ts`

Mockttp appends OpenSSL's `@SECLEVEL=0` directive to its upstream cipher list whenever
certificate checks are relaxed (`passthrough-handling.js:137`) — i.e. exactly when
`ignoreHostHttpsErrors` is set, which is how you record against a staging host with a
self-signed cert. BoringSSL, which Bun uses, has no such directive and rejects the entire
cipher string: `SSL routines:OPENSSL_internal:INVALID_COMMAND`.

Fixed by patch 2: omit it under Bun. Costs only tolerance for legacy/weak upstream ciphers.

### 3. `SNICallback` silently disables ALPN — **not patchable**

`repros/03-alpn-dropped-by-snicallback.ts`, and a dependency-free five-case matrix in
[`upstream/bun-issue-alpn-repro.mjs`](upstream/bun-issue-alpn-repro.mjs)

A MITM proxy must choose its certificate per-connection, which means `SNICallback`. Under
Bun, *any* TLS server using `SNICallback` negotiates **no ALPN protocol at all**. The
defect is `SNICallback` specifically, not the ALPN APIs:

| configuration | Node 24.20.0 | Bun 1.4.0 |
|---|---|---|
| `ALPNProtocols` in server options | h2 | h2 |
| `ALPNProtocols` + `SNICallback` | h2 | **none** |
| `ALPNProtocols` only on the context returned by `SNICallback` | none | none |
| `ALPNCallback` | h2 | h2 |
| `ALPNCallback` + `SNICallback` | h2 | **none** |

`ALPNCallback` on its own works fine — it stops working only once `SNICallback` is also
set. Row 3 fails on both runtimes: ALPN isn't a per-context setting in Node either, so
that one is expected, not a Bun defect. There is no configuration that keeps both
per-host certificates and ALPN.

Consequence: h2 clients silently fall back to HTTP/1.1. That is quiet enough to be
dangerous — we would record h1.1 traffic for services that speak h2 in production, and
h2-only clients (gRPC, per [03-capture.md](../../docs/design/03-capture.md)) would break.

There *is* a shape that works — `repros/04-alpn-survives-static-cert.ts` shows a
per-hostname `tls.Server` with a **static** cert and static ALPN keeps h2, even across the
`emit('connection')` handoff. Mockttp already parses the inbound ClientHello, so it has the
SNI hostname in hand and could cache one TLS server per host instead of using `SNICallback`.
That is a fork of Mockttp's TLS layer, not a patch.

### 4. Bun's builtin `ws` shadows the npm package — **not patchable**

`repros/05-bun-builtin-ws-shadows-npm.cjs`

Bun ships `ws` as a builtin (it appears in Bun's own crash banner under `Builtins:`), and
`require("ws")` returns it **from every context** — including files inside a project where
the real package is installed. `require.resolve("ws")` returns the string `"ws"`, not a path.
A `Bun.plugin` `onResolve` preload does not override it.

The builtin lacks `PerMessageDeflate` and `extension`, and its constructor rejects
`new WebSocket(null, …)` — the socket-wrapping form Mockttp uses to proxy an
already-upgraded WebSocket. Result: `SyntaxError: Invalid url for WebSocket null` thrown
inside Mockttp, the client left hanging.

### 5. The WebSocket path can segfault the process — **not patchable**

Run in isolation, the WebSocket test throws (defect 4) and hangs. Run *after* the other
tests, Bun aborts with `panic(main thread): Segmentation fault`. A hard crash in the
component that owns every byte of a developer's traffic is disqualifying on its own.

Note the WebSocket test deliberately runs its client and upstream under Node
(`ws-client-check.mjs`) even when the proxy runs under Bun — otherwise defect 4 would break
the *client* and we would be measuring the wrong thing.

## Decision

**The front door runs on Node, as a sidecar process.** Everything else — daemon, API, CLI,
generated mocks — stays on Bun as designed.

Why a sidecar rather than moving the whole daemon to Node:

- The blockers are confined to the proxy. Nothing else in the stack touches `node:tls`
  internals, `SNICallback`, or `ws`.
- Bun's advantages (single-binary compile, startup time, SQLite, the generated-mock module
  format) all apply to the parts that keep them.
- The proxy is already a natural process boundary — it has a different lifecycle from the
  daemon and benefits from being restartable on its own.
- Mockttp ships an admin-server + client architecture designed for exactly this: the
  daemon drives a remote Mockttp instance over its own protocol, so "sidecar" is a
  supported configuration, not a hack we invent.

Cost: a bundled Node runtime in the distribution artifact, and a second runtime in the
sandbox image. This must be reflected in [10-security.md](../../docs/design/10-security.md)'s
distribution table.

## Revisit criteria

Return to single-runtime Bun when **all** of these hold, re-verified by re-running
`spike.ts`:

1. ~~`net.Server` constructor listeners respond to `emit('connection')` (defect 1).~~
   **Met** — fixed in Bun 1.4.1 by
   [oven-sh/bun#40920](https://github.com/oven-sh/bun/pull/40920).
2. `SNICallback` no longer suppresses ALPN (defect 3) — the h2 blocker, and the one that
   decides whether the sidecar is permanent. Filed as
   [oven-sh/bun#41061](https://github.com/oven-sh/bun/issues/41061).
3. Bun's builtin `ws` is overridable, or gains `PerMessageDeflate`/`extension` and the
   `new WebSocket(null, …)` constructor (defect 4).
4. No segfault under the full matrix (defect 5).

Criterion 2 is tracked by [#41061](https://github.com/oven-sh/bun/issues/41061) and is now
the only thing standing between us and an h2-capable front door on Bun, apart from
WebSockets. Defect 4 has been reported
since 2023 ([#2955](https://github.com/oven-sh/bun/issues/2955),
[#3613](https://github.com/oven-sh/bun/issues/3613),
[#4568](https://github.com/oven-sh/bun/issues/4568),
[#4529](https://github.com/oven-sh/bun/issues/4529)) and was not re-reported. Defect 5 is
not filed: all we have is "test 5 kills the process when run after tests 1–4", which is a
symptom, not a reproduction — it needs reducing first.

Defects 1 and 2 are also fixable from the library side, and both fixes are open as PRs —
[httpolyglot#4](https://github.com/httptoolkit/httpolyglot/pull/4) and
[mockttp#206](https://github.com/httptoolkit/mockttp/pull/206) — verified against fresh
clones before submission. If either lands, the corresponding half of
`apply-bun-patches.py` can be dropped once the release is out.

## Not tested here

- gRPC over the MITM (deferred to phase 4 by [03-capture.md](../../docs/design/03-capture.md);
  it rides on h2, so defect 3 would have blocked it anyway).
- HTTP/3 / QUIC — explicitly denied at the front door by design.
- Throughput and latency under load. The sidecar boundary adds an IPC hop for control, not
  for data, but this should be measured before phase 3's seal certification depends on it.
