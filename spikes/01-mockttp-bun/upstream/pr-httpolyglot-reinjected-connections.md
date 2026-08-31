**Target:** https://github.com/httptoolkit/httpolyglot — PR against `main` (`89064d5`, v3.1.0)
**Patch:** `pr-httpolyglot-reinjected-connections.patch` (`git apply` at the repo root)

---

## Title

Register the connection listener explicitly, so re-emitted sockets are handled

## Description

`Server` currently passes its connection handler to `net.Server`'s constructor:

```ts
super((socket) => this.connectionListener(socket));
```

In Node this is exactly equivalent to registering a `'connection'` listener — the
constructor argument *is* added with `this.on('connection', …)` — so re-emitting a
socket onto the server dispatches to it. That behaviour is load-bearing for
httpolyglot's main consumer: mockttp re-injects the tunnelled socket after `CONNECT`
with `server.emit('connection', socket)`, so that a tunnelled connection gets sniffed
and routed exactly like a direct one.

The equivalence doesn't hold on every runtime. Bun handles the constructor callback
internally rather than registering it as a listener: `listeners('connection')` is empty,
and `emit('connection', socket)` never reaches `connectionListener`. Genuine inbound
connections still work, so a polyglot server looks healthy right up until something
re-injects a socket — at which point the socket is silently never read and the peer
hangs with no error on either side. (Filed upstream at oven-sh/bun#TODO.)

This switches to the explicit form:

```ts
super();
this.on('connection', (socket) => this.connectionListener(socket));
```

which is a no-op on Node — same registration, same ordering, nothing can attach a
listener between `super()` and the `.on()` call — and makes the re-injection contract
hold on runtimes that treat the constructor argument specially.

## Tests

Adds `test/reinjected-connection.spec.ts`, which stands up a plain `net.Server` in the
role of a proxy's `CONNECT` handler, hands the accepted socket back to the polyglot
server via `emit('connection', …)`, and asserts the request is routed to the HTTP
listener.

| | before | after |
|---|---|---|
| full suite, Node 24.20.0 | 19 passing | **20 passing** |
| new test, Node 24.20.0 | passes | passes |
| new test, Bun 1.4.0 | **fails** (2s timeout) | **passes** |

The new test passes on Node either way — it can't fail there, since the two forms are
equivalent. Its value is that it pins a contract that mockttp depends on and that is
currently only implicit.

One note if you reproduce the Bun column: `bun x mocha` runs mocha under **Node** (the
binary's shebang wins), so the test appears to pass unpatched. `bun --bun x mocha` is
what actually runs it under Bun.

## Notes

I'm not asking you to support Bun — the ALPN gap below means httpolyglot's TLS path
can't fully work there yet regardless. This is narrower than that: the constructor
form's equivalence to `.on('connection')` is a Node implementation detail, and the
explicit form costs nothing to prefer.
