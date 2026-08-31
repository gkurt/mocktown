# Spike 03 — emulate as managed child processes

**Status:** Complete · **Date:** 2026-08-31 · Bun 1.4.0, emulate 0.10.0, stripe 19.x, @octokit/rest 22.x

## The question

[11-roadmap.md](../../docs/design/11-roadmap.md): *"emulate driven as child processes:
start/stop/seed Stripe + GitHub, point real SDKs at them, confirm OAuth flow works
end-to-end."*

The real subject is `provider.ts` — the wrapper [06-emulation.md](../../docs/design/06-emulation.md)
insists on: *"emulate is wrapped, never load-bearing … nothing outside the provider layer
imports it or assumes its config format."* Every test talks to that wrapper and to real
vendor SDKs; none of them talks to emulate directly.

## Verdict

**emulate is viable as a wrapped child process. The wrapper decision holds.** Real SDKs
work against it unmodified, and the OAuth flow completes end to end — including the issued
token authenticating a subsequent SDK call.

| | |
|---|:--:|
| Provider starts emulate and reports per-service base URLs | PASS |
| Seed file applied to both services | PASS |
| Real Stripe SDK (customer, retrieve, PaymentIntent) via `host`/`port`/`protocol` | PASS |
| Real Octokit (get repo, create issue, list issues) via `baseUrl` | PASS |
| OAuth end-to-end: authorize → consent → code → token → authenticated SDK call | PASS |
| emulate ports are loopback-only | **FAIL** — binds every interface |
| `stop()` terminates the child and frees the port | PASS |
| Restart is reproducible from the seed | PASS |
| | **7/8** |

Reproduce: `bun run spike.ts`.

## Seven things the design needs to absorb

### 1. One emulate process serves N services — the Provider interface assumes otherwise

[06-emulation.md](../../docs/design/06-emulation.md) sketches `Provider` as one object per
service, with `start()` returning a single `baseUrl`. emulate does not work that way:
`emulate start -s stripe,github -p 4400` is **one process** listening on **4400 for Stripe
and 4401 for GitHub** — base port plus an offset per service, in the order given.

So the emulate provider is a *supervisor* for a set of services, not a per-service object.
Two consequences for the implementation:

- Port allocation must find a **contiguous run** of free ports, not one free port
  (`EmulateProvider.findFreePortRun`). Probing a single port and assuming `+1` is free is a
  race waiting to happen on a developer's machine.
- Base URLs are discovered by parsing emulate's stdout banner, since the offsets aren't
  documented as a contract. That parser is the fragile part of the wrapper and belongs
  behind the seam — which is exactly where it is.

The provider interface should gain a way to express "this backend serves these N services",
with the per-service `baseUrl` lookup layered on top.

### 2. emulate's startup banner is not a readiness signal

Found while building [spike 05](../05-scrubber/FINDINGS.md)'s corpus, then fixed here.
emulate prints `  google  http://localhost:4602` for **every** requested service before they
are all actually listening. With three services, the third was still refusing connections
seconds after being announced — the forwarding proxy got `ECONNREFUSED` against a URL
emulate had already advertised.

The first version of `provider.ts` waited for the banner and returned. That is a race; it
passed only because two services come up fast enough to hide it. The wrapper now **probes
each announced URL until it answers** before `start()` resolves (`waitForListening`), and
fails with a specific error if a service never comes up.

Worth stating as a general rule for provider implementations: **a child process's stdout is
evidence of intent, not of readiness.** Anything a provider reports as started must have
been observed answering.

### 3. emulate binds every interface — mock services are exposed to the LAN

The only failing test, and it is a real one: with emulate running, the Stripe emulator was
reachable from this machine's LAN address, not just loopback. That contradicts
[10-security.md](../../docs/design/10-security.md)'s posture, and it is worse than it first
looks — the GitHub emulator **mints OAuth tokens**, so anyone on the same network can drive
a developer's local emulator and, during a recording run, influence what gets recorded.

There is no way to constrain it from outside: neither `emulate start` nor the programmatic
`createEmulator` accepts a bind address. The cause is a one-line gap — emulate's internal
`serve()` does `server.listen(port, options.hostname)`, but no caller ever sets
`options.hostname`, so it is always `undefined` and Node binds `::`.

Disposition:

- **Sandbox mode solves it by construction** ([04-sandbox.md](../../docs/design/04-sandbox.md)):
  inside the network namespace there is no LAN to be exposed to.
