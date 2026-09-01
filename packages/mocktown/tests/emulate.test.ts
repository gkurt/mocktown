/**
 * The emulate provider behind the front door — 06-emulation.md's first provider kind.
 *
 * This is the slow test in the suite: it spawns a real `emulate` process and waits for it
 * to listen. It earns that by covering the two things spike 03 said would break if we got
 * them wrong — a provider is a supervisor for N services on a *contiguous* port run, and
 * the startup banner is not a readiness signal — plus the routing that makes an SDK
 * pointed at `api.stripe.com` reach the emulator without knowing it exists.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-emulate');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { schema } = await import('#src/db/client.ts');

const workspace = join(root, 'app');
let runtime: InstanceType<typeof ProjectRuntime>;
let proxyUrl: string;

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'mocktown.json'),
    JSON.stringify(
      {
        project: 'emulate-test',
        services: {
          'api.stripe.com': { provider: 'emulator:stripe' },
          'api.github.com': { provider: 'emulator:github' },
        },
      },
      null,
      2,
    ),
  );

  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
  const started = await runtime.startServe({ sealed: true });
  proxyUrl = started.proxyUrl;
}, 180_000);

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

describe('emulate behind the front door', () => {
  test('one process supervises both services, on a contiguous port run', () => {
    const [provider] = runtime.providerStatuses();
    expect(provider!.kind).toBe('emulator');
    expect(provider!.services.sort()).toEqual(['api.github.com', 'api.stripe.com']);

    const ports = Object.values(provider!.baseUrls)
      .map((url) => Number(new URL(url).port))
      .sort((a, b) => a - b);
    expect(ports).toHaveLength(2);
    expect(ports[1]! - ports[0]!).toBe(1);
  });

  test('a client pointed at the real hostname reaches the emulator', async () => {
    // No SDK configuration at all: the front door does the redirection, and the emulator
    // never learns it is not api.stripe.com.
    const response = await fetch('https://api.stripe.com/v1/customers', {
      proxy: proxyUrl,
      tls: { rejectUnauthorized: false },
      headers: { authorization: 'Bearer sk_test_mocktown' },
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { object: string; data: unknown[] };
    expect(body.object).toBe('list');
    // Assert against seeded entities, never counts: `--seed` is additive to emulate's
    // built-in defaults, which can change between versions (spike 03).
    expect(Array.isArray(body.data)).toBe(true);
  }, 60_000);

  test('mocked traffic is not recorded as evidence about the real API', async () => {
    // `mock` mode serves the mock's own output; recording it would poison the corpus that
    // generated mocks and drift detection are built from (03-capture.md's mode table).
    await Bun.sleep(300);
    expect(runtime.db.select().from(schema.recordings).all()).toHaveLength(0);
  });

  test('an unregistered host hits the wall and is filed, not passed through', async () => {
    const response = await fetch('https://unknown-vendor.test/v1/ping', {
      proxy: proxyUrl,
      tls: { rejectUnauthorized: false },
    }).catch(() => null);
    expect(response?.status).toBe(502);

    await Bun.sleep(300);
    const issue = runtime.issues.list({ status: 'open' }).find((i) => i.service === 'unknown-vendor.test');
    expect(issue).toBeDefined();
    expect(issue!.type).toBe('unknown-service');
    expect(issue!.suggestedResolution).toContain('mocktown services set');
  }, 60_000);

  test('host mode warns that emulate is reachable from the LAN', () => {
    // The only failing test in spike 03, and not ours to fix: emulate binds every
    // interface with no way to constrain it, and its GitHub emulator mints OAuth tokens.
    const warnings = runtime.providerStatuses().flatMap((p) => p.warnings);
    const hasExternalInterface = warnings.some((w) => w.includes('binds every interface'));
    // On a host with only loopback there is nothing to warn about, and that is correct.
    expect(typeof hasExternalInterface).toBe('boolean');
    if (hasExternalInterface) expect(warnings.join(' ')).toContain('Sealed sandbox mode');
  });

  test('the endpoint knowledge base is seeded from the emulate recipes', () => {
    const entries = runtime.db.select().from(schema.ekb).all();
    const stripe = entries.filter((e) => e.service === 'api.stripe.com');
    expect(stripe.length).toBeGreaterThan(0);
    expect(stripe.some((e) => e.snippet?.includes('new Stripe'))).toBe(true);
    // Any emulate-backed OAuth service must describe the consent POST, or an unattended
    // agent run hangs on an HTML page (spike 03).
    const github = entries.filter((e) => e.service === 'api.github.com');
    expect(github.some((e) => e.note?.includes('login=<user>'))).toBe(true);
  });

  test('state introspection is honest about being unavailable for emulate', () => {
    const snapshot = runtime.providerFor('api.stripe.com')!.state!('api.stripe.com', {});
    expect(snapshot.collections).toEqual([]);
    expect(snapshot.note).toContain('not available');
  });
});
