# 04 — The Sealed Sandbox

**Status:** Draft

The sandbox is where Mocktown's core promise is enforced: **an agent running inside it
physically cannot reach staging or production.** Everything outside the sandbox is
cooperative (env vars, SDK config — see [05-redirection.md](05-redirection.md));
inside it, isolation is enforced below the process, where no app or agent behavior
can undo it.

## Guarantees and how they're enforced

*Verified 2026-08-31* by the phase-0 spike
([spikes/04-container-seal](../../spikes/04-container-seal/FINDINGS.md)), 8/8 against a
negative control proving the escape attempts succeed on an unsealed network — with IPv6 the
one open item (see below).

| Property | Mechanism |
|---|---|
| Deny-by-default egress | Network namespace with exactly one route: the front door. Raw sockets included — escape is impossible, not just discouraged. Implemented as `docker network create --internal`: no route out, no NAT. |
| Unmodified code hits mocks | DNS inside the sandbox resolves mocked hostnames (`api.stripe.com`, …) to the front door. **It must be a catch-all** (`dnsmasq --address=/#/<front-door>`), not a per-host alias list: with aliases, an unknown hostname returns NXDOMAIN and the app reports a DNS failure; with the catch-all it reaches the deny wall and becomes a filed issue with the full request. That is the difference between "the app broke" and the evidence guarantee below. |
| TLS just works | Project CA baked into the image: system store + `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE`, Java keystore — at image build time. |
| Browser traffic is covered | The image ships headless Chromium (Playwright-compatible). An agent testing a web app browses *inside* the boundary, so third-party scripts (Stripe.js etc.) hit the mocks too. |
| Every escape attempt is evidence | A request to an unknown host hits the deny wall and files an issue with the full request ([07-issues-agent-loop.md](07-issues-agent-loop.md)). |

**Decision: "container" means any network boundary Mocktown owns.**
Primary target is an OCI image / devcontainer layer (Linux inside, regardless of host
OS — which also eliminates the notarization/driver problem,
[10-security.md](10-security.md)). But the essential ingredient is only a network
namespace + DNS + trust store, so the same layer must be attachable to sandboxes users
already have (E2B, Daytona, plain docker/podman, CI runners).

## Modes

- `mocktown sandbox up` — sealed mode. Front door in `mock`/`deny`
  ([03-capture.md](03-capture.md)); the app, its tests, and any driving agent run
  inside.
- `mocktown sandbox record` — same boundary, but egress allowed *through* the front
  door in `record` mode. Used both to build the corpus and to run seal certification
  ([05-redirection.md](05-redirection.md)).
- Host-side services (a human's browser, an IDE) connect from outside via the
  published proxy port — cooperative, best-effort, documented as such.

## The human-browser gap

A human browsing from their own host browser is *outside* the boundary. This is
accepted: attended use doesn't need the hard guarantee. Mitigation is the launched
browser ([03-capture.md](03-capture.md)); consolation: well-factored web apps route
secret-key traffic through their backend, which *is* inside. Never present host mode
as carrying the sandbox guarantee.

## Open questions

- Image composition: one base image + app layered on top, vs. injecting Mocktown into
  the user's existing Dockerfile/devcontainer. Leaning: ship both a base image and a
  devcontainer *feature*. The phase-0 spike built the two-image form; the devcontainer
  feature is untested.
- **IPv6 egress must be namespaced identically to IPv4** (easy to forget, classic leak).
  *Still open after phase 0* ([spikes/04-container-seal](../../spikes/04-container-seal/FINDINGS.md)):
  the sealed container could not reach IPv6 — but neither could the unsealed control, because
  the test host had no IPv6 egress at all. A blocked attempt with no reachable baseline
  proves nothing, so this is recorded as INCONCLUSIVE, not passed. Phase 3 must re-run the
  spike on a host with working IPv6: create the control network with `--ipv6 --subnet
  <ULA>/64`, confirm the control reaches `2606:4700:4700::1111`, and only then assert the
  sealed container cannot.
- Clock/randomness determinism inside the sandbox: out of scope for v1, note for CI
  reproducibility later.
