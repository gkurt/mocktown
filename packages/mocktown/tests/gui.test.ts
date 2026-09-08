/**
 * The daemon's static half: the GUI shell and the panels (09-gui-plugins.md), tested over
 * real HTTP against a real daemon, because every claim worth making here is about a header
 * or a path that only exists at serve time.
 *
 * What matters:
 *   - the token is *injected*, so a build on disk carries no capability and the API still
 *     refuses anything without it;
 *   - a panel document is served with a CSP that has no external origin in it, because the
 *     feed it can read carries scrubbed traffic (10-security.md);
 *   - a panel URL is a path from an untrusted document, so `..` must not reach the repo.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';

const root = join(import.meta.dir, '.tmp-gui');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const workspace = join(root, 'app');
const shell = join(root, 'shell');

const { startDaemon, surfaceUnexpected } = await import('#src/daemon/server.ts');
const { ensureRegistered, resolveProject } = await import('#src/config/project.ts');
const { assetPath, injectBoot } = await import('#src/gui/serve.ts');
const { listPanels, panelFile } = await import('#src/gui/panels.ts');
const { shutdownAllRuntimes } = await import('#src/daemon/runtime.ts');

let daemon: Awaited<ReturnType<typeof startDaemon>>;
let origin: string;

const boot = (html: string) => JSON.parse(/name="mocktown-boot" content="([^"]*)"/.exec(html)![1]!.replaceAll('&quot;', '"'));

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(workspace, '.mocktown', 'panels'), { recursive: true });
  mkdirSync(shell, { recursive: true });
  writeFileSync(join(workspace, 'mocktown.json'), JSON.stringify({ project: 'gui-test' }));
  ensureRegistered(resolveProject({ cwd: workspace }));

  writeFileSync(
    join(shell, 'index.html'),
    '<!doctype html>\n<html>\n  <head>\n    <title>shell</title>\n  </head>\n  <body></body>\n</html>',
  );
  writeFileSync(join(shell, 'app.js'), 'export default 1;\n');

  // One good panel, one manifest pointing at nothing, one manifest that is not JSON.
  const panels = join(workspace, '.mocktown', 'panels');
  writeFileSync(join(panels, 'orders.json'), JSON.stringify({ name: 'Orders', service: 'api.example.com', entry: 'orders.html' }));
  writeFileSync(join(panels, 'orders.html'), '<html><head></head><body><h1>orders</h1></body></html>');
  writeFileSync(join(panels, 'missing.json'), JSON.stringify({ name: 'Missing', entry: 'nope.html' }));
  writeFileSync(join(panels, 'broken.json'), '{ not json');

  process.env.MOCKTOWN_GUI_DIST = shell;
  // The drift scheduler's only job is calling real third-party APIs on a timer.
  daemon = await startDaemon({ driftWatch: false });
  origin = `http://127.0.0.1:${daemon.port}`;
});

afterAll(async () => {
  await daemon?.stop();
  await shutdownAllRuntimes();
  delete process.env.MOCKTOWN_GUI_DIST;
  rmSync(root, { recursive: true, force: true });
});

test('the API refuses everything without the token, and documents itself without one', async () => {
  const refused = await fetch(`${origin}/api/v1/status?project=gui-test`);
  expect(refused.status).toBe(401);

  const documented = await fetch(`${origin}/api/v1/openapi.json`);
  expect(documented.status).toBe(200);

  const allowed = await fetch(`${origin}/api/v1/status?project=gui-test`, { headers: { authorization: `Bearer ${daemon.token}` } });
  expect(allowed.status).toBe(200);
});

test('an unexpected throw reaches the caller as its message, not as `Internal server error`', () => {
  // The daemon is local, token-gated and single-user, so the message is worth more than
  // the concealment oRPC defaults to. Without this a defective generated mock — the
  // routine case of this loop — surfaced as `error: Internal server error` and nothing else.
  expect(() => surfaceUnexpected(new Error('seed() threw for profile "default": bad binding'))).toThrow(
    'seed() threw for profile "default": bad binding',
  );

  // A deliberate failure keeps its own code, or `NOT_FOUND` would become a 500.
  const deliberate = new ORPCError('NOT_FOUND', { message: 'no issue "iss_1"' });
  expect(() => surfaceUnexpected(deliberate)).toThrow(deliberate);

  // A non-Error throw still has to say something.
  expect(() => surfaceUnexpected('a bare string')).toThrow('a bare string');
});

test('the shell is served with an injected token and a same-origin CSP', async () => {
  const response = await fetch(`${origin}/`);
  expect(response.status).toBe(200);
  const html = await response.text();

  expect(boot(html)).toEqual({ apiBase: `${origin}/api/v1`, token: daemon.token, project: 'main' });
  // Nothing in the build itself: the file on disk is worthless without the daemon.
  expect(Bun.file(join(shell, 'index.html')).text()).resolves.not.toContain('mocktown-boot');

  const csp = response.headers.get('content-security-policy')!;
  expect(csp).toContain("default-src 'self'");
  expect(csp).not.toContain('http://');
  expect(response.headers.get('cache-control')).toBe('no-store');
});

test('an unknown path is an SPA route, and a real asset is still a real asset', async () => {
  const route = await fetch(`${origin}/issues`);
  expect(route.status).toBe(200);
  expect(route.headers.get('content-type')).toContain('text/html');
  expect(boot(await route.text()).token).toBe(daemon.token);

  const asset = await fetch(`${origin}/app.js`);
  expect(asset.status).toBe(200);
  expect(await asset.text()).toBe('export default 1;\n');

  // A missing asset is a 404, not the shell: answering a script request with HTML turns a
  // bad deploy into a mystifying parse error.
  const missing = await fetch(`${origin}/assets/index-nope.js`);
  expect(missing.status).toBe(404);

  // And the path comes off the wire, so it cannot climb out of the build directory.
  expect(assetPath(shell, '/%2e%2e/%2e%2e/mocktown.json')).toBeNull();
  expect(assetPath(shell, '/index.html')).toBe(join(shell, 'index.html'));
});

test('panels are listed with their problems, not silently dropped', async () => {
  const response = await fetch(`${origin}/api/v1/panels?project=gui-test`, { headers: { authorization: `Bearer ${daemon.token}` } });
  const body = (await response.json()) as any;

  expect(body.panels.map((panel: any) => panel.name)).toEqual(['Orders', 'Provider state']);
  expect(body.panels[0]).toMatchObject({ source: 'workspace', url: '/panels/workspace/orders.html' });
  // The built-in worked example ships with the product and is listed alongside.
  expect(body.panels[1]).toMatchObject({ source: 'builtin', url: '/panels/builtin/provider-state.html' });

  expect(body.problems).toHaveLength(2);
  expect(body.problems.join(' ')).toContain('does not exist');
  expect(body.problems.join(' ')).toContain('broken.json');
});

test('a panel document gets the boot block and a CSP with no way off this origin', async () => {
  const response = await fetch(`${origin}/panels/workspace/orders.html?project=gui-test`);
  expect(response.status).toBe(200);

  const html = await response.text();
  expect(boot(html).project).toBe('gui-test');
  expect(html).toContain('<h1>orders</h1>');

  const csp = response.headers.get('content-security-policy')!;
  expect(csp).toContain("default-src 'none'");
  expect(csp).toContain("connect-src 'self'");
  // No external origin of any kind: an image URL exfiltrates as well as a fetch does.
  expect(csp).not.toMatch(/https?:/);
});

test('a panel path cannot climb out of the panel directory', async () => {
  const climbing = await fetch(`${origin}/panels/workspace/${encodeURIComponent('../../mocktown.json')}`);
  expect(climbing.status).toBe(404);
  expect(panelFile(workspace, 'workspace', '../../mocktown.json')).toBeNull();
  expect(panelFile(workspace, 'nonsense', 'orders.html')).toBeNull();

  const listing = listPanels(workspace);
  expect(listing.panels.every((panel) => panel.file.includes('.mocktown/panels') || panel.file.includes('src/gui/panels'))).toBe(true);
});

test('the boot block survives a document with no head at all', () => {
  const injected = injectBoot('<body>panel</body>', { apiBase: '/api/v1', token: 't', project: 'p' });
  expect(injected.startsWith('<meta name="mocktown-boot"')).toBe(true);
  expect(injected).toContain('<body>panel</body>');
});

test('the feed is reachable over HTTP as a plain procedure', async () => {
  const response = await fetch(`${origin}/api/v1/feed?project=gui-test&since=0&waitMs=0`, {
    headers: { authorization: `Bearer ${daemon.token}` },
  });
  const body = (await response.json()) as any;
  expect(body).toMatchObject({ project: 'gui-test', cursor: 0, events: [], gap: false });
});

/**
 * `env write` used to append its section to AGENTS.md unconditionally. That file is
 * committed, hand-written and shared, so every regeneration of a gitignored env file also
 * produced an unrequested diff on a tracked one — and the only way to stop it was to not
 * run the command.
 */
