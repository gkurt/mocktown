/**
 * The portless seam (05-redirection.md's footnote). portless itself is not a test
 * dependency — it binds 443 with sudo and installs a CA in the system trust store, which
 * is not something a test suite gets to do to a machine.
 *
 * So the tests stand up the shape of portless instead: a stub binary that implements the
 * one verb we use (`portless alias`) and a small reverse proxy that routes by Host header.
 * That is enough to exercise everything that is ours — name derivation, the empirical
 * probe, alias registration, release, and every failure path — against a real subprocess
 * and a real request rather than a mock of our own code.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-portless');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { captureEnv } = await import('#src/capture/launch.ts');
const { portlessBinary, portlessCaCerts, releasePortless, stableName, stableUrl, syncPortless } = await import('#src/redirect/portless.ts');

const stateDir = join(root, 'state');
const binDir = join(root, 'bin');
const routesFile = join(stateDir, 'routes.json');

/**
 * The stub's whole surface: `alias <name> <port> --force` and `alias --remove <name>`.
 *
 * It appends its own TLDs to the name and records one hostname per TLD, because that is
 * what portless does with a repeated `--tld` — and mocktown reads those suffixes back to
 * learn which TLDs the proxy is serving.
 */
const STUB = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [command, ...rest] = process.argv.slice(2);
const dir = process.env.PORTLESS_STATE_DIR;
const file = \`\${dir}/routes.json\`;
const tlds = (process.env.PORTLESS_STUB_TLD || 'localhost').split(',');
const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : []);

if (command === 'alias') {
  const removing = rest[0] === '--remove';
  const name = removing ? rest[1] : rest[0];
  const hostnames = tlds.map((tld) => \`\${name}.\${tld}\`);
  const kept = read().filter((route) => !hostnames.includes(route.hostname));
  if (!removing) for (const hostname of hostnames) kept.push({ hostname, port: Number(rest[1]), pid: 0 });
  writeFileSync(file, JSON.stringify(kept));
} else if (command === 'proxy' && rest[0] === 'start') {
  // Records the invocation so a test can assert what mocktown asked for, then backgrounds a
  // real router — \`portless proxy start\` returns before the proxy is up, and mocktown has
  // to wait for it rather than trust the exit code.
  const port = Number(rest[rest.indexOf('-p') + 1]);
  writeFileSync(\`\${dir}/started.json\`, JSON.stringify(rest));
  const child = Bun.spawn([process.execPath, import.meta.path, '__serve', String(port)], {
    stdio: ['ignore', 'ignore', 'ignore'],
    env: process.env,
  });
  child.unref();
  writeFileSync(\`\${dir}/proxy.port\`, String(port));
  writeFileSync(\`\${dir}/proxy.pid\`, String(child.pid));
} else if (command === '__serve') {
  await Bun.sleep(150);
  Bun.serve({
    port: Number(rest[0]),
    hostname: '127.0.0.1',
    fetch: (request) => {
      const target = read().find((route) => route.hostname === new URL(request.url).hostname);
      if (!target) return new Response('no route', { status: 404 });
      return fetch(\`http://127.0.0.1:\${target.port}\${new URL(request.url).pathname}\`);
    },
  });
  await new Promise(() => {});
} else {
  console.error('stub portless implements only \`alias\` and \`proxy start\`');
  process.exit(2);
}
`;

const FAILING_STUB = `#!/usr/bin/env bun
console.error('proxy is not running; run \`portless proxy start\`');
process.exit(1);
`;

const routes = (): Record<string, number> =>
  Object.fromEntries(
    (JSON.parse(readFileSync(routesFile, 'utf8')) as { hostname: string; port: number }[]).map((r) => [r.hostname, r.port]),
  );

let proxy: Bun.Server<never>;
let provider: Bun.Server<never>;
let proxyPort = 0;
let providerPort = 0;
let providerHits = 0;
/** How long a freshly written route stays invisible, standing in for the proxy's reload. */
let routeDelayMs = 0;
const firstSeen = new Map<string, number>();

