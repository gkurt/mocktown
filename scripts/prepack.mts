// scripts/prepack.mts — assemble the parts of the tarball that are not in git.
//
// Run by `mocktown`'s `prepack` script, so `bun pm pack` and `bun publish` (which is how
// Tegami publishes) both get it for free. Everything it writes is gitignored: these are
// build outputs, and committing them would be a second copy of something that already has
// a source of truth.
//
// It ends by asserting that each part is really there. A tarball missing the shell or the
// licence still installs and still *mostly* works — the exact silent-degradation failure
// this project refuses everywhere else — so the publish fails loudly here instead.

import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = join(root, 'packages', 'mocktown');

async function run(cmd: string[], cwd: string) {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if ((await proc.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

// The pack is generated, and a stale `pack.gen.ts` would ship a skill a version behind the
// markdown it was written from. Regenerating costs nothing and removes the question.
await run(['bun', 'run', 'gen:skills'], root);

// The shell is bundled rather than published separately (see `guiDist` in src/gui/serve.ts),
// so the publish is the one place that has to build it.
await run(['bun', '--filter=@mocktown/gui', 'run', 'build'], root);
const shell = join(root, 'packages', 'gui', 'dist');
const bundled = join(pkg, 'gui-dist');
rmSync(bundled, { recursive: true, force: true });
// Without the sourcemaps: they are 2.2MB against the shell's 0.5MB, they are only useful
// to someone editing the shell — who has the repo — and every install pays for them.
cpSync(shell, bundled, { recursive: true, filter: (src) => !src.endsWith('.map') });

// Node refuses to type-strip TypeScript under `node_modules`, so the sidecar the front door
// spawns has to reach users as JavaScript or an installed mocktown cannot proxy anything.
// `mockttp` stays external: it is a runtime dependency, and bundling it would ship a second
// copy along with its optional native deps.
const sidecar = join(pkg, 'src', 'frontdoor', 'sidecar.js');
await run(
  ['bun', 'build', 'src/frontdoor/sidecar.ts', '--target', 'node', '--format', 'esm', '--external', 'mockttp', '--outfile', sidecar],
  pkg,
);

// npm only reads the licence file sitting beside the manifest, and the repo's is at the
// root. Copying keeps one editable copy rather than two that can disagree.
cpSync(join(root, 'LICENSE'), join(pkg, 'LICENSE'));

const missing = [join(bundled, 'index.html'), join(pkg, 'LICENSE'), join(pkg, 'src', 'skills', 'pack.gen.ts'), sidecar].filter(
  (path) => !existsSync(path),
);
if (missing.length > 0) throw new Error(`prepack did not produce:\n${missing.map((path) => `  ${path}`).join('\n')}`);

console.log('prepack: shell bundled, sidecar compiled, licence copied, skill pack generated');
