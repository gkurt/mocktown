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
const PROBE_ATTEMPT_MS = 1_500;
const PROBE_POLL_MS = 150;
const PROXY_START_TIMEOUT_MS = 10_000;
/** Below this, binding needs root on every platform mocktown runs on. */
const PRIVILEGED_PORT_CEILING = 1024;

export interface PortlessSettings {
  /**
   * Most preferred first. `tlds[0]` is the one URLs are built from — an env var takes a
   * single value — and every entry is served by the proxy, accepted as a `Host`, and
   * excluded from NO_PROXY. A second spelling is the point: `.mocktown` needs the hosts
   * entry portless writes, and `.mocktown.localhost` resolves to loopback without one.
   */
  tlds: string[];
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
  /**
   * What the running proxy turned out to be serving, discovered rather than declared. Null
   * until something is proven. Callers building URLs or matching a `Host` header must use
   * this, not the configured settings, or they will disagree with the proxy.
   */
  resolved: PortlessSettings | null;
  /**
   * The TLDs that answered, flattened out of `resolved` for clients — the contract does not
   * carry the whole settings object, and "are both my TLDs actually live" is the question
   * this feature exists to answer.
   */
  tlds: string[];
  /**
   * Configured or discovered, asked, and silent. Reported rather than dropped because the
   * useful thing to know is not that `.mocktown.localhost` works — it always does — but that
   * `.mocktown` does not, and that `portless hosts sync` is the fix.
   */
  unusableTlds: string[];
  names: PortlessName[];
}

/** Nothing was proven, so no TLD is live and every one that was going to be tried is not. */
export function unavailable(enabled: boolean, reason: string, binary: string | null = null, unusable: string[] = []): PortlessStatus {
  return { enabled, available: false, reason, binary, caBundle: null, resolved: null, tlds: [], unusableTlds: unusable, names: [] };
}

