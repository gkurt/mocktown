# Upstream reports — drafts

Four reports produced by [spike 01](../FINDINGS.md). **All four are filed.** The `.md`
files here are the drafts as submitted, minus the scaffolding header.

| Draft | Filed as | Fixes |
|---|---|---|
| [`bun-issue-1-net-server-emit-connection.md`](bun-issue-1-net-server-emit-connection.md) | [oven-sh/bun#41060](https://github.com/oven-sh/bun/issues/41060) | Defect 1 — the silent MITM hang |
| [`bun-issue-2-snicallback-suppresses-alpn.md`](bun-issue-2-snicallback-suppresses-alpn.md) | [oven-sh/bun#41061](https://github.com/oven-sh/bun/issues/41061) | Defect 3 — the silent h2 downgrade |
| [`pr-httpolyglot-reinjected-connections.md`](pr-httpolyglot-reinjected-connections.md) | [httptoolkit/httpolyglot#4](https://github.com/httptoolkit/httpolyglot/pull/4) | Works around defect 1 |
| [`pr-mockttp-seclevel-feature-detect.md`](pr-mockttp-seclevel-feature-detect.md) | [httptoolkit/mockttp#206](https://github.com/httptoolkit/mockttp/pull/206) | Works around defect 2 |

**mockttp#206 is blocked on a CLA** that has to be signed by the PR author in person, at
<https://cla-assistant.io/httptoolkit/mockttp?pullRequest=206>. Until that's done the PR
cannot merge no matter what CI says.

Branches live on the `gkurt` forks: `explicit-connection-listener` and
`seclevel-feature-detect`.

The two Bun issues are the ones that matter to us: they are the
[revisit criteria](../FINDINGS.md) for the Node-sidecar decision. Until they're fixed the
sidecar is permanent. Defect 4 (Bun's builtin `ws` shadowing the npm package) is
deliberately not drafted — it's been reported since 2023 in
[#2955](https://github.com/oven-sh/bun/issues/2955),
[#3613](https://github.com/oven-sh/bun/issues/3613),
[#4568](https://github.com/oven-sh/bun/issues/4568) and
[#4529](https://github.com/oven-sh/bun/issues/4529).

## Repros

Both are dependency-free and print a comparison table. Run each under both runtimes:

```bash
node upstream/bun-issue-net-server-repro.mjs && bun run upstream/bun-issue-net-server-repro.mjs
```

```bash
node upstream/bun-issue-alpn-repro.mjs && bun run upstream/bun-issue-alpn-repro.mjs
```

`bun-issue-alpn-repro.mjs` embeds a throwaway self-signed cert and key so it can be
pasted into an issue and run as-is. They are test-only and not used anywhere else.

## Patches

The `.patch` files apply to a clean clone of each upstream repo, at the commits named in
the corresponding `.md`:

```bash
git -C httpolyglot apply /path/to/pr-httpolyglot-reinjected-connections.patch
```

Both were verified by applying them to a fresh clone and running that project's own test
suite — not by reasoning about the diff. Results are in each PR description.

## One trap, if you re-verify any of this

**`bun x <tool>` runs the tool under Node**, because the installed binary's `#!/usr/bin/env node`
shebang wins. A test that is supposed to fail under Bun will pass, and it looks like the
bug doesn't exist. Use `bun --bun x <tool>`. This cost real time here: the httpolyglot
regression test appeared to pass against unpatched source until a stack trace showed
`node:net` frames.
