# 05 — Endpoint Redirection & the Seal

**Status:** Implemented — `mocktown env` + EKB in phase 2, seal certification in phase 3

Env-var / SDK-endpoint redirection is a **first-class mode**, not a fallback. It is
how humans do everyday local dev and how most server-side SDKs are pointed at mocks.
Its relationship to the sandbox ([04-sandbox.md](04-sandbox.md)) is:

> **The sandbox is the instrument that certifies the env-var setup; the env-var setup
> is the everyday artifact developers and agents actually use.**

Cooperative config can't be guaranteed by construction — but it can be **certified by
measurement**. That certification is the *seal*.

## Endpoint knowledge base (EKB)

Per service, the redirect recipe in order of preference:

1. **Standard env var** — `AWS_ENDPOINT_URL`, `OPENAI_BASE_URL`, `GITHUB_API_URL`,
   `FIRESTORE_EMULATOR_HOST`-style, etc.
2. **SDK constructor option** — Stripe's `host/port/protocol`, Octokit's `baseUrl` —
   with a per-language snippet.
3. **Code-patch recipe** — for SDKs with no knob: a description an agent can apply
   ("read `X_ENDPOINT` env var, default to production URL").

Sources: seeded from emulate's per-service SKILL.md files for famous services;
**every long-tail mock the generator produces must add its own EKB entry**
([06-emulation.md](06-emulation.md)). The EKB lives in the project DB and is an
accreting asset — treat contributions to it as first-class work.

## The generator: `mocktown env`

Emits three artifacts:

1. `.env.mocktown` — every variable settable mechanically, pointing at the front
   door / provider ports. **Convention: presence = emulated.** One variable per
   service, no global mode flag, so real and mocked dependencies can mix per-service
   (the Firebase emulator pattern).
2. A human-readable report of coverage.
3. An **agent task list** for the remainder — services needing constructor options or
   code patches, with exact file/recipe references. Also exposed via MCP and written
   into the project's `AGENTS.md` section so coding agents self-configure.

## Seal certification

```
run app flows inside the sandbox with deny-on-unknown
   → zero wall-hits and zero uncovered dependencies?
        ──yes──▶ SEALED (stamped for this commit + config hash)
        └─no─▶ each failure becomes a typed issue:
               unknown host at the wall  → unknown-service: record it / generate a mock
               exercised but unredirected → redirect-gap: env var, SDK option, or patch
               then re-run
```

**Decision (phase 3): a seal run happens inside the sandbox, or it does not happen.**
`mocktown seal verify` reports three outcomes — `sealed`, not sealed, and
**`unverifiable`** — and a run with no container engine is always the third. The reason is
the asymmetry the whole design turns on: outside the boundary, an SDK that ignores proxy
variables reaches the real API *without ever touching the front door*, so the run records
zero wall-hits and the seal comes back green while the app talks to production. Inside the
boundary there is no "direct". A command that could return a false SEALED would be worse
than no command at all. *Rejected:* a host-mode seal run behind a warning — the warning is
not what gets read six months later; the stamp is.

Two further consequences, both deliberate:

- **The flows run unmodified, with no Mocktown environment applied.** Inside the sandbox
  every hostname resolves to the front door anyway, so applying `.env.mocktown` would test
  our own environment setup rather than the app. It also means the flow list is ordinary
  project commands, not something Mocktown-flavoured.
- **Redirection coverage is judged separately, from the EKB.** A wall hit cannot detect a
  missing env var for a *registered* service, because inside the sandbox that service is
  served either way. So every service the flows actually exercised that `mocktown env`
  reports as not mechanically covered becomes a `redirect-gap` issue — that is precisely
  the dependency that would reach production the moment the app ran outside the sandbox.
  Un-exercised services are not judged; a seal should not fail over a dependency the flows
  never touch.

- Seal status = `{ commit, config hash, timestamp, flows exercised, wall hits }`, stored
  in the DB and surfaced by CLI/GUI. A seal is only as good as the flows that were
  exercised; the stamp records which ones, and a run with an empty flow list is refused
  rather than passed.
- **A stale stamp is not a pass.** `mocktown seal` compares the stamp's commit and config
  hash — the service registry, the generated variable names and the flow list — against
  the working tree, and reports why it no longer applies. Treating "sealed once, against a
  different configuration" as sealed is how a new dependency reaches production behind a
  green check.
- **CI re-certification:** a new dependency or SDK bump that adds an unconfigured call
  must break the seal loudly. `mocktown seal verify` is designed to run as a CI step, and
  exits non-zero when the verdict is anything but sealed:

  ```yaml
  - run: mocktown serve start --sealed
  - run: mocktown seal verify --json
  ```

- A sealed env-var setup is trustworthy *empirically*, never presented as equivalent
  to the sandbox guarantee.

