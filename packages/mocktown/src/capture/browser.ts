/**
 * Rung 2 of 03-capture.md's escalation ladder: the launched browser.
 *
 * > for web-app client traffic: fresh browser profile, `--proxy-server` set, CA trusted
 * > in that profile only (HTTP Toolkit's pattern).
 *
 * Trust is narrower than "in that profile": the CA is passed as an
 * `--ignore-certificate-errors-spki-list` entry, which names *one* public key and applies
 * only to this launch. Chrome accepts a certificate whose chain contains a listed key and
 * nothing else — so a stray HTTPS error in this window is still an error, and no trust
 * outlives the process. Editing the profile's NSS database would have been the alternative:
 * more platform-specific code, and it leaves trust behind on disk.
 *
 * The gap this does *not* close is stated plainly in 04-sandbox.md: a human browsing from
 * their own browser is outside the sandbox boundary. This is the mitigation for attended
 * work, never the guarantee.
 *
 * CDP is opt-in for the same reason the GUI token is injected rather than bundled: the debug
 * endpoint is a capability, not a diagnostic. Anything that can reach it drives the browser,
 * reads the profile's cookies and navigates it anywhere, with no further authentication —
 * Chrome's only defence is that it binds to loopback. So a window gets one when a caller asks
 * for one, and unattended work belongs in the sandbox regardless.
 */
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

export interface BrowserLaunchOptions {
  proxyUrl: string;
  caCert: string;
  profileDir: string;
  url?: string;
  /** Explicit executable, for a browser we don't know about. */
  executable?: string;
  /**
   * Expose CDP on this port so a driver (Playwright, Puppeteer) can attach to *this*
   * window and keep its capture. `0` asks Chrome for an ephemeral port, which is the
   * better choice for automation: a fixed port is one more thing that can already be in
   * use. Off unless asked for: the endpoint is a capability (see the module header).
   */
  debugPort?: number;
}

export interface BrowserDebugEndpoint {
  port: number;
  webSocketDebuggerUrl: string;
}

export interface BrowserLaunch {
  executable: string;
  profileDir: string;
  args: string[];
  pid: number | null;
  /** The one public key this window will accept beyond the system store. */
  spkiHash: string;
  /** Present only when `debugPort` was asked for. */
  debug: BrowserDebugEndpoint | null;
}

/** Chromium-family only: the flags below are Chrome's, and Firefox needs a different path. */
const CANDIDATES: Record<string, string[]> = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  ],
  linux: [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/brave-browser',
  ],
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ],
};

export function findBrowser(explicit?: string): string | null {
  const preferred = explicit ?? process.env.MOCKTOWN_BROWSER;
  if (preferred) return existsSync(preferred) ? preferred : null;
  return (CANDIDATES[platform()] ?? CANDIDATES.linux!).find((path) => existsSync(path)) ?? null;
}

/**
 * Base64 of the SHA-256 of the CA's SubjectPublicKeyInfo — the identifier Chrome matches
 * against every certificate in a chain.
 */
export function spkiFingerprint(caCert: string): string {
  const spki = new X509Certificate(caCert).publicKey.export({ format: 'der', type: 'spki' });
  return createHash('sha256').update(spki).digest('base64');
}

export function browserArgs(options: BrowserLaunchOptions): { args: string[]; spkiHash: string } {
  const spkiHash = spkiFingerprint(options.caCert);
  return {
    spkiHash,
    args: [
      `--user-data-dir=${options.profileDir}`,
      // Loopback is excluded by Chrome's default bypass list, which is what a developer
      // wants: the dev server stays direct while third-party scripts transit the front door.
      `--proxy-server=${options.proxyUrl}`,
      `--ignore-certificate-errors-spki-list=${spkiHash}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      // Chrome binds the debug endpoint to loopback and refuses it outright on the *default*
      // profile — neither is a concern here, because we always bring our own `--user-data-dir`.
      ...(options.debugPort === undefined ? [] : [`--remote-debugging-port=${options.debugPort}`]),
      ...(options.url ? [options.url] : []),
    ],
  };
}

/**
 * Chrome writes the live debug port and the browser's WebSocket path here once the endpoint
 * is actually listening, so the file is both the answer and the readiness signal. We read it
 * rather than polling `/json/version` because it is the only way to learn an *ephemeral*
 * port, and because a file that does not exist yet is unambiguous where a refused connection
 * is not.
 */
const DEVTOOLS_PORT_FILE = 'DevToolsActivePort';
const DEBUG_ENDPOINT_TIMEOUT_MS = 15_000;

async function debugEndpoint(profileDir: string, exitCode: () => number | null): Promise<BrowserDebugEndpoint> {
  const file = join(profileDir, DEVTOOLS_PORT_FILE);
  const deadline = Date.now() + DEBUG_ENDPOINT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    const code = exitCode();
    // A browser already running on this profile hands the URL to *that* process and exits.
    if (code !== null) {
      throw new Error(
        `the browser exited (${code}) before the CDP endpoint came up. A window is probably already open on ` +
          `${profileDir} — close it, or launch without --debug-port and drive your own browser at the front door instead.`,
      );
    }
    // Chrome writes the two lines in one pass, but a partial read is still possible.
    const [port, path] = (existsSync(file) ? readFileSync(file, 'utf8') : '').split('\n');
    if (port && path?.trim()) return { port: Number(port), webSocketDebuggerUrl: `ws://127.0.0.1:${port}${path.trim()}` };
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`the browser did not publish a CDP endpoint within ${DEBUG_ENDPOINT_TIMEOUT_MS}ms (${file} never appeared)`);
}

export async function launchBrowser(options: BrowserLaunchOptions): Promise<BrowserLaunch> {
  const executable = findBrowser(options.executable);
  if (!executable) {
    throw new Error(
      'no Chromium-family browser found. Set MOCKTOWN_BROWSER to the executable, or capture the traffic another way — ' +
        '`mocktown record -- <cmd>` for server-side SDKs, `mocktown import --path <file.har>` for anything else.',
    );
  }

  mkdirSync(options.profileDir, { recursive: true });
  // A stale file from the last launch would answer the wrong port with total confidence.
  if (options.debugPort !== undefined) rmSync(join(options.profileDir, DEVTOOLS_PORT_FILE), { force: true });

  const { args, spkiHash } = browserArgs(options);
  // Detached: the browser outlives the API call that started it, and the daemon must not
  // be holding a child process open for as long as a human keeps a window around.
  const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
  child.unref();

  const debug = options.debugPort === undefined ? null : await debugEndpoint(options.profileDir, () => child.exitCode);
  return { executable, profileDir: options.profileDir, args, pid: child.pid ?? null, spkiHash, debug };
}