function installStub(body: string): string {
  const path = join(binDir, 'node_modules', '.bin', 'portless');
  mkdirSync(join(binDir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(routesFile, '[]');
  installStub(STUB);

  provider = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: () => {
      providerHits++;
      return new Response('provider');
    },
  });

  providerPort = provider.port!;

  // Routes by Host header, exactly as portless's proxy does.
  proxy = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch: async (request) => {
      const host = new URL(request.url).hostname;
      const port = routes()[host];
      if (!port) return new Response('no route', { status: 502 });
      const since = firstSeen.get(host) ?? Date.now();
      firstSeen.set(host, since);
      // Real portless serves its own 404 page for a name it has not reloaded yet.
      if (Date.now() - since < routeDelayMs) return new Response('not found', { status: 404 });
      return fetch(`http://127.0.0.1:${port}${new URL(request.url).pathname}`);
    },
  });
  proxyPort = proxy.port!;
});

afterAll(() => {
  proxy?.stop(true);
  provider?.stop(true);
  rmSync(root, { recursive: true, force: true });
});

const settings = () => ({ tlds: ['localhost'], port: proxyPort, tls: false, stateDir });

const input = (overrides: Partial<Parameters<typeof syncPortless>[0]> = {}) => ({
  project: 'names',
  workspace: binDir,
  enabled: true,
  settings: settings(),
  baseUrls: new Map([['api.stripe.com', `http://127.0.0.1:${providerPort}`]]),
  projectCaPath: join(root, 'missing-ca.pem'),
  ...overrides,
});

test('a service name becomes one DNS label under the project', () => {
  expect(stableName('checkout', 'api.stripe.com')).toBe('api-stripe-com.checkout');
  expect(stableName('My App', 'S3.us-east-1.amazonaws.com')).toBe('s3-us-east-1-amazonaws-com.my-app');
  // The default ports are the ones a URL is not supposed to carry.
  expect(stableUrl('a.b', { tlds: ['localhost'], port: 443, tls: true })).toBe('https://a.b.localhost');
  expect(stableUrl('a.b', { tlds: ['test'], port: 8443, tls: true })).toBe('https://a.b.test:8443');
  expect(stableUrl('a.b', { tlds: ['localhost'], port: 80, tls: false })).toBe('http://a.b.localhost');
  // A second TLD is a fallback the proxy also serves, not a second address to hand out.
  expect(stableUrl('a.b', { tlds: ['mocktown', 'mocktown.localhost'], port: 443, tls: true })).toBe('https://a.b.mocktown');
});

test('off is off, and says which key turns it on', async () => {
  const status = await syncPortless(input({ enabled: false }));
  expect(status.available).toBe(false);
  expect(status.names).toEqual([]);
  expect(status.reason).toContain('mocktown.json');
});

test('a missing binary is reported as installable, not as broken', async () => {
  // The PATH fallback reads the developer's own machine, so on one that actually has
  // portless this would run the real binary against the stub's state directory and rewrite
  // `routes.json` in portless's own format, breaking every test after it.
  const path = process.env.PATH;
  process.env.PATH = join(root, 'no-such-bin');
  try {
    const status = await syncPortless(input({ workspace: join(root, 'no-such-workspace') }));
    expect(status.available).toBe(false);
    expect(status.reason).toContain('not on PATH');
  } finally {
    process.env.PATH = path;
  }
  expect(portlessBinary(binDir)).toBe(join(binDir, 'node_modules', '.bin', 'portless'));
});

test("portless's own failure text reaches the caller", async () => {
  installStub(FAILING_STUB);
  const status = await syncPortless(input());
  installStub(STUB);
  expect(status.available).toBe(false);
  expect(status.reason).toContain('portless proxy start');
  expect(routes()).toEqual({});
});

test('a proven name serves the provider, and the probe never touched it', async () => {
  providerHits = 0;
  const status = await syncPortless(input());

  expect(status.reason).toContain('proven');
  expect(status.available).toBe(true);
  expect(status.names).toEqual([
    { service: 'api.stripe.com', name: 'api-stripe-com.names', url: `http://api-stripe-com.names.localhost:${proxyPort}` },
  ]);
  // Verification pointed at a listener of ours, not at the mock host: a stray request to a
  // provider would have filed an `unmatched-request` issue.
  expect(providerHits).toBe(0);
  // The probe's alias is cleaned up; only the service's own name is left registered.
  expect(Object.keys(routes())).toEqual(['api-stripe-com.names.localhost']);

  const response = await fetch(status.names[0]!.url);
  expect(await response.text()).toBe('provider');
  expect(providerHits).toBe(1);

  await releasePortless(status, settings(), binDir);
  expect(routes()).toEqual({});
});

