**Target:** https://github.com/oven-sh/bun/issues/new — Bug report
**Repro:** `bun-issue-alpn-repro.mjs` (no dependencies; embeds a throwaway self-signed cert)
**Related:** #17932 — same area, but that report says `SNICallback` is never invoked, which is no longer true in 1.4.0. Worth cross-linking rather than commenting there.

---

## Title

Setting `SNICallback` silently disables ALPN negotiation on a TLS server

## What version of Bun is running?

1.4.0+34cbb9a40

## What platform is your computer?

Darwin 25.6.0 arm64 (macOS 26.6.2)

## What steps can reproduce the bug?

Run the attached `bun-issue-alpn-repro.mjs` under both runtimes. It stands up five TLS
servers that differ only in how ALPN and SNI are configured, connects a client offering
`["h2", "http/1.1"]` to each, and prints the negotiated protocol.

```
  bun  1.4.0   client offers ALPN ["h2", "http/1.1"]

  ok    ALPN in server options                       alpnProtocol = "h2"
  FAIL  ALPN + SNICallback                           alpnProtocol = false
  FAIL  SNICallback, ALPN only on returned context   alpnProtocol = false
  ok    ALPNCallback                                 alpnProtocol = "h2"
  FAIL  ALPNCallback + SNICallback                   alpnProtocol = false
```

```
  node 24.20.0   client offers ALPN ["h2", "http/1.1"]

  ok    ALPN in server options                       alpnProtocol = "h2"
  ok    ALPN + SNICallback                           alpnProtocol = "h2"
  FAIL  SNICallback, ALPN only on returned context   alpnProtocol = false
  ok    ALPNCallback                                 alpnProtocol = "h2"
  ok    ALPNCallback + SNICallback                   alpnProtocol = "h2"
```

The minimal difference is one option:

```js
// negotiates h2 on both runtimes
tls.createServer({ cert, key, ALPNProtocols: ["h2", "http/1.1"] });

// negotiates h2 on Node; no ALPN at all on Bun
tls.createServer({ cert, key, ALPNProtocols: ["h2", "http/1.1"], SNICallback: (_s, cb) => cb(null, ctx) });
```

Note that row 3 ("ALPN only on returned context") fails on **both** runtimes — that's
expected Node behaviour, since ALPN isn't a per-context setting, and I'm not reporting
it. The Bun-specific defect is rows 2 and 5: merely *setting* `SNICallback` suppresses
ALPN that is configured by a mechanism which demonstrably works without it.

## How often does this reproduce? Is there a required condition?

Every time. The only condition is the presence of `SNICallback`. It doesn't matter what
the callback does — the one here ignores the servername and returns a single static
context, and the certificate it returns is used correctly, so the callback itself is
working. Note that `ALPNCallback` on its own works fine (row 4); it only stops working
once `SNICallback` is also set (row 5).

## What is the expected behavior?

`SNICallback` selects the certificate; it should have no bearing on protocol
negotiation. `ALPNProtocols` in the server options — and `ALPNCallback` — should be
honoured whether or not `SNICallback` is set, as on Node.

## What do you see instead?

`socket.alpnProtocol` is `false` on both ends: the server never sends an ALPN
extension. No error is raised.

## Additional information

**The impact is a silent downgrade rather than a failure**, which is what makes this
worth reporting separately. HTTP/2 clients don't error — they fall back to HTTP/1.1 and
keep working, so a passing test suite looks identical either way. You only notice if
you specifically assert on the negotiated protocol.

Every TLS server that picks certificates per-hostname needs `SNICallback`: MITM proxies,
local HTTPS dev servers with wildcard subdomains, reverse proxies with per-tenant certs.
On Bun, all of them lose HTTP/2 without any indication.

There's no userland workaround that I could find — the repro's five rows are the options
I'm aware of. This is currently the reason
[mockttp](https://github.com/httptoolkit/mockttp) can't run under Bun as an HTTP/2-capable
proxy: it uses `SNICallback` to mint a certificate per intercepted host, and it needs to
offer `h2` to the client.

#17932 covers the same two callbacks and is still open, but reports that neither is ever
invoked. That's no longer accurate on 1.4.0 — both fire, and `ALPNCallback` alone
behaves correctly — so this seems worth tracking as a separate, narrower bug rather than
a comment there.
