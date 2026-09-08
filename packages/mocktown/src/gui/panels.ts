/**
 * Panel discovery — 09-gui-plugins.md's plugin model, which is deliberately not a plugin
 * system: "a panel is one self-contained HTML file in `<repo>/.mocktown/panels/` with a
 * tiny manifest". No loader, no SDK, no version matrix. A panel is the artifact a coding
 * agent is best at producing, and it talks to the same API as every other client.
 *
 * This module only *finds* panels. Serving them — with the CSP that keeps a panel document
 * off the network (10-security.md) — is `serve.ts`'s job, and the two are separate because
 * a malformed manifest must be reportable without anything being served.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import * as z from 'zod/v4';
import { type WorkspaceDirs, workspacePaths } from '#src/config/paths.ts';
import type { Panel } from '#src/contract/schemas.ts';

/** The whole manifest format. Adding a field here is adding a field to every panel ever written. */
const PanelManifest = z.object({
  name: z.string().min(1),
  service: z.string().nullable().default(null),
  entry: z.string().min(1),
});

/** Panels that ship with the product: the worked examples an agent copies. */
export const builtinPanelDir = () => join(import.meta.dir, 'panels');

export const workspacePanelDir = (workspace: string | null, dirs?: Partial<WorkspaceDirs>) =>
  workspace ? workspacePaths(workspace, dirs).panelsDir : null;

export interface PanelListing {
  panels: Panel[];
  /** Manifests that could not be used, and why. A silently missing panel reads as a bug in the shell. */
  problems: string[];
}

function readDir(dir: string, source: Panel['source']): PanelListing {
  if (!existsSync(dir)) return { panels: [], problems: [] };
  const panels: Panel[] = [];
  const problems: string[] = [];

  for (const file of readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const path = join(dir, file);
    try {
      const parsed = PanelManifest.safeParse(JSON.parse(readFileSync(path, 'utf8')));
      if (!parsed.success) {
        problems.push(`${path}: ${z.prettifyError(parsed.error)}`);
        continue;
      }
      const entryPath = join(dir, parsed.data.entry);
      if (!contained(dir, entryPath)) {
        problems.push(`${path}: entry "${parsed.data.entry}" escapes the panel directory`);
        continue;
      }
      if (!existsSync(entryPath)) {
        problems.push(`${path}: entry "${parsed.data.entry}" does not exist`);
        continue;
      }
      panels.push({
        name: parsed.data.name,
        service: parsed.data.service,
        entry: parsed.data.entry,
        url: `/panels/${source}/${parsed.data.entry}`,
        source,
        file: entryPath,
      });
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { panels, problems };
}

export function listPanels(workspace: string | null, dirs?: Partial<WorkspaceDirs>): PanelListing {
  const dir = workspacePanelDir(workspace, dirs);
  const workspacePanels = dir ? readDir(dir, 'workspace') : { panels: [], problems: [] };
  const builtin = readDir(builtinPanelDir(), 'builtin');
  // A workspace panel with the same name wins: the point of the built-ins is to be replaced.
  const overridden = new Set(workspacePanels.panels.map((panel) => panel.name));
  return {
    panels: [...workspacePanels.panels, ...builtin.panels.filter((panel) => !overridden.has(panel.name))],
    problems: [...workspacePanels.problems, ...builtin.problems],
  };
}

/** Whether `path` really is inside `dir` — the containment check every static server needs. */
function contained(dir: string, path: string): boolean {
  const base = resolve(dir);
  const target = resolve(path);
  return target === base || target.startsWith(base + sep);
}

/**
 * The file behind a `/panels/<source>/<entry>` request, or null. Resolution is the security
 * boundary here: a panel URL is a path from an untrusted document, so `..` must not reach
 * the rest of the repo, and only the two panel directories are ever served.
 */
export function panelFile(workspace: string | null, source: string, entry: string, dirs?: Partial<WorkspaceDirs>): string | null {
  if (source !== 'builtin' && source !== 'workspace') return null;
  const dir = source === 'builtin' ? builtinPanelDir() : workspacePanelDir(workspace, dirs);
  if (!dir) return null;
  const path = join(dir, entry);
  if (!contained(dir, path) || !existsSync(path)) return null;
  return path;
}