test('a route the proxy has not reloaded yet is waited for, not called a stranger', async () => {
  // `portless alias` exits once the route is written, a moment before the running proxy
  // picks it up. Probing once always lost that race, so every working setup failed.
  routeDelayMs = 600;
  firstSeen.clear();
  try {
    const status = await syncPortless(input());
    expect(status.reason).toContain('proven');
    expect(status.available).toBe(true);
    await releasePortless(status, settings(), binDir);
  } finally {
    routeDelayMs = 0;
  }
});

test('the running proxy decides the tld and port, not the config that has drifted from it', async () => {
  // Someone restarts the proxy with a different `--tld`, or on a different port, and never
  // edits mocktown.json. Declaring these by hand means a name mocktown prints that nothing
  // serves; reading them back means the config is a preference, not a duty.
  process.env.PORTLESS_STUB_TLD = 'mocktown.localhost';
  writeFileSync(join(stateDir, 'proxy.port'), String(proxyPort));
  try {
    const status = await syncPortless(input({ settings: { ...settings(), tlds: ['stale'], port: 9 } }));
    expect(status.available).toBe(true);
    expect(status.resolved).toMatchObject({ port: proxyPort, tls: false });
    // The configured name was asked and stayed silent, so it is reported as unusable rather
    // than handed out — an `.env.mocktown` full of addresses that do not resolve is worse
    // than one that admits the preferred spelling is unavailable.
    expect(status.resolved?.tlds).toEqual(['mocktown.localhost']);
    expect(status.unusableTlds).toEqual(['stale']);
    // And says which of the two fixes applies: this proxy never served the name, so the fix
    // is restarting it, not syncing a hosts file that was never the problem.
    expect(status.reason).toContain('the running proxy does not serve .stale');
    // Additive: the TLD this proxy is already serving stays in the command, because it is
    // one process for the machine and narrowing it would unserve someone else's names. And
    // the port and scheme come from the proxy that is running, not from the config that has
    // drifted — a command that moved a live proxy off its port would be the worse bug.
    expect(status.reason).toContain(
      `portless proxy stop && portless proxy start -p ${proxyPort} --no-tls --tld stale --tld mocktown.localhost`,
    );
    expect(status.names[0]!.url).toBe(`http://api-stripe-com.names.mocktown.localhost:${proxyPort}`);
    expect(Object.keys(routes())).toEqual(['api-stripe-com.names.mocktown.localhost']);
    await releasePortless(status, settings(), binDir);
    expect(routes()).toEqual({});
  } finally {
    delete process.env.PORTLESS_STUB_TLD;
    rmSync(join(stateDir, 'proxy.port'), { force: true });
  }
});

test('a preferred TLD that does not resolve falls back to the one that does', async () => {
  // The reason `.mocktown.localhost` is in the default list at all. `.mocktown` is served by
  // the proxy — it is in the routes file — but resolving it needs the `/etc/hosts` entry
  // portless writes, and that is the step that fails in a devcontainer, on a locked-down
  // machine, or when someone declines the prompt. Serving a name is not the same as being
  // able to reach it, so the list is settled by asking rather than by what the proxy claims.
  //
  // Nothing arranges a hosts entry here, so `.mocktown` genuinely does not resolve, which is
  // the condition itself rather than a simulation of it.
  process.env.PORTLESS_STUB_TLD = 'mocktown,mocktown.localhost';
  writeFileSync(join(stateDir, 'proxy.port'), String(proxyPort));
  try {
    const status = await syncPortless(input({ settings: { ...settings(), tlds: ['mocktown', 'mocktown.localhost'] } }));
    expect(status.available).toBe(true);
    expect(status.tlds).toEqual(['mocktown.localhost']);
    expect(status.unusableTlds).toEqual(['mocktown']);
    // The other fix: the proxy is serving it, so the missing piece is the hosts entry.
    expect(status.reason).toContain('.mocktown is served but did not resolve');
    expect(status.reason).toContain('portless hosts sync');
    // The URL that reaches `.env.mocktown` is the one that answered, with no edit by anyone.
    expect(status.names[0]!.url).toBe(`http://api-stripe-com.names.mocktown.localhost:${proxyPort}`);
    // The alias still exists under both, because the proxy serves both — what changed is
    // which spelling gets handed out, not which the proxy would deliver.
    expect(Object.keys(routes()).sort()).toEqual(['api-stripe-com.names.mocktown', 'api-stripe-com.names.mocktown.localhost']);
    await releasePortless(status, settings(), binDir);
    expect(routes()).toEqual({});
  } finally {
    delete process.env.PORTLESS_STUB_TLD;
    rmSync(join(stateDir, 'proxy.port'), { force: true });
  }
});

