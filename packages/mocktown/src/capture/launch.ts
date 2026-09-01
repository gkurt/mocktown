/**
 * Rung 1 of 03-capture.md's escalation ladder: `mocktown record -- <cmd>` injects proxy
 * env vars and per-runtime CA knobs into the child process tree.
 *
 * `NODE_USE_ENV_PROXY=1` is the one that is easy to miss and expensive to get wrong.
 * Spike 05 found Octokit v22 — configured with an explicit proxy agent — going straight
 * to the real GitHub API and coming back with a genuine request id, because SDKs built
 * on `fetch`/undici ignore `http.Agent` entirely *and* ignore `HTTPS_PROXY` unless that
 * variable is set. Without it a large and growing class of modern SDKs escapes the front
 * door while appearing correctly configured.
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { spkiFingerprints } from '#src/capture/browser.ts';

export interface LaunchEnvOptions {
  proxyUrl: string;
  caCertPath: string;
  /** The complete bypass list — normally `planNoProxy().entries`. Every entry is a hole. */
  noProxy?: string[];
}

/**
 * Loopback literals, which are unconditional: the front door itself and every provider
 * listener are on loopback, so proxying them would send a request meant for a mock into
 * the front door, which would deny it as an unknown host — the redirection breaking the
 * redirection. They are also safe to keep forever, because nobody records a service by
 * bare IP; a recorded service is always a hostname.
 */
const NEVER_PROXIED = ['127.0.0.1', '::1'];

/**
 * The bare name is the whole problem. It keeps an app's own `localhost:3000` out of the
 * front door, which it must — but proxy clients match `NO_PROXY` by domain suffix, so it
 * silently takes every `*.localhost` name with it and a `.localhost` upstream records
 * nothing. There is no exact-match syntax to reach for: a leading dot means the same
 * thing, and port-scoped entries are not portable (undici and urllib honour
 * `localhost:3000`, curl ignores the port and proxies it anyway). So the entry is
 * *planned* rather than fixed — see `planNoProxy`.
 */
const LOCALHOST = 'localhost';

export interface NoProxyInputs {
  /** `noProxy` from `mocktown.json`: hosts the app reaches itself, never through the front door. */
  declared?: string[];
  /** Registered services. One on a `.localhost` name is what makes the blanket entry untenable. */
  services?: string[];
  /** Entries the runtime must add whatever the services say — the portless TLD, when stable names are live. */
  required?: string[];
}

export interface NoProxyPlan {
  /** The complete `NO_PROXY` value, in order. */
  entries: string[];
  /** Services still bypassed by the final list, so the caller can say so out loud. */
  bypassed: string[];
  /** Whether the blanket `localhost` entry was dropped to let a `.localhost` service be seen. */
  droppedLocalhost: boolean;
}

/**
 * Compute the bypass list from what the project declared rather than from a fixed
 * constant. The blanket `localhost` entry is dropped as soon as a registered service
 * would collide with it — a `.localhost` upstream the app is supposed to record outranks
 * a convenience that only matters for hosts the project can name in `noProxy`.
 *
 * A collision it cannot resolve is reported, not hidden: under portless, `.<tld>` bypass
 * is mandatory (the app must reach its own mocks directly), so a `.localhost` upstream is
 * unrecordable in that mode by construction. `bypassed` is what says so.
 */
export function planNoProxy(inputs: NoProxyInputs = {}): NoProxyPlan {
  const services = inputs.services ?? [];
  const declared = inputs.declared ?? [];
  const required = inputs.required ?? [];

  const collides = services.some((service) => bypassedByNoProxy(service, [LOCALHOST]));
  const entries = [...NEVER_PROXIED, ...(collides ? [] : [LOCALHOST]), ...declared, ...required].filter(
    (entry, index, all) => entry.length > 0 && all.indexOf(entry) === index,
  );

  return {
    entries,
    bypassed: services.filter((service) => bypassedByNoProxy(service, entries)),
    // Only a bypass the app actually lost: a project that declares `localhost` back — or a
    // portless TLD that covers it — has not lost it, so there is nothing to warn about.
    droppedLocalhost: collides && !bypassedByNoProxy(LOCALHOST, entries),
  };
}

/**
 * Whether `NO_PROXY` sends this host straight past the front door. Suffix matching is the
 * rule every proxy client implements, and the reason `planNoProxy` exists.
 */
export function bypassedByNoProxy(host: string, noProxy: string[] = NEVER_PROXIED): boolean {
  const name = host.replace(/:\d+$/, '').toLowerCase();
  return noProxy.some((entry) => {
    const rule = entry.replace(/^\./, '').toLowerCase();
    if (!rule) return false;
    return name === rule || name.endsWith(`.${rule}`);
  });
}

/**
 * Whether a hostname is this machine talking to itself. RFC 6761 makes `localhost` and
 * every `*.localhost` name loopback by definition, so this needs no DNS — and that is
 * exactly the population `planNoProxy` stops bypassing, which is why the front door can
 * recognise an app's own service in a wall hit and say so.
 */
