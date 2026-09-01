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

export interface LaunchEnvOptions {
  proxyUrl: string;
  caCertPath: string;
  /** Hosts the child should reach directly, on top of loopback. Kept minimal: every entry is a hole. */
  noProxy?: string[];
}

/**
 * Loopback is never proxied. The front door itself and every provider listener are on
 * loopback, so proxying them would send a request meant for a mock into the front door,
 * which would deny it as an unknown host — the redirection breaking the redirection.
 */
const NEVER_PROXIED = ['127.0.0.1', 'localhost', '::1'];

/**
 * Whether `NO_PROXY` sends this host straight past the front door.
 *
 * Proxy clients match `NO_PROXY` entries by domain suffix, so the `localhost` entry above
 * also excludes every `*.localhost` name — a `.localhost` service silently bypasses
 * capture and records nothing. The entry has to stay (an app calling its own
 * `localhost:3000` must not be routed into the front door), so the escape hatch is to
 * report the collision rather than to pretend it cannot happen.
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
 * The env a recorded child process gets. Returned rather than applied so `mocktown env`
 * can render exactly the same set into `.env.mocktown` (05-redirection.md) — one
 * definition, so the launch wrapper and the generated file cannot drift.
 */
export function captureEnv(options: LaunchEnvOptions): Record<string, string> {
  const { proxyUrl, caCertPath } = options;
  const noProxy = [...NEVER_PROXIED, ...(options.noProxy ?? [])].join(',');

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
  };
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
