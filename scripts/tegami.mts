// scripts/tegami.mts — Tegami versioning + changelog config.
//
// Run via the `tegami` package script (`bun tegami …`).
//
// Every published package shares one version (`groups.all` + `syncBump`), so
// `mocktown`'s version stands in for the whole release.
//
// `packages/mocktown` is still `private: true`, so Tegami versions it and writes
// changelogs but skips the npm publish. Drop that field to start publishing.

import { tegami } from 'tegami';
import { runCli } from 'tegami/cli';
import { github } from 'tegami/plugins/github';

const paper = tegami({
  groups: { all: { syncBump: true } },

  // Only `packages/*` is releasable — `spikes/*` are workspace members purely so
  // their deps install, and must never be versioned or published.
  packages: (pkg) => (pkg.path.includes('/packages/') ? { group: 'all' } : undefined),

  npm: {
    client: 'bun',
  },

  plugins: [
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
