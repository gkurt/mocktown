/**
 * Project resolution and config layering — 08-projects-config.md.
 *
 * Resolution order (first hit wins):
 *   1. `--project <name>`   2. `MOCKTOWN_PROJECT`
 *   3. nearest `mocktown.json` walking up from cwd
 *   4. global default
 *
 * The *source* is carried alongside the name because every command must print the
 * resolved project — misdirection has to be visible, never silent.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as z from 'zod/v4';
import { globalConfigDir, globalConfigFile, projectDataDir, workspacePaths } from '#src/config/paths.ts';
import { GlobalConfig, LocalConfig, ProjectFile } from '#src/config/schema.ts';

export type ProjectSource = 'flag' | 'env' | 'file' | 'default';

export interface ResolvedProject {
  name: string;
  source: ProjectSource;
  /** Repo root holding `mocktown.json`, or null when resolved without one. */
  workspace: string | null;
  file: ProjectFile | null;
  local: LocalConfig;
  paths: ReturnType<typeof workspacePaths> | null;
}

function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): T {
  if (!existsSync(path)) return fallback;
  const parsed = schema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
  if (!parsed.success) throw new Error(`${path} is not valid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

export function loadGlobalConfig(): GlobalConfig {
  return readJson(globalConfigFile(), GlobalConfig, GlobalConfig.parse({}));
}

export function saveGlobalConfig(config: GlobalConfig): void {
  mkdirSync(globalConfigDir(), { recursive: true });
  writeFileSync(globalConfigFile(), `${JSON.stringify(config, null, 2)}\n`);
}

/** Nearest `mocktown.json` walking up from `from`. */
export function findProjectFile(from = process.cwd()): string | null {
  let dir = resolve(from);
  for (;;) {
    const candidate = join(dir, 'mocktown.json');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function resolveProject(opts: { project?: string; cwd?: string } = {}): ResolvedProject {
  const cwd = opts.cwd ?? process.cwd();
  const filePath = findProjectFile(cwd);
  const file = filePath ? readJson(filePath, ProjectFile, ProjectFile.parse({ project: 'main' })) : null;

  let name: string;
  let source: ProjectSource;
  if (opts.project) {
    name = opts.project;
    source = 'flag';
  } else if (process.env.MOCKTOWN_PROJECT) {
    name = process.env.MOCKTOWN_PROJECT;
    source = 'env';
  } else if (file) {
    name = file.project;
    source = 'file';
  } else {
    name = loadGlobalConfig().defaultProject;
    source = 'default';
  }

  // A workspace only counts when it is the project we actually resolved to; a
  // `--project other` run inside an unrelated repo must not inherit that repo's config.
  const workspace = filePath && file?.project === name ? dirname(filePath) : null;
  const paths = workspace ? workspacePaths(workspace) : null;
  const local = paths ? readJson(paths.localConfig, LocalConfig, LocalConfig.parse({})) : LocalConfig.parse({});

  return { name, source, workspace, file: workspace ? file : null, local, paths };
}

/**
 * A repo-local `mocktown.json` naming an unregistered project auto-registers it on
 * first use (08-projects-config.md), so `clone && mocktown up` just works.
 */
export function ensureRegistered(project: ResolvedProject): void {
  const config = loadGlobalConfig();
  const existing = config.projects[project.name];
  if (existing && existing.workspace === (project.workspace ?? null)) return;
  config.projects[project.name] = {
    dataDir: existing?.dataDir ?? projectDataDir(project.name),
    workspace: project.workspace ?? existing?.workspace ?? null,
  };
  saveGlobalConfig(config);
}

/** Effective service registry: the committed file plus local passthrough overrides. */
export function effectiveServices(project: ResolvedProject): Record<string, { provider: string; seed?: string }> {
  const services: Record<string, { provider: string; seed?: string }> = { ...(project.file?.services ?? {}) };
  for (const host of project.local.passthrough) services[host] = { provider: 'passthrough' };
  return services;
}