test('env write leaves AGENTS.md alone until the project says otherwise', async () => {
  const call = (path: string, init?: RequestInit) =>
    fetch(`${origin}/api/v1${path}`, {
      ...init,
      headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json', ...init?.headers },
    });

  const agents = join(workspace, 'AGENTS.md');
  writeFileSync(agents, '# House rules\n\nWritten by a person.\n');

  const off = await call('/env/write?project=gui-test', { method: 'POST', body: JSON.stringify({ project: 'gui-test' }) });
  expect(off.status).toBe(200);
  const quiet = (await off.json()) as { written: string[]; notes: string[] };
  expect(quiet.written).toEqual([join(workspace, '.env.mocktown')]);
  // Doing less has to be said out loud, or the caller reads a silence as a failure.
  expect(quiet.notes.join(' ')).toContain('env.agentsFile');
  expect(readFileSync(agents, 'utf8')).toBe('# House rules\n\nWritten by a person.\n');

  const set = await call('/config?project=gui-test', {
    method: 'PUT',
    body: JSON.stringify({ project: 'gui-test', key: 'env.agentsFile', value: 'true' }),
  });
  expect(set.status).toBe(200);
  const applied = (await set.json()) as { settings: { key: string; value: string }[] };
  expect(applied.settings.find((s) => s.key === 'env.agentsFile')!.value).toBe('true');

  const on = await call('/env/write?project=gui-test', { method: 'POST', body: JSON.stringify({ project: 'gui-test' }) });
  const loud = (await on.json()) as { written: string[]; notes: string[] };
  expect(loud.written).toContain(agents);
  expect(loud.notes).toEqual([]);

  const written = readFileSync(agents, 'utf8');
  expect(written).toContain('<!-- BEGIN mocktown -->');
  // Opting in is permission to add a section, never to take over the file.
  expect(written).toContain('Written by a person.');
});

test('a setting the schema does not have is refused, not written', async () => {
  const response = await fetch(`${origin}/api/v1/config?project=gui-test`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${daemon.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'gui-test', key: 'env.agentsFile', value: 'perhaps' }),
  });
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).toContain('must be JSON');
});
