/**
 * Loading generated mock modules from the workspace.
 *
 * Generated mocks are committed to the repo (06-emulation.md) and live at
 * `mocks/<service>/index.ts`. They are plain Bun modules, so loading one is an import —
 * with a cache-busting query so an agent's edit takes effect on the next
 * `mocktown serve` without restarting the daemon.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { MockModule } from '#src/mocks/types.ts';

export interface LoadedMock {
  module: MockModule;
  /** Directory the module was loaded from, for issue links. */
  dir: string;
  file: string;
}

export interface LoadResult {
  mocks: LoadedMock[];
  /** Directories that look like mocks but could not be loaded, with the reason. */
  failures: { service: string; file: string; reason: string }[];
}

/** Directory name -> service hostname. A directory name is a hint; the module decides. */
function candidateEntry(dir: string): string | null {
  for (const name of ['index.ts', 'index.js', 'mock.ts']) {
    const file = join(dir, name);
    if (existsSync(file)) return file;
  }
  return null;
}

export async function loadMocks(mocksDir: string): Promise<LoadResult> {
  const result: LoadResult = { mocks: [], failures: [] };
  if (!existsSync(mocksDir)) return result;

  for (const entry of readdirSync(mocksDir)) {
    const dir = join(mocksDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const file = candidateEntry(dir);
    if (!file) {
      result.failures.push({ service: entry, file: dir, reason: 'no index.ts in the mock directory' });
      continue;
    }

    try {
      // The query string defeats the module cache: an agent patches a mock and the next
      // serve picks it up, which is the whole point of the incremental loop.
      const imported = await import(`${file}?v=${statSync(file).mtimeMs}`);
      const module: MockModule | undefined = imported.default ?? imported.mock;
      if (!module || typeof module !== 'object') throw new Error('module has no default export');
      if (!module.service) throw new Error('module does not declare a `service`');
      if (!Array.isArray(module.routes)) throw new Error('module does not declare a `routes` array');
      result.mocks.push({ module, dir, file });
    } catch (error) {
      result.failures.push({ service: entry, file, reason: error instanceof Error ? error.message : String(error) });
    }
  }

  return result;
}