test('an unprivileged proxy is started for you; a privileged one is only ever reported', async () => {
  // The whole point of the split: no sudo, no prompt, so mocktown may as well do it. Port 80
  // or 443 is a root daemon on someone's machine and stays their call.
  const privileged = await syncPortless(input({ settings: { ...settings(), port: 443 } }));
  expect(privileged.available).toBe(false);
  expect(privileged.reason).toContain('binding it needs root');
  expect(privileged.reason).toContain('portless proxy start');
  expect(existsSync(join(stateDir, 'started.json'))).toBe(false);

  // Two TLDs, because that is the shipped default's shape: a preferred name and a fallback
  // the proxy serves alongside it. Both spellings here end in `.localhost` so they resolve
  // to loopback on their own — the real default's `.mocktown` needs the `/etc/hosts` entry
  // portless writes, which is not something a test suite gets to do to a machine.
  const tlds = ['mocktown.localhost', 'fallback.localhost'];
  process.env.PORTLESS_STUB_TLD = tlds.join(',');
  const port = proxyPort + 1;
  const status = await syncPortless(input({ settings: { ...settings(), tlds, port, tls: false } }));
  try {
    expect(JSON.parse(readFileSync(join(stateDir, 'started.json'), 'utf8'))).toEqual([
      'start',
      '-p',
      String(port),
      '--tld',
      'mocktown.localhost',
      '--tld',
      'fallback.localhost',
      '--no-tls',
    ]);
    expect(status.available).toBe(true);
    expect(status.resolved?.port).toBe(port);
    // Both suffixes come back from the routes file, so the fallback is in the alias table
    // and in NO_PROXY — and the URL handed out is the head of the list, not both.
    expect(status.tlds).toEqual(tlds);
    expect(status.names[0]!.url).toBe(`http://api-stripe-com.names.mocktown.localhost:${port}`);
    expect(Object.keys(routes()).sort()).toEqual(['api-stripe-com.names.fallback.localhost', 'api-stripe-com.names.mocktown.localhost']);
    await releasePortless(status, { ...settings(), tlds }, binDir);
    expect(routes()).toEqual({});
  } finally {
    delete process.env.PORTLESS_STUB_TLD;
    const pid = Number(readFileSync(join(stateDir, 'proxy.pid'), 'utf8'));
    try {
      process.kill(pid);
    } catch {}
    rmSync(join(stateDir, 'started.json'), { force: true });
    rmSync(join(stateDir, 'proxy.port'), { force: true });
    rmSync(join(stateDir, 'proxy.pid'), { force: true });
  }
});

