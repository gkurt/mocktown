/**
 * The whole loop, end to end, against a live upstream and a live front door:
 *
 *   record real traffic -> browse the scrubbed corpus   (phase 1's exit criterion)
 *   unseen request -> issue -> mock patched -> verified replay   (phase 2's)
 *
 * `billing.localhost` resolves to loopback on every platform we support, so the upstream
 * is a real HTTP server reached over a real hostname through a real MITM proxy — the same
 * path a developer's app takes, with no internet dependency.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-loop');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { schema } = await import('#src/db/client.ts');
const { exportCorpus } = await import('#src/mocks/corpus.ts');
const { scaffoldMock } = await import('#src/mocks/scaffold.ts');
const { verifyRecordings } = await import('#src/mocks/verify.ts');
const { recordingsForService } = await import('#src/mocks/corpus.ts');

const workspace = join(root, 'app');
const UPSTREAM_PORT = 5599;
const SERVICE = 'billing.localhost';

let upstream: Server;
let runtime: InstanceType<typeof ProjectRuntime>;
let proxyUrl: string;

/** A small stateful upstream: create an invoice, read it back, list them. */
function startUpstream(): Promise<Server> {
  const invoices = new Map<string, unknown>();
  let next = 1;

  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const url = new URL(request.url!, 'http://localhost');
      const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        response.writeHead(status, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(payload));
      };

      if (request.method === 'POST' && url.pathname === '/v1/invoices') {
        const id = `inv_${String(next++).padStart(6, '0')}`;
        const invoice = { id, amount: JSON.parse(body || '{}').amount ?? 0, status: 'open', customer: 'ada@example.com' };
        invoices.set(id, invoice);
        // A real Set-Cookie and a real-looking credential, so the scrubber has work to do.
        return send(201, invoice, { 'set-cookie': `sid=8f14e45fceea167a5a36dedd4bea2543deadbeefcafef00d; Path=/; HttpOnly` });
      }
      if (request.method === 'GET' && url.pathname === '/v1/invoices') {
        return send(200, { data: [...invoices.values()], has_more: false });
      }
      const match = /^\/v1\/invoices\/(inv_\w+)$/.exec(url.pathname);
      if (request.method === 'GET' && match) {
        const invoice = invoices.get(match[1]!);
        return invoice ? send(200, invoice) : send(404, { error: { message: 'no such invoice' } });
      }
      send(404, { error: { message: 'unknown route' } });
    });
  });

  return new Promise((resolve) => server.listen(UPSTREAM_PORT, () => resolve(server)));
}

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'mocktown.json'),
    JSON.stringify(
      {
        project: 'loop-test',
        services: { [SERVICE]: { provider: 'record' } },
      },
      null,
      2,
    ),
  );

  upstream = await startUpstream();
  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
}, 60_000);