export function isLoopbackName(host: string): boolean {
  const name = host
    .replace(/:\d+$/, '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (name === LOCALHOST || name.endsWith(`.${LOCALHOST}`)) return true;
  if (name === '::1' || name === '0:0:0:0:0:0:0:1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(name);
}

/**
 * The env a recorded child process gets. Returned rather than applied so `mocktown env`
 * can render exactly the same set into `.env.mocktown` (05-redirection.md) — one
 * definition, so the launch wrapper and the generated file cannot drift.
 */
export function captureEnv(options: LaunchEnvOptions): Record<string, string> {
  const { proxyUrl, caCertPath } = options;
  const noProxy = (options.noProxy ?? planNoProxy().entries).join(',');
  const spki = spkiOf(caCertPath);

  return {
    HTTP_PROXY: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    https_proxy: proxyUrl,
    NO_PROXY: noProxy,
    no_proxy: noProxy,

    // Node's global `fetch` honours proxy env vars only with this set (spike 05).
    NODE_USE_ENV_PROXY: '1',
    NODE_EXTRA_CA_CERTS: caCertPath,

    // Python (requests / httpx / certifi-based), curl, OpenSSL-linked tools.
    REQUESTS_CA_BUNDLE: caCertPath,
    SSL_CERT_FILE: caCertPath,
    CURL_CA_BUNDLE: caCertPath,
    // Go's crypto/x509 on Linux; harmless elsewhere.
    SSL_CERT_DIR: '',
    // .NET and Deno respect these.
    DENO_CERT: caCertPath,

    MOCKTOWN_PROXY: proxyUrl,
    MOCKTOWN_CA: caCertPath,

    // A browser reads none of the CA variables above: Chrome's own verifier is the only one
    // that matters to it, and the narrow way to satisfy that is to name the key rather than
    // to switch verification off — `--ignore-https-errors` and friends accept *any*
    // certificate, which is the escape this product exists to close. So a driver that
    // launches its own Chromium (agent-browser, Playwright, Puppeteer) gets the fingerprint
    // it has to pass through, and `agent-browser` gets the flag ready to use.
    //
    // `AGENT_BROWSER_ARGS` is a whole list, not an addition to one: agent-browser's own
    // `--args` replaces it rather than merging, so a run needing further switches passes
    // this one alongside them.
    ...(spki ? { MOCKTOWN_CA_SPKI: spki, AGENT_BROWSER_ARGS: `--ignore-certificate-errors-spki-list=${spki}` } : {}),
  };
}

/**
 * The CA's public keys in the form Chrome's flag wants, or nothing when the file cannot be
 * read. Best-effort rather than fatal: every other variable here still points a recorded
 * process at the front door, and a browser knob is not worth failing a launch over.
 */
function spkiOf(caCertPath: string): string | null {
  try {
    const hashes = spkiFingerprints(readFileSync(caCertPath, 'utf8'));
    return hashes.length > 0 ? hashes.join(',') : null;
  } catch {
    return null;
  }
}

/**
 * Java needs a keystore rather than a PEM, so we can't set it mechanically — 05's
 * report and agent task list surface this as a manual rung instead of pretending.
 */
export const JAVA_GUIDANCE =
  'Java: import the CA into a keystore and set ' +
  'JAVA_TOOL_OPTIONS=-Djavax.net.ssl.trustStore=<store> -Djavax.net.ssl.trustStorePassword=<pw>, ' +
  'plus -Dhttp.proxyHost/-Dhttp.proxyPort.';

export interface LaunchResult {
  exitCode: number;
  signal: NodeJS.Signals | null;
}

/**
 * Same child, output captured instead of inherited — for the runs nobody is watching: a
 * drift check on a timer, a flow driven by an agent through the API. The tail is kept
 * rather than the whole stream, because a failing flow needs its error, not a log dump.
 */
export async function launchCaptured(
  command: string,
  env: Record<string, string>,
  options: { cwd?: string; tail?: number; timeoutMs?: number } = {},
): Promise<LaunchResult & { output: string }> {
  const child = spawn(command, {
    shell: true,
    cwd: options.cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  const tail = options.tail ?? 2000;
  const collect = (buf: Buffer) => {
    output = `${output}${buf.toString()}`.slice(-tail);
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  const result = await new Promise<LaunchResult>((resolve, reject) => {
    const timer = options.timeoutMs
      ? setTimeout(() => {
          child.kill('SIGKILL');
        }, options.timeoutMs)
      : undefined;
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? (signal ? 129 : 1), signal });
    });
  });

  return { ...result, output };
}

/** Run a command with the capture env, streaming its output through untouched. */
export function launch(command: string, args: string[], env: Record<string, string>): Promise<LaunchResult> {
  const child = spawn(command, args, {
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });

  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ exitCode: code ?? (signal ? 129 : 1), signal }));
  });
}
