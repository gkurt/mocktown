# Spike 04 — the container seal

Answers: *does a network namespace + DNS override + baked CA actually make egress
impossible — and does an escape attempt become evidence?*

**Read [FINDINGS.md](FINDINGS.md).** Short version: the seal holds, 8/8, verified against a
negative control that proves the escape attempts are real. IPv6 is reported INCONCLUSIVE
rather than green, because this host has no IPv6 egress to leak.

## Running it

```bash
bun install
bun -e 'import{generateCACertificate}from"mockttp";import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("out",{recursive:true});const c=await generateCACertificate({subject:{commonName:"Mocktown Sandbox CA"}});writeFileSync("out/ca.pem",c.cert);writeFileSync("out/ca.key",c.key,{mode:0o600})'
docker build -f Dockerfile.frontdoor -t mocktown-spike-frontdoor .
docker build -f Dockerfile.app -t mocktown-spike-app .
bun run spike.ts
```

The spike creates and destroys its own networks and containers.

## Layout

| File | What it is |
|---|---|
| `Dockerfile.frontdoor` | Node + Mockttp + dnsmasq. The only container with egress. |
| `Dockerfile.app` | What the developer's app and agent run in: no Mocktown code, just the CA in the trust store. |
| `front-door.mjs` | Serves mocks on 443, denies everything else, files wall-hits. |
| `entrypoint.sh` | Starts dnsmasq with a catch-all pointing at itself, then the front door. |
| `escape-attempts.py` | Raw TCP/UDP/IPv6 to hard-coded addresses — no DNS, no proxy, no cooperation. |
| `spike.ts` | Builds the boundary, runs the negative control first, then the eight checks. |
