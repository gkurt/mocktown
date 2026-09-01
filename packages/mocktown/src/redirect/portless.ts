/**
 * portless, wrapped — 05-redirection.md's footnote: "stable `<service>.localhost` names +
 * trusted local certs for the host/dev mode. Optional dependency, same treatment as
 * emulate (wrapped, not load-bearing)."
 *
 * The problem it solves: a provider listener gets whatever port was free, so `.env.mocktown`
 * changes every time the daemon restarts. Anything that remembers a URL — an OAuth redirect
 * URI, a committed fixture, a browser bookmark, a teammate's shell history — is wrong by
 * the next morning. With portless the same service is always `https://<service>.<project>.localhost`.
 *
 * Four decisions this file is built around:
 *
 * - **`portless alias` is the only verb we use.** Our listeners already exist and are ours
 *   to supervise; we are the case portless's readme calls "a static route (e.g. for Docker)".
 *   We never hand portless a child process to run — that is the app's business, not ours.
 * - **Availability is proven, not parsed.** No `portless list` scraping and no version
 *   sniffing: we register a throwaway alias pointing at a nonce server of our own and
 *   fetch it back through the proxy. That single request proves the proxy is up, the alias
 *   mechanism works, the name resolves, and the CA bundle we assembled actually validates
 *   the certificate the proxy serves. A green report here means an app will work.
 * - **The probe never points at a provider.** Aiming the verification request at a mock
 *   host would file an `unmatched-request` issue, so checking the plumbing would pollute
 *   the queue it exists to keep honest.
 * - **Off by default, and never load-bearing.** portless binds 443 with sudo, edits
 *   `/etc/hosts` and installs a CA in the system trust store. That is a decision a person
 *   makes, not one a mocking tool's config default makes for them. Every failure here
 *   degrades to loopback URLs with the reason attached.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { projectPaths } from '#src/config/paths.ts';
import { id } from '#src/util/id.ts';
import { findFreePort } from '#src/util/ports.ts';

/** A command that prompts in a TTY exits with a descriptive error here instead — we want the error. */
const ALIAS_TIMEOUT_MS = 15_000;
const PROBE_TIMEOUT_MS = 5_000;

export interface PortlessSettings {
  tld: string;
  port: number;
  tls: boolean;
  /** `PORTLESS_STATE_DIR`; defaults to portless's own `~/.portless`. */
  stateDir?: string;
}

export interface PortlessName {
  service: string;
  name: string;
  url: string;
}

export interface PortlessStatus {
  enabled: boolean;
  available: boolean;
  /** How availability was proven, or exactly what stopped it. Never empty. */
  reason: string;
  binary: string | null;
  /**
   * A PEM holding the project CA *and* portless's, for `NODE_EXTRA_CA_CERTS` — which takes
   * one file, and an app behind stable names has to trust both issuers.
   */
  caBundle: string | null;
  names: PortlessName[];
}

export function unavailable(enabled: boolean, reason: string, binary: string | null = null): PortlessStatus {
  return { enabled, available: false, reason, binary, caBundle: null, names: [] };
}

/** PATH first, then the workspace's own `node_modules/.bin` — portless is often a devDependency. */
export function portlessBinary(workspace: string | null): string | null {
  const local = workspace ? join(workspace, 'node_modules', '.bin', 'portless') : null;
  if (local && existsSync(local)) return local;
  return Bun.which('portless');
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'x';

/**
 * `api.stripe.com` under project `checkout` becomes `api-stripe-com.checkout`. The service
 * is the leaf so a project reads as one family of names, and dots inside a hostname become
 * hyphens — otherwise `api.stripe.com.checkout.localhost` would ask portless for a
 * four-level name that means nothing to anyone.
 */
export function stableName(project: string, service: string): string {
  return `${slug(service)}.${slug(project)}`;
}

export function stableUrl(name: string, settings: PortlessSettings): string {
  const scheme = settings.tls ? 'https' : 'http';
  const defaultPort = settings.tls ? 443 : 80;
  const port = settings.port === defaultPort ? '' : `:${settings.port}`;
  return `${scheme}://${name}.${settings.tld}${port}`;
}

export const stateDirOf = (settings: PortlessSettings) =>
  settings.stateDir ?? process.env.PORTLESS_STATE_DIR ?? join(homedir(), '.portless');

/**
 * Every certificate file in portless's state directory. The filenames are not part of its
 * documented surface, so this globs rather than assuming: anything that parses as a PEM
 * certificate in there belongs to portless, and including one certificate too many in a
 * trust bundle for local development is not a risk worth a brittle path for.
 */
export function portlessCaCerts(settings: PortlessSettings): string[] {
  const dir = stateDirOf(settings);
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  const walk = (path: string, depth: number) => {
    if (depth > 3) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) walk(child, depth + 1);
      else if (/\.(pem|crt|cer)$/.test(entry.name) && readFileSync(child, 'utf8').includes('BEGIN CERTIFICATE')) found.push(child);
    }
  };
  walk(dir, 0);
  return found.sort();
}

function writeCaBundle(project: string, certPaths: string[]): string {
  const root = projectPaths(project).root;
  mkdirSync(root, { recursive: true });
  const path = join(root, 'portless-ca-bundle.pem');
  const parts = [
    "# Generated by mocktown: the project CA plus portless's, because NODE_EXTRA_CA_CERTS takes one file.",
    ...certPaths.filter(existsSync).map((certPath) => `# ${certPath}\n${readFileSync(certPath, 'utf8').trim()}`),
  ];
  writeFileSync(path, `${parts.join('\n')}\n`);
  return path;
}

