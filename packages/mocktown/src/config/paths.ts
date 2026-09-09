/**
 * The storage layout from 08-projects-config.md, resolved in exactly one module so
 * platform differences never leak into feature code.
 *
 *   ~/.config/mocktown/config.json        global config + project registry
 *   ~/.local/share/mocktown/<project>/    machine-local project data (never committed)
 *     ├─ mocktown.sqlite                  recordings, issues, EKB, seal stamps, mock state
 *     ├─ blobs/                           content-addressed large bodies
 *     ├─ browser-profile/                 the launched browser's own profile
 *     ├─ sandbox.json                     the running sandbox's topology
 *     └─ ca/                              project root CA (key: 0600)
 */
import { homedir, platform } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';

function configHome(): string {
  if (process.env.MOCKTOWN_CONFIG_HOME) return process.env.MOCKTOWN_CONFIG_HOME;
  if (process.env.XDG_CONFIG_HOME) return process.env.XDG_CONFIG_HOME;
  if (platform() === 'win32') return process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return join(homedir(), '.config');
}

function dataHome(): string {
  if (process.env.MOCKTOWN_DATA_HOME) return process.env.MOCKTOWN_DATA_HOME;
  if (process.env.XDG_DATA_HOME) return process.env.XDG_DATA_HOME;
  if (platform() === 'win32') return process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support');
  return join(homedir(), '.local', 'share');
}

export const globalConfigDir = () => join(configHome(), 'mocktown');
export const globalConfigFile = () => join(globalConfigDir(), 'config.json');

/**
 * Where the daemon writes its port and per-session bearer token (10-security.md), plus the
 * signature of the contract it was built from, so a client can spot a daemon older than
 * itself without a round trip (contract/walk.ts).
 */
export const daemonStateFile = () => join(globalConfigDir(), 'daemon.json');

/**
 * A project name is one path segment and nothing else.
 *
 * The name reaches here from `--project`, `MOCKTOWN_PROJECT` and a committed
 * `mocktown.json`, and it is only validated as a non-empty string — so `../../x` was a
 * legal name that resolved a data directory outside `mocktown/` entirely. Reading and
 * writing there was already wrong; once a delete path exists it is a traversal with a
 * `rm -rf` on the end of it, so the check belongs at the one place every path is built.
 */
function assertProjectName(project: string): void {
  if (!project || project !== basename(project) || project === '.' || project === '..') {
    throw new Error(`"${project}" is not a usable project name: it must be a single path segment, with no separators`);
  }
}

export function projectDataDir(project: string): string {
  assertProjectName(project);
  return join(dataHome(), 'mocktown', project);
}

export const projectPaths = (project: string) => {
  const root = projectDataDir(project);
  return {
    root,
    db: join(root, 'mocktown.sqlite'),
    blobs: join(root, 'blobs'),
    ca: join(root, 'ca'),
    caCert: join(root, 'ca', 'ca.pem'),
    caKey: join(root, 'ca', 'ca.key'),
    /** A profile the launched browser owns, so nothing is added to the user's own (03-capture.md). */
    browserProfile: join(root, 'browser-profile'),
  };
};

/** What `mocktown.json`'s `dirs` block can move. Repo-root-relative, one level of naming. */
export interface WorkspaceDirs {
  mocks: string;
  issues: string;
  panels: string;
}

export const DEFAULT_DIRS: WorkspaceDirs = { mocks: '.mocktown/mocks', issues: '.mocktown/issues', panels: '.mocktown/panels' };

/**
 * A configured directory, resolved and confined to the workspace.
 *
 * `mocktown.json` is committed, so it arrives with a clone, and the mocks directory holds
 * modules the provider *imports* — a `dirs.mocks` of `../../.ssh` would be a path traversal
 * with an execution primitive on the end of it. Refusing beats sanitising: a path that
 * leaves the repo is a mistake or an attack, and neither has a sensible repair.
 */
function confine(repoRoot: string, key: string, value: string): string {
  const resolved = resolve(repoRoot, value);
  const root = resolve(repoRoot);
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new Error(`dirs.${key} must stay inside the workspace: "${value}" resolves to ${resolved}, outside ${root}`);
  }
  return resolved;
}

/** Workspace-relative paths: the committed half of a project (08-projects-config.md). */
export const workspacePaths = (repoRoot: string, dirs: Partial<WorkspaceDirs> = {}) => {
  const where = { ...DEFAULT_DIRS, ...dirs };
  return {
    root: repoRoot,
    projectFile: join(repoRoot, 'mocktown.json'),
    localDir: join(repoRoot, '.mocktown'),
    localConfig: join(repoRoot, '.mocktown', 'config.local.json'),
    /** Generated, gitignored: `mocktown.json`'s JSON Schema, for the editor. */
    schemaFile: join(repoRoot, '.mocktown', 'mocktown.schema.json'),
    /** Written on init so `.mocktown/` decides for itself what of it is committed. */
    localIgnore: join(repoRoot, '.mocktown', '.gitignore'),
    /** Where `skills export` lays out the shipped packs for an installer to pick up. */
    skillsDir: join(repoRoot, '.mocktown', 'skills'),
    issuesDir: confine(repoRoot, 'issues', where.issues),
    mocksDir: confine(repoRoot, 'mocks', where.mocks),
    panelsDir: confine(repoRoot, 'panels', where.panels),
    envFile: join(repoRoot, '.env.mocktown'),
  };
};

/**
 * What mocktown generates into `.mocktown/`, and would rather not see in a diff. Named
 * here so `.mocktown/.gitignore` can list them and leave everything else alone — the
 * mocks and panels are hand-authored, and so is whatever someone else keeps in there.
 */
export const derivedPaths = (paths: ReturnType<typeof workspacePaths>) => ({
  files: [paths.localConfig, paths.schemaFile],
  dirs: [paths.issuesDir, paths.skillsDir],
});