test('the GUI gets a name under a TLD we own, and never squats one we borrowed', async () => {
  // `ui` is a label anyone might want and the proxy is one process for the whole machine, so
  // `alias ui --force` under someone else's TLD would take `ui.localhost` from whatever had
  // it — for a dashboard that is not even project-scoped. Under `.mocktown` the TLD is ours.
  const guiPort = providerPort;

  // Borrowed: the config asked for `.borrowed-test`, the proxy is serving `.localhost`, and
  // the services fall back to it — but a generic `ui` under a TLD nobody here owns does not
  // get claimed just because the fallback worked.
  const borrowed = await syncPortless(input({ guiPort, settings: { ...settings(), tlds: ['borrowed-test'] } }));
  expect(borrowed.available).toBe(true);
  expect(borrowed.tlds).toEqual(['localhost']);
  expect(borrowed.gui).toBeNull();
  expect(Object.keys(routes())).not.toContain('ui.localhost');
  await releasePortless(borrowed, settings(), binDir);

  // Occupied: something else already answers on a `ui.*` route at a different port. The
  // proxy is shared, `alias --force` would take it, and portless applies every TLD it
  // serves — so this, not the TLD, is the check that keeps mocktown out of someone's way.
  const squatted = JSON.parse(readFileSync(routesFile, 'utf8'));
  squatted.push({ hostname: 'ui.localhost', port: guiPort + 1, pid: 0 });
  writeFileSync(routesFile, JSON.stringify(squatted));
  const occupied = await syncPortless(input({ guiPort }));
  expect(occupied.gui).toBeNull();
  expect(occupied.reason).toContain('already points at');
  expect(routes()['ui.localhost']).toBe(guiPort + 1);
  await releasePortless(occupied, settings(), binDir);
  writeFileSync(routesFile, '[]');

  // Ours: the proven TLD is one the project configured, so the name is ours to mint.
  process.env.PORTLESS_STUB_TLD = 'mocktown.localhost';
  writeFileSync(join(stateDir, 'proxy.port'), String(proxyPort));
  try {
    const owned = await syncPortless(input({ guiPort, settings: { ...settings(), tlds: ['mocktown.localhost'] } }));
    expect(owned.gui).toEqual({ name: 'ui', url: `http://ui.mocktown.localhost:${proxyPort}` });
    expect(Object.keys(routes())).toContain('ui.mocktown.localhost');

    // And it reaches the daemon rather than a mock — the whole point of a name for the GUI.
    providerHits = 0;
    const response = await fetch(owned.gui!.url);
    expect(await response.text()).toBe('provider');
    expect(providerHits).toBe(1);

    // Released with the services: a name pointing at a port nothing answers on is the
    // failure this cleanup exists to prevent, and the daemon is on loopback regardless.
    await releasePortless(owned, settings(), binDir);
    expect(routes()).toEqual({});
  } finally {
    delete process.env.PORTLESS_STUB_TLD;
    rmSync(join(stateDir, 'proxy.port'), { force: true });
  }
});

test('a base URL with no port cannot be aliased, and says so per service', async () => {
  const status = await syncPortless(input({ baseUrls: new Map([['api.stripe.com', 'https://api.stripe.com']]) }));
  expect(status.available).toBe(false);
  expect(status.reason).toContain('has no port to alias');
});

test('a certificate hunt takes certificates and nothing else', () => {
  const dir = join(root, 'certs');
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'ca.pem'), '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n');
  writeFileSync(join(dir, 'nested', 'leaf.crt'), '-----BEGIN CERTIFICATE-----\ny\n-----END CERTIFICATE-----\n');
  writeFileSync(join(dir, 'proxy.key.pem'), '-----BEGIN PRIVATE KEY-----\nz\n-----END PRIVATE KEY-----\n');
  writeFileSync(join(dir, 'notes.txt'), 'not a certificate');

  expect(portlessCaCerts({ tlds: ['localhost'], port: 443, tls: true, stateDir: dir })).toEqual([
    join(dir, 'ca.pem'),
    join(dir, 'nested', 'leaf.crt'),
  ]);
});

test('loopback is never proxied', () => {
  // The default is the plan for a project that has declared nothing, so the launch wrapper
  // and `.env.mocktown` agree even when no caller passes a list.
  const env = captureEnv({ proxyUrl: 'http://127.0.0.1:4400', caCertPath: '/tmp/ca.pem' });
  expect(env.NO_PROXY!.split(',')).toEqual(['127.0.0.1', '::1', 'localhost']);
  expect(env.no_proxy).toBe(env.NO_PROXY);

  // A caller that has a plan passes the whole list, not an addition to a hidden constant.
  const withTld = captureEnv({ proxyUrl: 'http://127.0.0.1:4400', caCertPath: '/tmp/ca.pem', noProxy: ['127.0.0.1', '::1', '.localhost'] });
  expect(withTld.NO_PROXY!.endsWith(',.localhost')).toBe(true);
});