/** PATH first, then the workspace's own `node_modules/.bin` — portless is often a devDependency. */
export function portlessBinary(workspace: string | null): string | null {
  const local = workspace ? join(workspace, 'node_modules', '.bin', 'portless') : null;
  if (local && existsSync(local)) return local;
  // `Bun.which` searches the PATH this process started with unless it is handed one, and
  // the daemon outlives the shell that launched it.
  return Bun.which('portless', { PATH: process.env.PATH ?? '' });
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

/** The address to hand out. One value, because everything downstream of it takes one. */
export function stableUrl(name: string, settings: PortlessSettings): string {
  const scheme = settings.tls ? 'https' : 'http';
  const defaultPort = settings.tls ? 443 : 80;
  const port = settings.port === defaultPort ? '' : `:${settings.port}`;
  return `${scheme}://${name}.${primaryTld(settings)}${port}`;
}

/** The first entry, or `localhost` if a caller managed to pass an empty list. */
export const primaryTld = (settings: PortlessSettings): string => settings.tlds[0] ?? 'localhost';

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
 * portless writes the hostname it actually created and the port it actually bound. Reading
 * those is the difference between a person keeping `mocktown.json` in step with however
 * they last started the proxy — and getting a 404 that says nothing when they do not — and
 * mocktown simply asking. This reads state files, not command output: the same seam
 * `portlessCaCerts` already uses, and unlike `portless list` it is structured data.
 *
 * Both shapes portless has shipped are accepted, and an unrecognised one degrades to the
 * configured value rather than failing, because a guess here is recoverable and a crash is not.
 */
function routeHostnames(settings: PortlessSettings): string[] {
  const file = join(stateDirOf(settings), 'routes.json');
  if (!existsSync(file)) return [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (Array.isArray(parsed)) {
      return parsed
        .map((row) => (typeof row === 'object' && row !== null ? (row as { hostname?: unknown }).hostname : undefined))
        .filter((hostname): hostname is string => typeof hostname === 'string' && hostname.length > 0);
    }
    if (typeof parsed === 'object' && parsed !== null) return Object.keys(parsed);
    return [];
  } catch {
    return [];
  }
}

/**
 * The suffixes portless appended to a name we chose are the TLDs its proxy is serving.
 *
 * Every match, not the first: a proxy started with two TLDs answers a name under both, and
 * taking only one would leave the other arriving at a front door that has never heard of
 * it. Empty when the routes file has nothing to say, and the caller falls back to config.
 */
function discoverTlds(settings: PortlessSettings, name: string): string[] {
  const prefix = `${name}.`;
  const found = routeHostnames(settings)
    .filter((hostname) => hostname.startsWith(prefix))
    .map((hostname) => hostname.slice(prefix.length))
    .filter(Boolean);
  return [...new Set(found)];
}

function discoverPort(settings: PortlessSettings): number | null {
  const file = join(stateDirOf(settings), 'proxy.port');
  if (!existsSync(file)) return null;
  const port = Number(readFileSync(file, 'utf8').trim());
  return Number.isInteger(port) && port > 0 ? port : null;
}

async function listening(port: number): Promise<boolean> {
  try {
    const socket = await Bun.connect({ hostname: '127.0.0.1', port, socket: { data() {}, error() {} } });
    socket.end();
    return true;
  } catch {
    return false;
  }
}

/**
 * Start the proxy, but only where starting it is free. An unprivileged port needs no sudo,
 * and someone who turned stable names on did not mean "and also run a second command every
 * morning" — mocktown can just do it.
 *
 * A privileged port is a different question, not a harder one: it is a root-owned daemon on
 * a person's machine, and a mocking tool does not get to decide that quietly. So that case
 * is reported with the command, never taken. The proxy is shared by every project on the
 * machine, so one that is already up is used as-is and one mocktown starts is left running.
 */
async function ensureProxy(binary: string, settings: PortlessSettings): Promise<{ ok: boolean; reason: string }> {
  const port = discoverPort(settings) ?? settings.port;
  if (await listening(port)) return { ok: true, reason: `a portless proxy is already listening on :${port}` };

  if (port < PRIVILEGED_PORT_CEILING) {
    const start = `portless proxy start${settings.tls ? '' : ' --no-tls'}`;
    return {
      ok: false,
      reason:
        `nothing is listening on :${port}, and binding it needs root — run \`${start}\` yourself, or set ` +
        `\`portless.port\` above ${PRIVILEGED_PORT_CEILING} in mocktown.json and mocktown will start the proxy without sudo`,
    };
  }

  // `--tld` repeats; portless serves every one it is given.
  const tldArgs = settings.tlds.flatMap((tld) => ['--tld', tld]);
  const args = ['proxy', 'start', '-p', String(port), ...tldArgs, ...(settings.tls ? [] : ['--no-tls'])];
  const started = await portless(binary, args, settings);
  if (!started.ok) return { ok: false, reason: `\`portless ${args.join(' ')}\` failed: ${started.output}` };

  // The command backgrounds the proxy, so its exit says it was asked, not that it is up.
  const deadline = Date.now() + PROXY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await listening(port)) return { ok: true, reason: `started a portless proxy on :${port}` };
    await Bun.sleep(PROBE_POLL_MS);
  }
  return { ok: false, reason: `\`portless ${args.join(' ')}\` reported success but nothing is listening on :${port}` };
}

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
): Promise<{ ok: boolean; reason: string; resolved: PortlessSettings | null; unusable: string[] }> {
  const nonce = id('probe');
  const name = stableName(project, `mocktown-probe-${nonce.slice(-8)}`);
  const port = await findFreePort();
  const server = Bun.serve({ port, hostname: '127.0.0.1', fetch: () => new Response(nonce) });

  /** One request, and what to tell a person if it did not come back as ours. */
  const ask = async (url: string, tls: boolean, ca: string | undefined): Promise<string | null> => {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(PROBE_ATTEMPT_MS), tls: tls && ca ? { ca } : undefined });
      const body = await response.text();
      if (body.trim() === nonce) return null;
      return `${url} answered ${response.status} but not from our listener, so something else owns that name`;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return (
        `${url} did not answer (${detail}). The proxy may not be running (\`portless proxy start\`), the CA may not be trusted ` +
        `(\`portless trust\`), or the name may not resolve (\`portless hosts sync\`).`
      );
    }
  };

  try {
    const registered = await alias(binary, name, port, settings);
    if (!registered.ok) return { ok: false, reason: `\`portless alias\` failed: ${registered.output}`, resolved: null, unusable: [] };

    // Configured order first, because that is the preference, then whatever the running proxy
    // turned out to be serving that the config never mentioned — a proxy someone started by
    // hand with a different `--tld` still works rather than reporting nothing. Which of these
    // is actually reachable is not decided here; it is decided by asking, below.
    const found = discoverTlds(settings, name);
    const candidates = [...settings.tlds, ...found.filter((tld) => !settings.tlds.includes(tld))];
    const base = { port: discoverPort(settings) ?? settings.port, stateDir: settings.stateDir };
    // Verifying against the bundle we assembled is the point: if the app would not trust
    // this certificate, neither should this probe, and a pass here means the bundle is right.
    const ca = existsSync(caBundle) ? readFileSync(caBundle, 'utf8') : undefined;

    // `portless alias` exits once the route is written, which is a moment before the running
    // proxy reloads it — fetching immediately gets the proxy's own 404 for an unknown name.
    // Every probe would fail on a working setup, so poll instead of trusting the exit code.
    //
    // Only until *something* answers, though. That first answer settles the scheme and proves
    // the route is loaded; after it, a TLD that stays silent is silent for a reason that does
    // not heal by waiting — no `/etc/hosts` entry, or a proxy not serving it — so the rest are
    // decided in one pass rather than each paying the timeout.
    const deadline = Date.now() + PROBE_TIMEOUT_MS;
    let live: { tld: string; tls: boolean } | null = null;
    let last = 'no attempt made';
    while (!live && Date.now() < deadline) {
      // The scheme is the one thing portless does not write down, so it is settled the same
      // way as everything else here: by asking, starting with what the project configured.
      for (const tls of [settings.tls, !settings.tls]) {
        for (const tld of candidates) {
          const failure = await ask(stableUrl(name, { ...base, tlds: [tld], tls }), tls, ca);
          if (!failure) {
            live = { tld, tls };
            break;
          }
          last = failure;
        }
        if (live) break;
      }
      if (!live) await Bun.sleep(PROBE_POLL_MS);
    }
    if (!live) return { ok: false, reason: last, resolved: null, unusable: candidates };

    // Now classify the rest. `.mocktown` resolves only because portless wrote `/etc/hosts`,
    // and that is the step that fails on a locked-down machine or when someone declines the
    // prompt; `.mocktown.localhost` needs nothing. Handing out the first name without
    // checking is how a person ends up with an `.env.mocktown` full of addresses that do not
    // resolve, so the list that survives here is the list that answered.
    const proven: string[] = [];
    const unusable: string[] = [];
    for (const tld of candidates) {
      if (tld === live.tld) {
        proven.push(tld);
        continue;
      }
      const failure = await ask(stableUrl(name, { ...base, tlds: [tld], tls: live.tls }), live.tls, ca);
      if (failure) unusable.push(tld);
      else proven.push(tld);
    }

    const resolved: PortlessSettings = { ...base, tlds: proven, tls: live.tls };
    const url = stableUrl(name, resolved);
    return {
      ok: true,
      reason: `proven: ${url} reached a mocktown listener on :${port} through the portless proxy${whyUnusable(unusable, found, settings)}`,
      resolved,
      unusable,
    };
  } finally {
    await unalias(binary, name, settings).catch(() => {});
    server.stop(true);
  }
}

