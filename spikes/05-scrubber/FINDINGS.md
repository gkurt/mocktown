# Spike 05 — the scrubber, over a real recorded corpus

**Status:** Complete · **Date:** 2026-08-31 · Bun 1.4.0, Mockttp 4.6.1, emulate 0.10.0

## The question

[11-roadmap.md](../../docs/design/11-roadmap.md): *"Scrubber prototype over real recorded
traffic."* The requirements are enumerated in
[10-security.md](../../docs/design/10-security.md) — scrub before disk, structured
placeholders consistent within a session, re-injection on replay, configurable rules, and
a `scrub audit` re-scan.

## The corpus is real traffic, not fixtures

`capture.mjs` runs the actual architecture: real vendor SDKs (Stripe 19, Octokit 22) speak
TLS to real hostnames (`api.stripe.com`, `api.github.com`, `accounts.google.com`); the
Mockttp front door MITMs and forwards to emulate. Nine exchanges, containing:

- `Authorization: Bearer sk_test_…` and `Authorization: token ghp_…`, `X-Api-Key`, `Cookie`
- a `Set-Cookie` with real attributes
- an OAuth `client_secret` in a JSON body and the `access_token` that came back
- a **genuine signed JWT** from a Google OIDC token exchange
- form-encoded and JSON bodies with resource ids the mocks need to keep
- one request shaped like a signup, carrying a password, a card number and an SSN
- a deliberate decoy: a product named *"Token Ring Adapter"*, to catch a field-name rule
  that matches `token` too eagerly

## Verdict

**14/14.** The design's scrubbing requirements are all implementable and all verified
against that corpus.

| | |
|---|:--:|
| No known secret survives scrubbing | PASS |
| Server-issued tokens (minted at capture time) redacted too | PASS |
| Same secret → same placeholder within a session | PASS |
| Distinct secret kinds are distinguishable | PASS |
| JSON bodies remain valid JSON | PASS |
| Non-secret data survives intact (decoy, emails, resource ids) | PASS |
| Auth scheme kept, credential replaced | PASS |
| Cookie names and attributes kept, values redacted | PASS |
| Replay re-injects well-formed fakes | PASS |
| Audit finds no residue in a correctly scrubbed corpus | PASS |
| Entropy backstop covers a removed vendor rule | PASS |
| Audit reports what a stripped rule set leaves behind | PASS |
| Entropy backstop has no false positives | PASS |
| Summary records kinds and counts, never values | PASS |

Reproduce: `node capture.mjs && bun run spike.ts`.

## What the spike changed about the design

### 1. Shape must beat location when labelling a secret

The first implementation redacted by *location* first: an `Authorization` header became
`{{secret:auth-header#1}}` whatever it contained. That passes a leak test and is still
wrong. The label is the part a generated mock reasons about — "this endpoint required a
Stripe secret key" is actionable, "this endpoint required an auth header" is not — and
`reinject()` cannot produce a correctly-shaped fake for a kind as vague as `auth-header`.
Two tests caught it: placeholders never carried `stripe-secret-key`, and replay emitted
`mocktown-credential-1` where a `sk_test_…`-shaped string belonged.

**Rule: classify by shape, fall back to location.** A Stripe key in an Authorization header
is `stripe-secret-key`; an unrecognisable credential in the same header is `auth-header`.
After the fix the corpus yields `stripe-secret-key`, `github-token`, `jwt`, `ssn`,
`card-number`, `cookie`, `password`, `secret` and `token` as distinct kinds — each with a
`fake()` that reproduces its shape.

### 2. The two passes overlap by three layers, and that is measurable

10-security.md asks for both named-field redaction and shape/entropy detection. It turns
out the GitHub PAT in this corpus is covered **three times over**: its own vendor pattern,
the `authorization` header rule, and the entropy backstop. Removing any one — or any two —
still leaves it redacted; only stripping all three lets it through.

That is worth stating as a property rather than leaving it as luck: **no single rule
deletion should be able to leak a credential.** It is directly testable, and tests 11 and
12 test it — one shows a removed vendor rule is covered, the other shows the audit reports
the leak once nothing covers it. A future rule refactor that quietly collapses these layers
would fail test 11 rather than passing silently.

### 3. Shannon entropy alone misses hex secrets

A 48-character hex session id measures **3.59 bits/character** — below any threshold loose
enough to exclude an ISO timestamp (3.49). Tuning the single threshold cannot separate
them.

The fix is a character-class rule alongside the entropy one: **a token of ≥32 characters
that is pure hex is a digest, a session id or a key — never business data**, whatever its
Shannon value. With that, the backstop fires on the hex session id and the long API key,
and stays silent on `cus_MR7dlLEfqZuUiAwY`, `application/x-www-form-urlencoded`,
`2026-08-31T14:22:19.284Z` and hyphenated identifiers.

