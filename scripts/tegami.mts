// scripts/tegami.mts — Tegami versioning + changelog config.
//
// Run via the `tegami` package script (`bun tegami …`).
//
// Every published package shares one version (`groups.all` + `syncBump`), so
// `mocktown`'s version stands in for the whole release.
//
// `mocktown` publishes; `@mocktown/gui` stays `private: true`, so Tegami versions it in
// lockstep and writes its changelogs but skips the npm publish — the shell reaches users
// bundled inside the `mocktown` tarball instead (`scripts/prepack.mts`).
//
// A changelog entry's `packages:` frontmatter is a **map**, not a list — this shape:
//
//     packages:
//       mocktown: minor
//
// A list (`- mocktown: minor`) parses to an array, matches no package, and versions
// nothing while reporting success.

import { tegami } from 'tegami';
import { runCli } from 'tegami/cli';
import { github } from 'tegami/plugins/github';

const paper = tegami({
  groups: { all: { syncBump: true } },

  // Only `packages/*` is releasable — `spikes/*` are workspace members purely so
  // their deps install, and must never be versioned or published.
  packages: (pkg) => (pkg.path.includes('/packages/') ? { group: 'all' } : undefined),

  // `npm`, not `bun`, because the release publishes with npm trusted publishing (OIDC) and
  // `bun publish` cannot do the OIDC exchange (oven-sh/bun#22423, oven-sh/bun#24855) — it
  // would fail on auth with no token in the workflow.
  //
  // The cost is the lockfile: npm's client would maintain it with
  // `npm install --package-lock-only`, writing a package-lock.json into a Bun workspace and
  // leaving `bun.lock` stale. So that step is off here and `bunLockfile` below does it with
  // the right tool.
  npm: {
    client: 'npm',
    updateLockFile: false,
  },

  plugins: [
    // Refresh `bun.lock` after a version bump, standing in for the npm client's disabled
    // lockfile step. `bun.lock` records each workspace package's version, so without this
    // the release PR carries a lockfile still naming the old one.
    {
      name: 'bun-lockfile',
      async applyCliDraft() {
        const proc = Bun.spawn(['bun', 'install', '--lockfile-only'], { cwd: this.cwd, stdout: 'inherit', stderr: 'inherit' });
        if ((await proc.exited) !== 0) throw new Error('failed to refresh bun.lock after versioning');
      },
    },
    github({
      repo: 'gkurt/mocktown',
      versionPr: {
        base: 'main',
        // Put the release version in the PR title ("chore: release v0.20.0")
        // instead of Tegami's default "Version Packages", mirroring the old
        // Changesets workflow.
        //
        // `create` runs AFTER the draft is applied, so the graph already holds
        // the bumped versions — read the new version straight off it. Do NOT
        // call `bumpVersion` here: the graph is post-apply, so it would bump a
        // second time (0.20.0 -> 0.21.0).
        create() {
          const version = this.graph.get('npm:mocktown')?.version;
          return { title: version ? `chore: release v${version}` : 'chore: release' };
        },
      },
    }),
  ],
});

await runCli(paper);