- **Host mode must document it**, and Mocktown should warn when a project starts emulate
  providers on a machine with a non-loopback interface.
- **Upstream is the real fix**: a `--host` flag threading through to that `listen` call is a
  small PR. Worth filing — the plumbing already exists.

### 4. Seeds are additive to emulate's built-in defaults

With **no seed file at all**, the Stripe emulator already contains `test@example.com`. With
our seed file, the registry contains our `ada@example.com` *and* that default. `--seed` adds
to a built-in baseline rather than replacing it.

This dilutes the reproducibility guarantee 06-emulation.md wants from committed seeds: the
baseline is emulate's defaults, which can change between versions. It does not break the
design — pinning exact versions is already the decision — but the reason for pinning is now
stronger, and generated mocks or tests must not assume the corpus contains only seeded
entities. Where a test needs an exact set, it should assert against the seeded entities
specifically rather than against counts.

### 5. The restart-based reset in 12-scenario-controls.md is validated — and there is a faster path

[12-scenario-controls.md](../../docs/design/12-scenario-controls.md) specifies:
*"Emulator providers reset by child-process restart with the same seed config."* Test 8
exercises exactly that and it holds: after a restart, the seeded `ada@example.com` is
present and the `grace@example.com` created at runtime is gone. Measured cost: a few
seconds per restart — fine for `mocktown state reset`, too slow to run between every test
case the way the generated-mock path can (drop + re-seed SQLite tables).

emulate also exports a programmatic API (`createEmulator`) whose in-process `reset()` is
effectively instant. Verified working under Bun (`programmatic-check.ts`): seed applied, a
runtime write observed, `reset()` restoring seeded state exactly. **Recorded as an option,
not adopted** — see below. If per-test-case reset on emulator services becomes a real
requirement, the right move is to ask upstream for a reset *endpoint* on the running
server, which keeps the child-process boundary intact.

### 6. The in-process API is not worth the boundary it costs

The child-process decision stands, for the reasons 06-emulation.md already gives and one
this spike adds:

- emulate is a Node package. Importing it into the daemon puts a volatile Node dependency
  in-process on Bun — the exact shape of the problem that cost us the front door in
  [spike 01](../01-mockttp-bun/FINDINGS.md).
- In-process means an emulate crash is a daemon crash.
- It would not fix the binding problem anyway; `createEmulator` has no host option either.

### 7. OAuth consent is a user picker — which lines up with auth profiles

emulate's OAuth consent screen is not a login form; it is a list of seeded users, and you
proceed by POSTing `login=<user>` to `/login/oauth/callback`. That maps cleanly onto
[12-scenario-controls.md](../../docs/design/12-scenario-controls.md)'s auth profiles: a
profile's persona is a seeded emulate user, and "sign in as this profile" is a scripted
consent POST rather than a real credential exchange.

Two consequences: the EKB recipe for any emulate-backed OAuth service must describe this
step or an unattended agent run will hang on an HTML page; and 12's promise that
*"sign-in is real … through the app's normal login flow"* is only true for generated mocks.
For emulate-backed services it is a consent-screen shortcut, and the profile roster should
say so rather than implying credentials work uniformly across provider kinds.

## Implementation notes

- **Both EKB recipes were exercised and both are rung 1 or 2** of
  [05-redirection.md](../../docs/design/05-redirection.md)'s preference order: Stripe takes
  `host`/`port`/`protocol` constructor options, Octokit takes `baseUrl`. Neither needed a
  code patch, which is what the redirection design predicted for famous services.
- **`stop()` needs SIGTERM with a SIGKILL fallback.** The wrapper allows 3s.
- **emulate emits base URLs as `http://localhost:<port>`**; the wrapper rewrites these to
  `127.0.0.1` so that nothing downstream resolves `localhost` to `::1` and misses.

## Not tested here

- The other twelve services (Google, Slack, AWS, Okta, Clerk, …). Stripe and GitHub were the
  spike's remit; the two EKB recipe shapes they cover are the common ones.
- Behaviour when emulate crashes mid-run. The wrapper tracks `isRunning` so the daemon can
  detect it, but no restart/backoff policy exists yet — that belongs with the issue engine
  in phase 2.
- Webhook delivery (emulate advertises Stripe webhook signatures). Recording an inbound
  webhook is a different path from the outbound traffic this spike covers.