## Footnotes

- Browser/client-side code does not read env vars; frontend redirection is build-time
  config and leaks third-party scripts — for client traffic see the launched-browser
  and in-sandbox-browser paths ([03-capture.md](03-capture.md),
  [04-sandbox.md](04-sandbox.md)).
- [portless](https://github.com/vercel-labs/portless) integration: stable
  `<service>.localhost` names + trusted local certs for the host/dev mode. Optional
  dependency, same treatment as emulate (wrapped, not load-bearing).

  *Implemented 2026-09-01 in phase 4.* What it is for: a provider listener gets whatever port
  was free, so `.env.mocktown` changes on every daemon restart, and anything that remembers
  a URL — an OAuth redirect URI, a committed fixture, a teammate's shell history — is wrong
  by the next morning. With portless a service is always
  `https://<service>.<project>.<tld>`. Six decisions:

  - **`portless alias` is the only verb used.** Our listeners already exist and are ours to
    supervise, which is the case portless documents as "a static route (e.g. for Docker)".
    Mocktown never hands portless a child process to run — that is the app's business.
  - **Availability is proven, not parsed.** No `portless list` scraping and no version
    sniffing: a throwaway alias is pointed at a nonce server of ours and fetched back through
    the proxy. That one request proves the proxy is up, the alias mechanism works, the name
    resolves and the CA bundle we assembled validates the certificate the proxy serves. A
    green report means an app will work; a red one carries the reason and the fix
    (`portless proxy start`, `portless trust`, `portless hosts sync`).
  - **The probe never points at a provider.** Aiming the verification request at a mock host
    would file an `unmatched-request` issue, so checking the plumbing would pollute the queue
    it exists to keep honest.
  - **`NODE_EXTRA_CA_CERTS` takes one file, and an app behind stable names has to trust two
    issuers** — the project CA for the front door and portless's for the names. So a combined
    bundle is written per project and every CA variable points at it. A browser reads none of
    those variables, so the same bundle is also emitted as a list of SPKI fingerprints
    (`MOCKTOWN_CA_SPKI`) — every certificate in it, because a list naming one issuer leaves
    the other throwing certificate errors in a window that looks correctly configured.
  - **`portless.tlds` is a list, not a name.** The default is
    `["mocktown", "mocktown.localhost"]`. `.mocktown` is the one worth typing, and it only
    resolves because portless writes `/etc/hosts` — which is exactly the step that fails on a
    locked-down machine, in a devcontainer, or when someone declines the prompt. `.localhost`
    resolves to loopback with no hosts entry at all (RFC 6761), so the second spelling is the
    same proxy reachable when the first cannot be arranged. portless takes a repeated `--tld`
    and serves them all, so the fallback costs one flag rather than a second proxy. The head
    of the list is the one URLs are built from, because `.env.mocktown` holds one value per
    service; the rest are accepted as `Host`, aliased, and kept out of `NO_PROXY`.
  - **Which TLD is usable is asked, not assumed.** Being served is not the same as being
    reachable: `.mocktown` is in the proxy's routes and still fails to resolve until portless
    has written `/etc/hosts`. So the probe asks every candidate — configured first, then any
    the running proxy turned out to be serving that the config never mentioned — and the list
    that survives is the list that answered, most preferred first. `.env.mocktown` therefore
    carries `.mocktown` on a machine where the hosts entry exists and `.mocktown.localhost`
    on one where it does not, with nothing for anyone to edit. The polling that covers the
    proxy's reload lag runs only until *something* answers; after that a silent TLD is silent
    for a reason that does not heal by waiting, so the rest are settled in one pass. The two
    reasons it can be silent have different fixes and are reported apart: a TLD the proxy is
    not serving needs the proxy restarted with it, a TLD it serves that does not resolve needs
    `portless hosts sync`. Unusable TLDs stay in the alias table and in `NO_PROXY` even though
    no URL is built from them — answering a `Host` that does arrive costs nothing, and one
    that starts resolving mid-session because someone ran `hosts sync` should not 501.
  - **Off by default and never load-bearing.** portless binds 443 with sudo, edits
    `/etc/hosts` and installs a CA in the system trust store; that is a person's decision,
    not a config default's. Every failure degrades to loopback URLs with the reason attached.

  One defect fell out of this work: `.env.mocktown` set `HTTP_PROXY` with no `NO_PROXY`, so a
  client pointed at its mock's loopback URL would have had that request proxied into the
  front door, which would deny it as an unknown host — the redirection breaking the
  redirection. Loopback literals are now never proxied, and every portless TLD is added when
  stable names are live — both through the one bypass plan described in
  [03-capture.md](03-capture.md), so the launch wrapper, `.env.mocktown` and the
  empty-recording diagnostic cannot disagree about what reaches the front door.