The backstop is deliberately conservative in every other respect (minimum length, no
whitespace, mixed character classes, an allowlist for `word-word-word` shapes) because a
false positive silently corrupts the corpus that mocks are generated from — a failure that
shows up much later, as a mock that doesn't match reality.

### 4. Luhn, not length, decides what is a card number

The card-number pattern (13–19 digits) also matches timestamps, amounts in minor units and
numeric ids. Requiring a Luhn check before redacting keeps `amount=4200` and
`created=1788188185` intact while still catching real PANs.

### 5. Structure-preserving redaction is what keeps the corpus useful

Bodies are parsed and rewritten in place, not regex-replaced: JSON stays JSON (10/10 bodies
re-parse), form encoding stays form encoding, cookie names and attributes (`Path`,
`HttpOnly`, `SameSite`) survive while values are replaced, and auth schemes (`Bearer`,
`token`) survive while credentials are replaced. Without this,
[03-capture.md](../../docs/design/03-capture.md)'s promise that the corpus is "immediately
agent-legible" would not survive the scrubber.

## Two findings about capture, not scrubbing

Both surfaced while building the corpus, and both matter to
[03-capture.md](../../docs/design/03-capture.md)'s launch wrapper:

### Mockttp rules stop matching unless `.always()` is set

The first capture recorded one Stripe call correctly and then sent everything else to the
**real** `api.stripe.com` — the forwarding rules had been consumed. A recorder that forgets
`.always()` silently starts leaking traffic to production after the first request per rule,
which is the worst possible failure mode for this product. Two mitigations, both cheap:
set `.always()` on every rule, and make the fallthrough rule **deny and log** rather than
pass through, so an escape is loud instead of silent. The capture harness does both.

### SDKs built on `fetch`/undici ignore `http.Agent` entirely

Octokit v22 uses `fetch`, so `new Octokit({ request: { agent } })` is silently ignored —
its traffic went straight to the real GitHub API and returned a genuine `401` with a real
GitHub request id. The fix is environmental, and it is exactly
[03-capture.md](../../docs/design/03-capture.md)'s rung 1: `HTTPS_PROXY` plus
**`NODE_USE_ENV_PROXY=1`**, which is what makes Node's global `fetch` honour proxy
environment variables.

That last variable is not in the doc's list of knobs, and without it a large and growing
class of modern SDKs escapes the front door in host mode while appearing to be configured
correctly. It belongs in the launch wrapper alongside `NODE_EXTRA_CA_CERTS`.

### The wrapper's env vars also work when the recorded app runs on Bun

Checked 2026-09-01, because `mocktown record -- <cmd>` cannot assume the child is Node —
plenty of target apps run on Bun. Measured at a local proxy that counts absolute-URI
requests and CONNECTs separately, so a transparent tunnel can't be mistaken for a direct
hit:

| | Node 24.20.0 | Bun 1.4.0 |
|---|---|---|
| `HTTP_PROXY` alone → `fetch` | ignored | **proxied** |
| `HTTP_PROXY` alone → `node:http` | ignored | ignored |
| `+ NODE_USE_ENV_PROXY=1` → both | proxied | proxied |
| `NO_PROXY` honoured | yes | yes |
| `NODE_EXTRA_CA_CERTS` honoured | yes | yes |

Three things follow. **The wrapper needs no per-runtime branch** — the same
`NODE_EXTRA_CA_CERTS` + `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1` set captures both runtimes
for both `fetch` and `node:http`. **Bun proxies `fetch` even without the opt-in**, so a
developer with `HTTPS_PROXY` already exported for unrelated reasons will silently route a
Bun app's fetch traffic somewhere we don't control; the wrapper should set the variables
explicitly rather than inheriting them, and warn if it is overriding a pre-existing value.
**The two runtimes proxy plain HTTP differently** — Node's undici opens a CONNECT tunnel
even for `http://`, Bun sends an absolute-URI request — so the front door has to accept
both forms for the same URL. httpolyglot handles both, but a `seal verify` test should
cover the pair rather than assuming one.

## Not covered here

- **Streaming and binary bodies.** Everything here is text. Large bodies become
  content-addressed blobs per 03-capture.md; scrubbing those is the same code but needs a
  chunk-boundary story (a secret split across two chunks would evade a pattern).
- **Emails and names are not redacted.** 10-security.md's deny list names passwords,
  tokens, secrets, cards and SSNs; emails are load-bearing for mock fidelity (they are the
  identity most APIs key on). Worth an explicit decision and a project-level rule for teams
  that need it, rather than leaving it implicit.
- **Placeholder collisions across sessions.** Placeholders are session-scoped by design;
  what happens when two sessions' corpora are merged for generation is undefined.
- **Performance.** Two passes over every body, with a regex set per rule. Fine at this
  scale; unmeasured at recording-session scale.
