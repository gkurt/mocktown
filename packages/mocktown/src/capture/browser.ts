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
 */
import { spawn } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { platform } from 'node:os';

export interface BrowserLaunchOptions {
  proxyUrl: string;
  caCert: string;
  profileDir: string;
  url?: string;
  /** Explicit executable, for a browser we don't know about. */
  executable?: string;
}

export interface BrowserLaunch {
  executable: string;
  profileDir: string;
  args: string[];
  pid: number | null;
  /** The one public key this window will accept beyond the system store. */
  spkiHash: string;
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
      `--proxy-server=${options.proxyUrl}`,
      // Loopback is excluded by Chrome's default bypass list, which is what a developer
      // wants: the dev server stays direct while third-party scripts transit the front door.
      `--ignore-certificate-errors-spki-list=${spkiHash}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      ...(options.url ? [options.url] : []),
    ],
  };
}

export function launchBrowser(options: BrowserLaunchOptions): BrowserLaunch {
  const executable = findBrowser(options.executable);
  if (!executable) {
    throw new Error(
      'no Chromium-family browser found. Set MOCKTOWN_BROWSER to the executable, or capture the traffic another way — ' +
        '`mocktown record -- <cmd>` for server-side SDKs, `mocktown import --path <file.har>` for anything else.',
    );
  }

  mkdirSync(options.profileDir, { recursive: true });
  const { args, spkiHash } = browserArgs(options);
  // Detached: the browser outlives the API call that started it, and the daemon must not
  // be holding a child process open for as long as a human keeps a window around.
  const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
  child.unref();

  return { executable, profileDir: options.profileDir, args, pid: child.pid ?? null, spkiHash };
}
