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
import { join } from 'node:path';

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

export function projectDataDir(project: string): string {
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

/** Workspace-relative paths: the committed half of a project (08-projects-config.md). */
export const workspacePaths = (repoRoot: string) => ({
  root: repoRoot,
  projectFile: join(repoRoot, 'mocktown.json'),
  localDir: join(repoRoot, '.mocktown'),
  localConfig: join(repoRoot, '.mocktown', 'config.local.json'),
  issuesDir: join(repoRoot, '.mocktown', 'issues'),
  /** Generated, gitignored: `mocktown.json`'s JSON Schema, for the editor. */
  schemaFile: join(repoRoot, '.mocktown', 'mocktown.schema.json'),
  mocksDir: join(repoRoot, 'mocks'),
  seedsDir: join(repoRoot, 'seeds'),
  envFile: join(repoRoot, '.env.mocktown'),
});
