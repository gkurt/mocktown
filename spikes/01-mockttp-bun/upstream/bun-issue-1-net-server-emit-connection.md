**Target:** https://github.com/oven-sh/bun/issues/new — Bug report
**Repro:** `bun-issue-net-server-repro.mjs` (no dependencies)

---

## Title

`net.Server`'s constructor callback is not a `'connection'` listener, so `server.emit('connection', socket)` never reaches it

## What version of Bun is running?

1.4.0+34cbb9a40

## What platform is your computer?

Darwin 25.6.0 arm64 (macOS 26.6.2)

## What steps can reproduce the bug?

Save and run this under both runtimes — no dependencies:

```js
import net from "node:net";

const server = net.createServer(() => console.log("callback fired"));
console.log("listeners:", server.listeners("connection").length);
server.emit("connection", {});
```

```
node:  listeners: 1    callback fired
bun:   listeners: 0
```

In Node, the callback passed to `net.createServer(fn)` (or to `super(fn)` in a
`net.Server` subclass) is registered as an ordinary `'connection'` listener, so
re-emitting the event dispatches to it. In Bun it appears to be held internally: it
still fires for genuine inbound connections, but it is invisible to
`EventEmitter` and is never invoked by `emit('connection', …)`.

The attached `bun-issue-net-server-repro.mjs` separates those two paths:

```
  bun  1.4.0
  net.createServer(fn).listeners('connection').length  = 0
  subclass super(fn)   .listeners('connection').length  = 0

  genuine inbound connection reached the callback : true
  re-emitted socket reached the callback         : false
```

```
  node 24.20.0
  net.createServer(fn).listeners('connection').length  = 1
  subclass super(fn)   .listeners('connection').length  = 1

  genuine inbound connection reached the callback : true
  re-emitted socket reached the callback         : true
```

## How often does this reproduce? Is there a required condition?

Every time. It does not depend on whether the server is listening, nor on the type of
the emitted argument (a real `net.Socket` behaves the same as a plain object).

## What is the expected behavior?

The constructor callback should be registered as a real `'connection'` listener, as
[Node does](https://github.com/nodejs/node/blob/main/lib/net.js) — `listeners('connection')`
should report it, and `emit('connection', socket)` should invoke it.

## What do you see instead?

`listeners('connection')` is empty and re-emitted sockets are silently dropped. Nothing
throws and no error is emitted anywhere — the socket is simply never read, so the peer
waits until it times out.

## Additional information

**Why this matters beyond the event-emitter semantics:** re-emitting a socket onto a
server is the standard way an HTTP proxy handles `CONNECT`. The proxy accepts the
tunnelled socket itself, then pushes it back through its own port multiplexer to be
re-sniffed (TLS? HTTP/1? HTTP/2?) and routed. `server.emit('connection', socket)` is
how essentially every Node MITM proxy does this.

Under Bun that call becomes a no-op, so the tunnelled connection hangs with no error on
either side. I hit this in [mockttp](https://github.com/httptoolkit/mockttp) via
[@httptoolkit/httpolyglot](https://github.com/httptoolkit/httpolyglot), whose `Server`
extends `net.Server` and passes its listener to `super()`; every HTTPS request through
the proxy hung at the TLS handshake. It took a long time to find precisely because the
failure is silent — there is no error to search for.

The one-line workaround in userland is to use the explicit form, which works correctly
on both runtimes:

```js
// instead of: super((socket) => this.connectionListener(socket));
super();
this.on("connection", (socket) => this.connectionListener(socket));
```

I've sent that upstream as a portability fix, but libraries can't generally be expected
to know to avoid the documented constructor form.

Possibly related, though neither is this: #19790 (same class of gap for
`http.Server`'s `'connect'`), #31795 (Bun's *client* not emitting CONNECT).