/**
 * Why a TLD did not answer, in the only two shapes that matter, because they have different
 * fixes and telling them apart is the difference between a person restarting their proxy and
 * a person running `hosts sync` at a proxy that was never serving the name to begin with.
 *
 * The proxy is machine-wide and shared, so a config the running one predates is the ordinary
 * case, not an error — hence a sentence rather than a failure.
 */
function whyUnusable(unusable: string[], served: string[], settings: PortlessSettings): string {
  if (!unusable.length) return '';
  // An unreadable routes file leaves `served` empty, and "your proxy is not serving this"
  // would then be a guess dressed as a diagnosis.
  const missing = served.length ? unusable.filter((tld) => !served.includes(tld)) : [];
  const silent = unusable.filter((tld) => !missing.includes(tld));
  // Additive, never replacing. The proxy is one process for the whole machine, so a command
  // listing only what this project wants would quietly unserve every name another project —
  // or the person's own app — is reachable under. Config first, since that is the preference.
  const keep = [...settings.tlds, ...served.filter((tld) => !settings.tlds.includes(tld))];
  const restart = `portless proxy start${keep.map((tld) => ` --tld ${tld}`).join('')}${settings.tls ? '' : ' --no-tls'}`;
  return [
    `; nothing is handed out under .${unusable.join(', .')}`,
    missing.length
      ? ` — the running proxy does not serve .${missing.join(', .')}, so restart it with \`${restart}\`, which keeps the ` +
        `${served.length === 1 ? 'name' : 'names'} it already serves`
      : '',
    silent.length
      ? ` — .${silent.join(', .')} ${silent.length === 1 ? 'is' : 'are'} served but did not resolve, which usually means the ` +
        '`/etc/hosts` entry is missing (`portless hosts sync`)'
      : '',
  ].join('');
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
  if (input.baseUrls.size === 0)
    return unavailable(true, 'no provider is listening, so there is nothing to give a stable name to', binary, input.settings.tlds);

  // Carry portless's certificates whether or not the project declared TLS: the probe settles
  // which scheme is live, and an https proxy with no bundle to check would fail as "did not
  // answer" — true, but not the reason anyone needs.
  const proxy = await ensureProxy(binary, input.settings);
  if (!proxy.ok) return unavailable(true, proxy.reason, binary, input.settings.tlds);

  const caBundle = writeCaBundle(input.project, [input.projectCaPath, ...portlessCaCerts(input.settings)]);
  const proof = await proveUsable(binary, input.project, caBundle, input.settings);
  if (!proof.ok || !proof.resolved) return { ...unavailable(true, proof.reason, binary, proof.unusable), caBundle };
  const settings = proof.resolved;

  const names: PortlessName[] = [];
  const failures: string[] = [];
  for (const [service, baseUrl] of [...input.baseUrls].sort(([a], [b]) => a.localeCompare(b))) {
    const port = Number(new URL(baseUrl).port);
    if (!port) {
      failures.push(`${service}: ${baseUrl} has no port to alias`);
      continue;
    }
    const name = stableName(input.project, service);
    const registered = await alias(binary, name, port, settings);
    if (!registered.ok) {
      failures.push(`${service}: ${registered.output}`);
      continue;
    }
    names.push({ service, name, url: stableUrl(name, settings) });
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
    resolved: settings,
    tlds: settings.tlds,
    unusableTlds: proof.unusable,
    names,
  };
}

/** Give the names back when a serve session ends, so a stale name cannot point at a dead port. */
export async function releasePortless(status: PortlessStatus, settings: PortlessSettings, workspace: string | null): Promise<void> {
  if (!status.available || !status.names.length) return;
  const binary = status.binary ?? portlessBinary(workspace);
  if (!binary) return;
  const proven = status.resolved ?? settings;
  for (const entry of status.names) await unalias(binary, entry.name, proven).catch(() => {});
}