async function portless(binary: string, args: string[], settings: PortlessSettings): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn([binary, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...(settings.stateDir ? { PORTLESS_STATE_DIR: settings.stateDir } : {}) },
  });
  const timer = setTimeout(() => child.kill(), ALIAS_TIMEOUT_MS);
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  clearTimeout(timer);
  return { ok: exitCode === 0, output: `${stdout}${stderr}`.trim() || `\`portless ${args.join(' ')}\` exited ${exitCode}` };
}

const alias = (binary: string, name: string, port: number, settings: PortlessSettings) =>
  portless(binary, ['alias', name, String(port), '--force'], settings);

const unalias = (binary: string, name: string, settings: PortlessSettings) => portless(binary, ['alias', '--remove', name], settings);

/**
 * The empirical check. Returns the reason either way, because "portless is unavailable" is
 * useless to someone who has it installed — the fix is always in the detail (proxy not
 * started, CA not trusted, name not in `/etc/hosts`).
 */
async function proveUsable(
  binary: string,
  project: string,
  caBundle: string,
  settings: PortlessSettings,
): Promise<{ ok: boolean; reason: string }> {
  const nonce = id('probe');
  const name = stableName(project, `mocktown-probe-${nonce.slice(-8)}`);
  const url = stableUrl(name, settings);
  const port = await findFreePort();
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response(nonce) });

  try {
    const registered = await alias(binary, name, port, settings);
    if (!registered.ok) return { ok: false, reason: `\`portless alias\` failed: ${registered.output}` };

    const response = await fetch(url, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      // Verifying against the bundle we assembled is the point: if the app would not trust
      // this certificate, neither should this probe, and a pass here means the bundle is right.
      tls: settings.tls ? { ca: readFileSync(caBundle, 'utf8') } : undefined,
    });
    const body = await response.text();
    if (body.trim() !== nonce)
      return { ok: false, reason: `${url} answered ${response.status} but not from our listener, so something else owns that name` };
    return { ok: true, reason: `proven: ${url} reached a mocktown listener on :${port} through the portless proxy` };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      reason:
        `${url} did not answer (${detail}). The proxy may not be running (\`portless proxy start\`), the CA may not be trusted ` +
        `(\`portless trust\`), or the name may not resolve (\`portless hosts sync\`).`,
    };
  } finally {
    await unalias(binary, name, settings).catch(() => {});
    server.stop(true);
  }
}

export interface SyncPortlessInput {
  project: string;
  workspace: string | null;
  enabled: boolean;
  settings: PortlessSettings;
  /** service -> the loopback base URL its provider is listening on. */
  baseUrls: Map<string, string>;
  /** The project CA, which the bundle must keep carrying for the front door. */
  projectCaPath: string;
}

/**
 * Register a stable name per service, having first proven the whole path works. Callers
 * treat the result as advice: an unavailable status means keep using loopback URLs.
 */
export async function syncPortless(input: SyncPortlessInput): Promise<PortlessStatus> {
  if (!input.enabled) return unavailable(false, 'portless is off for this project (`portless.enabled` in mocktown.json)');

  const binary = portlessBinary(input.workspace);
  if (!binary) {
    return unavailable(
      true,
      "the `portless` binary is not on PATH or in the workspace's node_modules/.bin — `npm i -D portless` or install it globally",
    );
  }
  if (input.baseUrls.size === 0) return unavailable(true, 'no provider is listening, so there is nothing to give a stable name to', binary);

  const certs = input.settings.tls ? portlessCaCerts(input.settings) : [];
  if (input.settings.tls && certs.length === 0) {
    return unavailable(
      true,
      `no certificate was found under ${stateDirOf(input.settings)}, so an app could not be told to trust the proxy. ` +
        'Run `portless proxy start` once to generate the local CA, or set `portless.tls: false`.',
      binary,
    );
  }

  const caBundle = writeCaBundle(input.project, [input.projectCaPath, ...certs]);
  const proof = await proveUsable(binary, input.project, caBundle, input.settings);
  if (!proof.ok) return { ...unavailable(true, proof.reason, binary), caBundle };

  const names: PortlessName[] = [];
  const failures: string[] = [];
  for (const [service, baseUrl] of [...input.baseUrls].sort(([a], [b]) => a.localeCompare(b))) {
    const port = Number(new URL(baseUrl).port);
    if (!port) {
      failures.push(`${service}: ${baseUrl} has no port to alias`);
      continue;
    }
    const name = stableName(input.project, service);
    const registered = await alias(binary, name, port, input.settings);
    if (!registered.ok) {
      failures.push(`${service}: ${registered.output}`);
      continue;
    }
    names.push({ service, name, url: stableUrl(name, input.settings) });
  }

  // Partial success is still success for the services that got a name, but the ones that
  // did not have to be in the reason — silently leaving a service on a loopback URL is how
  // someone ends up debugging why one integration moved and another did not.
  return {
    enabled: true,
    available: names.length > 0,
    reason: failures.length ? `${proof.reason}; ${failures.length} service(s) could not be aliased: ${failures.join('; ')}` : proof.reason,
    binary,
    caBundle,
    names,
  };
}

/** Give the names back when a serve session ends, so a stale name cannot point at a dead port. */
export async function releasePortless(status: PortlessStatus, settings: PortlessSettings, workspace: string | null): Promise<void> {
  if (!status.available || !status.names.length) return;
  const binary = status.binary ?? portlessBinary(workspace);
  if (!binary) return;
  for (const entry of status.names) await unalias(binary, entry.name, settings).catch(() => {});
}
