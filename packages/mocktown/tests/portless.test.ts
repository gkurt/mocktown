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
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-portless');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { captureEnv } = await import('#src/capture/launch.ts');
const { portlessBinary, portlessCaCerts, releasePortless, stableName, stableUrl, syncPortless } = await import('#src/redirect/portless.ts');

const stateDir = join(root, 'state');
const binDir = join(root, 'bin');
const routesFile = join(stateDir, 'routes.json');

/** The stub's whole surface: `alias <name> <port> --force` and `alias --remove <name>`. */
const STUB = `#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
const [command, ...rest] = process.argv.slice(2);
const file = \`\${process.env.PORTLESS_STATE_DIR}/routes.json\`;
if (command !== 'alias') {
  console.error('stub portless implements only \`alias\`');
  process.exit(2);
}
const routes = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
if (rest[0] === '--remove') delete routes[rest[1]];
else routes[rest[0]] = Number(rest[1]);
writeFileSync(file, JSON.stringify(routes));
`;

const FAILING_STUB = `#!/usr/bin/env bun
console.error('proxy is not running; run \`portless proxy start\`');
process.exit(1);
`;

const routes = (): Record<string, number> => JSON.parse(readFileSync(routesFile, 'utf8'));

let proxy: Bun.Server<never>;
let provider: Bun.Server<never>;
let proxyPort = 0;
let providerPort = 0;
let providerHits = 0;

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
  writeFileSync(routesFile, '{}');
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
      const name = host.replace(/\.localhost$/, '');
      const port = routes()[name];
      if (!port) return new Response('no route', { status: 502 });
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

const settings = () => ({ tld: 'localhost', port: proxyPort, tls: false, stateDir });

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
  expect(stableUrl('a.b', { tld: 'localhost', port: 443, tls: true })).toBe('https://a.b.localhost');
  expect(stableUrl('a.b', { tld: 'test', port: 8443, tls: true })).toBe('https://a.b.test:8443');
  expect(stableUrl('a.b', { tld: 'localhost', port: 80, tls: false })).toBe('http://a.b.localhost');
});

test('off is off, and says which key turns it on', async () => {
  const status = await syncPortless(input({ enabled: false }));
  expect(status.available).toBe(false);
  expect(status.names).toEqual([]);
  expect(status.reason).toContain('mocktown.json');
});

test('a missing binary is reported as installable, not as broken', async () => {
  const status = await syncPortless(input({ workspace: join(root, 'no-such-workspace') }));
  expect(status.available).toBe(false);
  expect(status.reason).toContain('not on PATH');
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
  expect(Object.keys(routes())).toEqual(['api-stripe-com.names']);

  const response = await fetch(status.names[0]!.url);
  expect(await response.text()).toBe('provider');
  expect(providerHits).toBe(1);

  await releasePortless(status, settings(), binDir);
  expect(routes()).toEqual({});
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

  expect(portlessCaCerts({ tld: 'localhost', port: 443, tls: true, stateDir: dir })).toEqual([
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