afterAll(async () => {
  await runtime?.shutdown();
  upstream?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("phase 1 — record a real app's traffic, browse the scrubbed corpus", () => {
  test('records exchanges through the front door', async () => {
    const started = await runtime.startRecord({ label: 'loop-test' });
    proxyUrl = started.proxyUrl;
    expect(started.session).toStartWith('ses_');
    // The launch wrapper's env has to carry the knob fetch-based SDKs need (spike 05).
    expect(started.env.NODE_USE_ENV_PROXY).toBe('1');
    expect(started.env.HTTPS_PROXY).toBe(proxyUrl);

    const base = `http://${SERVICE}:${UPSTREAM_PORT}`;
    const created = await fetch(`${base}/v1/invoices`, {
      method: 'POST',
      proxy: proxyUrl,
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk_test_51QxSpIkeRealLookingSecretKeyABCDEF' },
      body: JSON.stringify({ amount: 4200, note: 'Token Ring Adapter' }),
    }).then((r) => r.json() as Promise<{ id: string }>);
    expect(created.id).toStartWith('inv_');

    await fetch(`${base}/v1/invoices/${created.id}`, {
      proxy: proxyUrl,
      headers: { authorization: 'Bearer sk_test_51QxSpIkeRealLookingSecretKeyABCDEF' },
    });
    await fetch(`${base}/v1/invoices`, {
      proxy: proxyUrl,
      headers: { authorization: 'Bearer sk_test_51QxSpIkeRealLookingSecretKeyABCDEF' },
    });

    // Events cross the admin-server boundary asynchronously; give them a moment to land.
    await Bun.sleep(500);

    const rows = runtime.db.select().from(schema.recordings).all();
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.every((r) => r.service === SERVICE)).toBe(true);
  }, 60_000);

  test('the corpus is normalized at write time', () => {
    const templates = new Set(
      runtime.db
        .select()
        .from(schema.recordings)
        .all()
        .map((r) => r.pathTemplate),
    );
    expect([...templates]).toContain('/v1/invoices');
    expect([...templates]).toContain('/v1/invoices/{invoiceId}');
  });

  test('nothing unscrubbed reached disk', () => {
    const stored = JSON.stringify(runtime.db.select().from(schema.recordings).all());
    // The Stripe-shaped key was sent on every request and must be gone from all of them.
    expect(stored).not.toContain('sk_test_51QxSpIkeRealLookingSecretKeyABCDEF');
    expect(stored).toContain('{{secret:stripe-secret-key#');
    // Shape beat location: it was in an Authorization header but is labelled by kind.
    expect(stored).not.toContain('{{secret:auth-header#');
    // The session cookie is redacted while the cookie's name and attributes survive.
    expect(stored).not.toContain('8f14e45fceea167a5a36dedd4bea2543deadbeefcafef00d');
    expect(stored).toContain('sid={{secret:');
    // Business data survives: a false positive here would corrupt the mock's source.
    expect(stored).toContain('Token Ring Adapter');
    expect(stored).toContain('ada@example.com');
  });

  test('stops cleanly and reports what it captured', async () => {
    const stopped = await runtime.stopRecord();
    expect(stopped.recorded).toBeGreaterThanOrEqual(3);
    expect(stopped.services).toContain(SERVICE);
  }, 30_000);
});

describe('phase 2 — the loop closes on a real project', () => {
  test('the corpus export names the create/read coupling a stub would miss', () => {
    const corpus = exportCorpus(runtime.db, SERVICE);
    const post = corpus.routes.find((r) => r.method === 'POST' && r.pathTemplate === '/v1/invoices');
    expect(post).toBeDefined();
    expect(post!.statefulHints.join(' ')).toContain('GET /v1/invoices/{invoiceId}');
    expect(corpus.secretKinds).toContain('stripe-secret-key');
  });

  test('scaffolding writes a brief carrying the house rules and the routes', () => {
    const mocksDir = join(workspace, 'mocks');
    mkdirSync(mocksDir, { recursive: true });
    const { brief, files } = scaffoldMock(mocksDir, exportCorpus(runtime.db, SERVICE));
    expect(files.some((f) => f.endsWith('BRIEF.md'))).toBe(true);
    expect(brief).toContain('untrusted input');
    expect(brief).toContain('POST /v1/invoices');
    expect(brief).toContain('All randomness goes through `ctx.prng`');
  });

  test('an unseen request becomes an issue with a near-miss diagnosis', async () => {
    // Stand in for the agent: write the mock, but leave one recorded route uncovered.
    writeMock({ withList: false });
    switchToGeneratedMock();

    const started = await runtime.startServe({ sealed: true });
    proxyUrl = started.proxyUrl;

    const base = `http://${SERVICE}:${UPSTREAM_PORT}`;
    const response = await fetch(`${base}/v1/invoices`, { proxy: proxyUrl });
    expect(response.status).toBe(501);

    const issues = runtime.issues.list({ status: 'open' });
    const unmatched = issues.find((i) => i.pathTemplate === '/v1/invoices' && i.method === 'GET');
    expect(unmatched).toBeDefined();
    expect(unmatched!.type).toBe('near-miss');
    // Self-contained: the issue names the closest route and links the files to read.
    expect(JSON.stringify(unmatched!.diagnosis)).toContain('/v1/invoices');
    expect(unmatched!.links.some((l) => l.includes('index.ts'))).toBe(true);
    expect(unmatched!.suggestedResolution).toBeTruthy();
  }, 60_000);

  test('the mock is stateful, not a replay of recorded bodies', async () => {
    const base = `http://${SERVICE}:${UPSTREAM_PORT}`;
    const created = await fetch(`${base}/v1/invoices`, {
      method: 'POST',
      proxy: proxyUrl,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 999 }),
    }).then((r) => r.json() as Promise<{ id: string; amount: number }>);

    const fetched = await fetch(`${base}/v1/invoices/${created.id}`, { proxy: proxyUrl }).then(
      (r) => r.json() as Promise<{ id: string; amount: number }>,
    );

    // The bar is emulator, not stub: what was created has to be readable back.
    expect(fetched.id).toBe(created.id);
    expect(fetched.amount).toBe(999);
  }, 30_000);

  test('patching the mock and replaying closes the issue', async () => {
    writeMock({ withList: true });
    // Restart so the patched module is loaded, exactly as the agent loop would.
    await runtime.stopServe();
    await runtime.startServe({ sealed: true });

    const issue = runtime.issues.list().find((i) => i.pathTemplate === '/v1/invoices' && i.method === 'GET')!;
    const baseUrl = runtime.baseUrlFor(SERVICE)!;
    const recordings = recordingsForService(runtime.db, SERVICE).map((row) => ({
      ...row,
      requestBody: row.requestBody,
      responseBody: row.responseBody,
    }));

    const result = await verifyRecordings(recordings, { baseUrl, service: SERVICE }, runtime.currentScrubber);
    expect(result.total).toBeGreaterThanOrEqual(3);
    expect(result.failures.map((f) => `${f.method} ${f.path}: ${f.reason}`)).toEqual([]);

    runtime.issues.setStatus(issue.id, 'resolved', 'route added');
    expect(runtime.issues.get(issue.id)!.status).toBe('resolved');
  }, 60_000);

  test('profiles give each persona its own world', async () => {
    const empty = await fetch(`http://${SERVICE}:${UPSTREAM_PORT}/v1/invoices`, {
      proxy: proxyUrl,
      headers: { authorization: `Bearer ${tokenFor('empty-org')}` },
    }).then((r) => r.json() as Promise<{ data: unknown[] }>);

    // `empty-org` is seeded with nothing and has created nothing, so it sees nothing —
    // the empty state that is otherwise so hard to test.
    expect(empty.data).toEqual([]);
  }, 30_000);

  test('state reset drops runtime state and re-applies the seed', async () => {
    const before = runtime.providerFor(SERVICE)!.state!(SERVICE, { profile: 'default' });
    expect(before.collections.find((c) => c.name === 'invoices')!.count).toBeGreaterThan(0);

    await runtime.resetState({ service: SERVICE, profile: 'default' });

    const after = runtime.providerFor(SERVICE)!.state!(SERVICE, { profile: 'default' });
    const invoices = after.collections.find((c) => c.name === 'invoices');
    // Seeded rows come back; the ones the test created during the run do not.
    expect(invoices?.entries.every((e) => e.seeded) ?? true).toBe(true);
  }, 60_000);
});

