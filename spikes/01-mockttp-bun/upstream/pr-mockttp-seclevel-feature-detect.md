**Target:** https://github.com/httptoolkit/mockttp — PR against `main` (`082461e`)
**Patch:** `pr-mockttp-seclevel-feature-detect.patch` (`git apply` at the repo root)

---

## Title

Only add `@SECLEVEL=0` where the TLS backend supports it

## Description

`getUpstreamTlsOptions` appends `@SECLEVEL=0` to the cipher string whenever
`strictHttpsChecks` is off:

```ts
...(!strictHttpsChecks ? ['@SECLEVEL=0'] : [])
```

`@SECLEVEL` is an OpenSSL extension to the cipher-string syntax. TLS backends that
present an OpenSSL-compatible API without implementing it — BoringSSL, which is what
Bun uses — don't ignore the unknown directive; they reject the **entire cipher string**:

```
error:0A0000B9:SSL routines:OPENSSL_internal:INVALID_COMMAND
```

So on such a runtime every passthrough request with relaxed certificate checking fails
at `tls.connect`, while strict requests are fine. That's an awkward failure mode,
because relaxed checking is exactly what you reach for when recording against staging
hosts with self-signed certificates.

This adds `isSecLevelSupported()` to `src/util/openssl-compat.ts` and gates the
directive on it. Where `@SECLEVEL=0` is supported the cipher string is byte-identical to
today's; where it isn't, it's dropped, costing only tolerance for legacy/weak upstream
ciphers — which is strictly better than the connection failing outright.

### Why feature detection rather than a version check

The obvious implementation is to read `process.versions.openssl`, matching the
`areFFDHECurvesSupported` helper next to it. That doesn't work here: **Bun reports
`process.versions.openssl === '1.1.0'`**, a real OpenSSL version that *does* support
`@SECLEVEL`. Any version-based check gets the wrong answer. So the helper does the one
thing that can't be spoofed — it builds a secure context with the directive once, and
caches whether that threw.

Worth flagging separately: the same reported-version problem means `NEW_CURVES_SUPPORTED`
is `false` under Bun for the wrong reason. It happens to be the right answer, so I've
left it alone rather than widening this PR, but it's the same trap.

## Tests

Extends `test/openssl-compat.spec.ts`. The assertion is that the helper agrees with what
`tls.createSecureContext` actually does on the host runtime, rather than a hardcoded
expectation — so it's meaningful on both an OpenSSL and a non-OpenSSL backend.

| | result |
|---|---|
| `tsc --noEmit` | clean |
| `test/openssl-compat.spec.ts`, Node 24.20.0 | 6 passing |
| `test/openssl-compat.spec.ts`, Bun 1.4.0 | 6 passing |

I ran the unit spec rather than `npm test`, which also builds and runs the browser and
performance suites; happy to run the full thing if you'd like it in the PR.

## Notes

For context on where this came from: I was evaluating whether mockttp could run under
Bun as the interception layer for a project of mine. It can't yet, but for a reason
that's Bun's to fix and not yours — setting `SNICallback` there suppresses ALPN
entirely, so an h2-capable proxy silently downgrades every client to HTTP/1.1. Filed at
[oven-sh/bun#41061](https://github.com/oven-sh/bun/issues/41061).

This change and the companion httpolyglot one are the two things that *are* fixable
from the library side, and both are no-ops on Node. No expectation that you support Bun
as a target — I'd understand if you'd rather not carry either.
