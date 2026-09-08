/**
 * Serving the GUI shell and the panels — the daemon's static half (09-gui-plugins.md).
 *
 * Two things here are load-bearing rather than incidental:
 *
 * - **The token is injected, never bundled.** The shell is a static build with no secret in
 *   it; the daemon inserts a `<meta name="mocktown-boot">` element carrying the API base and
 *   token as it serves the HTML, so a shell build sitting on disk is worthless on its own.
 *   A `<script type="application/json">` block would have read better, but Chrome applies
 *   `script-src` to inline script elements whatever their type — the data is still readable,
 *   and the page still logs a refusal on every load. A meta element has no such argument
 *   with the CSP.
 * - **A panel document may not reach the network.** The request feed carries scrubbed
 *   traffic (10-security.md), so a panel gets `default-src 'none'` with `connect-src 'self'`
 *   — it can talk to this daemon and nowhere else. `img-src`/`font-src` stay same-origin
 *   too, because an image URL is an exfiltration channel like any other.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

export interface BootData {
  apiBase: string;
  token: string;
  project: string;
  /** So the shell can print `~/Work/repo` for a path it has no other way to recognise. */
  home: string;
}

/**
 * `'unsafe-inline'` for styles only: React writes style attributes, and CSP has no way to
 * allow those without it. Scripts and everything else stay same-origin.
 */
export const SHELL_CSP =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; frame-src 'self'; object-src 'none'; base-uri 'none'";

/** A panel is one inline-scripted file by design, and it is not allowed off this origin. */
export const PANEL_CSP =
  "default-src 'none'; connect-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'";

/**
 * The built shell, or null when it has not been built.
 *
 * Three places are tried, in order, and every one of them can legitimately be the answer:
 * an explicit override for a Vite dev build, package resolution for the day the shell is a
 * real dependency, and the sibling workspace directory for this repo — where `mocktown`
 * deliberately does *not* depend on the GUI, because the daemon must run and be useful with
 * no shell built at all.
 */
export function guiDist(): string | null {
  const built = (dist: string) => (existsSync(join(dist, 'index.html')) ? dist : null);
  if (process.env.MOCKTOWN_GUI_DIST) return built(process.env.MOCKTOWN_GUI_DIST);
  try {
    return built(join(dirname(Bun.resolveSync('@mocktown/gui/package.json', import.meta.dir)), 'dist'));
  } catch {
    return built(join(import.meta.dir, '..', '..', '..', 'gui', 'dist'));
  }
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const bootBlock = (boot: BootData) => `<meta name="mocktown-boot" content="${escapeAttribute(JSON.stringify(boot))}" />`;

/** Injected into `<head>`, or prepended when a panel author wrote no head at all. */
export function injectBoot(html: string, boot: BootData): string {
  const block = bootBlock(boot);
  const head = /<head[^>]*>/i.exec(html);
  if (!head) return `${block}\n${html}`;
  const at = head.index + head[0].length;
  return `${html.slice(0, at)}\n    ${block}${html.slice(at)}`;
}

export function htmlResponse(file: string, boot: BootData, csp: string): Response {
  return new Response(injectBoot(readFileSync(file, 'utf8'), boot), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      // The shell is regenerated per request with a token in it; caching it would hand a
      // stale token to the next daemon.
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * The file behind a request for the shell, or null. Two rules and both matter:
 *
 * - **Containment.** The path comes off the wire, so a resolved path outside the build
 *   directory is refused rather than read, whatever the URL parser did with it.
 * - **The SPA fallback applies to routes, not to assets.** `/issues` is a route and gets
 *   `index.html`; a missing `/assets/index-abc.js` is a 404, because answering a script
 *   request with HTML turns a bad deploy into a mystifying parse error.
 */
export function assetPath(staticDir: string, pathname: string): string | null {
  const requested = pathname === '/' ? '/index.html' : pathname;
  const target = resolve(join(staticDir, requested));
  const base = resolve(staticDir);
  if (target !== base && !target.startsWith(base + sep)) return null;

  if (existsSync(target) && statSync(target).isFile()) return target;
  const looksLikeAsset = /\.[a-z0-9]+$/i.test(requested);
  return looksLikeAsset ? null : join(staticDir, 'index.html');
}