// ── Helpers standing in for the coding agent ─────────────────────────────────

function tokenFor(profile: string): string {
  const { mintProfileSession } = require('../src/scenario/profiles.ts');
  return mintProfileSession(runtime.db, profile, runtime.session ?? 'test').token;
}

function switchToGeneratedMock(): void {
  writeFileSync(
    join(workspace, 'mocktown.json'),
    JSON.stringify(
      {
        project: 'loop-test',
        services: { [SERVICE]: { provider: `generated:${SERVICE}` } },
      },
      null,
      2,
    ),
  );
  runtime.reload();
}

/** The module a generating agent would write, with one route withheld the first time. */
function writeMock({ withList }: { withList: boolean }): void {
  const dir = join(workspace, 'mocks', SERVICE);
  mkdirSync(dir, { recursive: true });
  const mocktownSrc = join(import.meta.dir, '..', 'src', 'mocks', 'types.ts');

  writeFileSync(
    join(dir, 'index.ts'),
    `
import { defineMock } from ${JSON.stringify(mocktownSrc)};

export default defineMock({
  service: ${JSON.stringify(SERVICE)},
  seed: ({ state, profile }) => {
    if (profile !== "default") return;
    state.set("invoices", "inv_000001", { id: "inv_000001", amount: 4200, status: "open", customer: "ada@example.com" });
  },
  routes: [
    {
      method: "POST",
      path: "/v1/invoices",
      describe: "Create an invoice",
      handler: (req, ctx) => {
        const id = ctx.state.nextId("invoices", "inv");
        const invoice = { id, amount: (req.body as any)?.amount ?? 0, status: "open", customer: "ada@example.com" };
        ctx.state.set("invoices", id, invoice);
        return { status: 201, body: invoice, headers: { "set-cookie": \`sid=\${ctx.fakeSecret("cookie")}; Path=/; HttpOnly\` } };
      },
    },
    {
      method: "GET",
      path: "/v1/invoices/{invoiceId}",
      describe: "Read one invoice",
      handler: (req, ctx) => {
        const invoice = ctx.state.get("invoices", req.params.invoiceId!);
        return invoice ? { status: 200, body: invoice } : { status: 404, body: { error: { message: "no such invoice" } } };
      },
    },
${
  withList
    ? `    {
      method: "GET",
      path: "/v1/invoices",
      describe: "List invoices",
      handler: (_req, ctx) => ({ status: 200, body: { data: ctx.state.list("invoices").map((e) => e.value), has_more: false } }),
    },
`
    : ''
}  ],
  ekb: [{ rung: 1, envVar: "BILLING_API_URL", note: "The service reads its base URL from this variable." }],
});
`,
  );
}
