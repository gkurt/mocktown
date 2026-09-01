# 04 — The Sealed Sandbox

**Status:** Implemented — phase 3; Podman, E2B and Daytona remain unverified

The sandbox is where Mocktown's core promise is enforced: **an agent running inside it
physically cannot reach staging or production.** Everything outside the sandbox is
cooperative (env vars, SDK config — see [05-redirection.md](05-redirection.md));
inside it, isolation is enforced below the process, where no app or agent behavior
can undo it.

## Guarantees and how they're enforced

*Verified 2026-08-31* by the phase-0 spike
([spikes/04-container-seal](../../spikes/04-container-seal/FINDINGS.md)), 8/8 against a
negative control proving the escape attempts succeed on an unsealed network. *Re-verified
2026-09-01 against the shipped implementation* by `mocktown sandbox verify`, which is that
spike turned into a product command — see "Certification is a feature" below.

| Property | Mechanism |
|---|---|
| Deny-by-default egress | Network namespace with exactly one route: the front door. Raw sockets included — escape is impossible, not just discouraged. Implemented as `docker network create --internal`: no route out, no NAT. |
| Unmodified code hits mocks | DNS inside the sandbox resolves mocked hostnames (`api.stripe.com`, …) to the front door. **It must be a catch-all** (`dnsmasq --address=/#/<front-door>`), not a per-host alias list: with aliases, an unknown hostname returns NXDOMAIN and the app reports a DNS failure; with the catch-all it reaches the deny wall and becomes a filed issue with the full request. That is the difference between "the app broke" and the evidence guarantee below. |
| TLS just works | Project CA baked into the image: system store + `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, `CURL_CA_BUNDLE` — at image build time. **Chromium needs its own entry**: it reads the NSS database and ignores the system store, so the same certificate is added with `certutil`. |
| Browser traffic is covered | The image ships headless Chromium. An agent testing a web app browses *inside* the boundary, so third-party scripts (Stripe.js etc.) hit the mocks too. |
| Every escape attempt is evidence | A request to an unknown host hits the deny wall and files an issue ([07-issues-agent-loop.md](07-issues-agent-loop.md)). |

**Decision: "container" means any network boundary Mocktown owns.**
Primary target is an OCI image / devcontainer layer (Linux inside, regardless of host
OS — which also eliminates the notarization/driver problem,
[10-security.md](10-security.md)). But the essential ingredient is only a network
namespace + DNS + trust store, so the same layer must be attachable to sandboxes users
already have (E2B, Daytona, plain docker/podman, CI runners). *Phase 3 ships both an
image and a devcontainer feature; only Docker is verified.*

## Topology

**Decision (phase 3): the front door stays on the host; the sandbox reaches it through
a relay.**

```
┌── sealed network (--internal: no route out, no NAT) ─────────────┐
│  app container                 relay container                    │
│  · no proxy env vars           · dnsmasq  address=/#/<relay>      │
│  · CA in trust store + NSS     · socat 80,443 → host front door   │
│  · --dns <relay>               └── also on an egress network ─────┼──▶ host
└───────────────────────────────────────────────────────────────────┘
```

The spike ran a second, containerised proxy inside the sealed network. Shipping that
would have meant two front doors with two rule sets, and traffic from the sandbox would
not have landed in the same corpus, the same issue queue or the same providers as traffic
from a recorded child process. The relay terminates nothing and decides nothing: routing,
recording, scrubbing, providers and the issue engine remain the daemon's, so a sandboxed
request is indistinguishable from a host one once it arrives. It also **removes the CA
private-key mount** the spike needed, so the blast radius in
[10-security.md](10-security.md) shrinks rather than grows when the sandbox is in use.

Consequences worth stating, because each one was a real defect during implementation:

- **The relay and the app take fixed addresses** (`.2` and `.3` of a fixed subnet). The
  relay's address is both the resolver the app is given and the answer dnsmasq returns,
  so it has to be known before either container exists.
- **The relay is created on the egress network and then joined to the sealed one.** A
  container created on an `--internal` network cannot publish a port at all — there is no
  route for the engine's proxy to reach it.
- **Published ports cross the relay inwards** (`socat` per mapping, to the app's fixed
  address). That is the opposite direction from the guarantee, and it is what lets a human
  open the app's dev server in their own browser.
- **Images are tagged by their content**, not by a version number we remember to bump. A
  fixed tag kept serving an image built before the Chromium trust store existed, and the
  sandbox looked broken rather than stale.
- **The resolver has to be authoritative, not just a catch-all.** `--address=/#/<relay>`
  defines an A record only, so with no upstream to ask, dnsmasq *refuses* the AAAA half of
  every lookup. glibc shrugs; musl treats a refusal on either half as a hard failure, so on
  any Alpine-based image every hostname became "bad address" — a DNS error instead of the
  evidence the row above promises. `--local=/#/` for the same domain turns the refusal into
  an empty answer, which is the honest reply on a network with no IPv6 at all.
- **Only ports 80 and 443 leave the sealed network.** A connection to any other port has
  nowhere to go: the seal holds, but the attempt is a connection error rather than a filed
  issue. Non-HTTP protocols are sealed, not observed.

## Modes

- `mocktown sandbox up` — sealed mode. Front door in `mock`/`deny`
  ([03-capture.md](03-capture.md)); the app, its tests, and any driving agent run
  inside, reached with `mocktown sandbox exec -- <command>`.
- `mocktown sandbox up --mode record` — same boundary, but egress allowed *through* the
  front door in `record` mode. Used to build the corpus.
- Host-side services (a human's browser, an IDE) connect from outside via the
  published proxy port — cooperative, best-effort, documented as such.

## Certification is a feature, not a spike

`mocktown sandbox verify` runs the phase-0 escape attempts on the user's own host, and —
this is the part that matters — runs them first on an **ordinary network as a negative
control**. "Every escape attempt failed" is worthless alone, because a broken script fails
too. The command reports `pass`, `fail` and `inconclusive` as three distinct outcomes and
never rounds the third up to the first.

## The human-browser gap

A human browsing from their own host browser is *outside* the boundary. This is
accepted: attended use doesn't need the hard guarantee. Mitigation is the launched
browser ([03-capture.md](03-capture.md)); consolation: well-factored web apps route
secret-key traffic through their backend, which *is* inside. Never present host mode
as carrying the sandbox guarantee.

## Open questions

- **Podman, E2B, Daytona, CI runners.** Only Docker is verified. `ContainerEngine`
  accepts Podman on CLI compatibility, not on a claim of equivalence — `--internal` is a
  Docker concept its network driver implements separately. `mocktown sandbox verify` is
  what settles it on a given host, which is the point of shipping it.
- **IPv6 remains INCONCLUSIVE, and now says so out loud in the product.** Two things
  changed in phase 3. First, the sealed network is created *without* IPv6 at all, so there
  is no IPv6 stack to leak over — a structural answer rather than a blocked attempt.
  Second, the check moved into `mocktown sandbox verify`, which creates its control
  network with `--ipv6 --subnet fd00:c0de::/64` and only asserts the seal when the control
  actually reached `2606:4700:4700::1111`. Re-run on 2026-09-01: the development host has
  no IPv6 default route at all (`route -n get -inet6` finds no route), so the control
  cannot reach IPv6 and the result is reported INCONCLUSIVE, exactly as in phase 0. The
  harness now ships, so the first user on an IPv6-capable host closes this.
- Clock/randomness determinism inside the sandbox: out of scope for v1, note for CI
  reproducibility later.
