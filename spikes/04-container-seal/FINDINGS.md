# Spike 04 — the container seal

**Status:** Complete · **Date:** 2026-08-31 · Docker 29.4.0 (Docker Desktop, macOS), Node 22-alpine, Mockttp 4.6.1

## The question

[11-roadmap.md](../../docs/design/11-roadmap.md): *"Container seal: network namespace +
DNS override + baked CA; prove a raw-socket escape attempt fails and files a wall-hit."*

This is the spike for [04-sandbox.md](../../docs/design/04-sandbox.md)'s central claim:

> an agent running inside it **physically cannot** reach staging or production … isolation
> is enforced below the process, where no app or agent behaviour can undo it.

## Verdict

**The seal holds. 8/8 — with one honest gap: IPv6 is untested, not proven.**

| | |
|---|:--:|
| Negative control: the same escape attempts succeed on an unsealed network | PASS |
| DNS override sends every hostname to the front door | PASS |
| Unmodified code reaches mocks with TLS trusted (no `-k`, no proxy config) | PASS |
| Unknown host denied and filed as a wall-hit | PASS |
| Raw-socket escape attempts all fail (6 attempts, 0 escaped) | PASS |
| IPv6 seal | **INCONCLUSIVE** |
| Front door retains egress, so `sandbox record` is possible | PASS |
| App cannot route via the front door's egress interface | PASS |

Reproduce: `bun run spike.ts` (builds nothing; run the two `docker build` commands in the
README first).

## The negative control is the important part

"Every escape attempt failed" is worthless on its own — a broken script fails too. So the
same image runs the same `escape-attempts.py` on an **ordinary bridge network** first, and
the seal is judged against that baseline:

| | unsealed (control) | sealed |
|---|---|---|
| TCP 1.1.1.1:443 · 8.8.8.8:443 · 1.1.1.1:80 | escaped | blocked |
| UDP 8.8.8.8:53 (a real DNS query) | escaped | blocked |
| TCP6 to Cloudflare and Google resolvers | blocked | blocked |

4 of 6 escape unsealed, 0 of 6 escape sealed. The attempts are raw `socket` calls to
hard-coded addresses — no DNS, no proxy, no hostname, nothing the app could be persuaded to
configure. That is the layer where cooperation ends, and it is the layer the claim is about.

## What the seal is actually made of

Three mechanisms, each doing one job, and all three are needed:

1. **`docker network create --internal`** is the namespace guarantee. Docker installs no
   route out and no NAT. This is what makes raw sockets fail.
2. **dnsmasq with `address=/#/<front-door-ip>`** is the DNS override — a *catch-all*, not a
   per-host alias list. This matters more than it looks: with per-host aliases, an unknown
   hostname returns NXDOMAIN and the app reports a DNS failure. With the catch-all, an
   unknown hostname resolves to the front door, hits the deny wall, and becomes a filed
   issue with the full request. That is the difference between "the app broke" and
   04-sandbox.md's *"every escape attempt is evidence"*.
3. **The CA in the image trust store at build time**, plus `NODE_EXTRA_CA_CERTS`,
   `REQUESTS_CA_BUNDLE`, `SSL_CERT_FILE` and `CURL_CA_BUNDLE`. A plain
   `curl https://api.stripe.com/v1/customers` — no `-k`, no proxy variables, no
   Mocktown code in the image at all — gets a 200 from the mock with TLS verified.

The **asymmetry** is tested too, because a seal that simply removes all networking would
pass every test above and make `sandbox record` impossible. The front door sits on both the
sealed network and an ordinary one; it reaches `1.1.1.1:443`, and the app cannot reach the
front door's gateway on that second network. Egress exists, and only the front door has it.

## The one gap: IPv6 is untested, not proven

04-sandbox.md flags this explicitly:

> IPv6 egress must be namespaced identically to IPv4 (easy to forget, classic leak).

The sealed container cannot reach IPv6. **But neither can the unsealed control** — Docker
Desktop's default bridge on this host has no IPv6 egress. A blocked attempt with no
reachable baseline proves nothing, so the spike reports this as INCONCLUSIVE rather than
counting it as a pass. Reporting it green would be exactly the "classic leak" the design
doc warns about, discovered later in production instead of now.

**To close it**, phase 3 must re-run this spike on a host with working IPv6 egress: create
the control network with `--ipv6 --subnet <ULA>/64`, confirm the control container reaches
`2606:4700:4700::1111`, and only then assert the sealed container cannot. Until that run
happens, the IPv6 half of the guarantee is unverified and should not be claimed.

## Notes for the implementation

- **The front door listens on 443 directly**, not only as a CONNECT proxy. Inside the
  namespace, DNS sends clients straight at it, so it must terminate TLS for arbitrary
  hostnames on the standard port. Mockttp handles both on one port.
- **`--internal` blocks the container from reaching the host too**, which is why the
  wall-hit log is exposed over HTTP from inside the sealed network rather than by reading
  the file from the host.
- **Image composition**: two images here (front door, app), which matches
  04-sandbox.md's "one base image + app layered on top" option. The devcontainer-feature
  option is untested — the front door image bundles dnsmasq and Node, and turning that into
  a feature injected into a user's own Dockerfile is a separate piece of work.
- **The CA private key is mounted read-only** into the front door and never enters the app
  image; only the certificate is baked in. That keeps
  [10-security.md](../../docs/design/10-security.md)'s blast radius as stated.

## Not covered here

- **Podman, E2B, Daytona, CI runners.** 04-sandbox.md requires the layer be attachable to
  sandboxes users already have. Only Docker was tested. `--internal` is a Docker concept;
  the equivalent for each target needs its own verification.
- **In-sandbox Chromium.** The image ships no browser, so the "browser traffic is covered"
  guarantee is untested.
- **A determined escape from a compromised front door.** The threat model is inside → out
  for an *agent*, and the front door is trusted. Nothing here tests the front door itself
  being hostile.
