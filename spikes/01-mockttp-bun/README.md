# Spike 01 — Mockttp on Bun

Answers: *does Mockttp's MITM proxy (HTTPS + HTTP/2 + WebSockets) work under Bun's
node-compat, or do we need a Node sidecar?*

**Read [FINDINGS.md](FINDINGS.md) for the answer and the decision.** Short version: Bun
fails on HTTP/2 and WebSockets for reasons that cannot be fixed from userland — the front
door runs on Node as a sidecar.

## Running it

```bash
bun install                     # from the repo root
python3 apply-bun-patches.py    # re-run after every `bun install`
```

Then:

```bash
node spike.ts                   # 6/6 — the control
SKIP=5 bun run spike.ts         # 4/5 — test 5 kills the Bun process, so it is excluded
ONLY=5 bun run spike.ts         # test 5 alone: throws, then hangs
```

`ONLY=<n>` runs a single test; `SKIP=<n,m>` omits tests. Both exist because the WebSocket
test crashes the Bun process when it runs after the others.

## Layout

| File | What it is |
|---|---|
| `spike.ts` | The six-capability matrix. Runs under both runtimes; prints PASS/FAIL. |
| `ws-client-check.mjs` | The WebSocket client + upstream, deliberately run under Node so the test measures the proxy rather than Bun's `ws` shim. |
| `apply-bun-patches.py` | The two dependency edits Bun needs to get as far as it does. Idempotent; fails loudly if a dependency version moved the anchors. |
| `repros/` | Standalone reproductions of each defect. Each runs under both runtimes and prints PASS/FAIL, so the findings don't rest on reading Mockttp's source. |

## Note on the patches

`apply-bun-patches.py` edits files in `node_modules`, which is throwaway by design — this
is a spike, not a build step. If the Bun path is ever revived, patches 1 and 2 belong
upstream (a `@httptoolkit/httpolyglot` PR and a Mockttp PR respectively), not in a
patch file we maintain.
