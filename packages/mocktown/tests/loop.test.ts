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
import { workspacePaths } from '#src/config/paths.ts';

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
const { bypassedByNoProxy } = await import('#src/capture/launch.ts');

const workspace = join(root, 'app');
const UPSTREAM_PORT = 5599;
const SERVICE = 'billing.localhost';
const NOISE_SERVICE = 'telemetry.localhost';
const UNDECLARED_SERVICE = 'ledger.localhost';
/** The same backend under a second name — see aliases.test.ts. */
const ALIAS = 'invoices.localhost';

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
        services: { [SERVICE]: { provider: 'record', aliases: [ALIAS] } },
        // A stand-in for the browser's own chatter: same upstream, a hostname the corpus
        // is told is not evidence.
        capture: { ignore: [NOISE_SERVICE] },
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

    // The service under test is a `.localhost` name, so the bypass list must not carry the
    // blanket `localhost` entry — with it, every request below would go straight to the
    // upstream and this whole file would pass while recording nothing.
    expect(started.env.NO_PROXY!.split(',')).not.toContain('localhost');
    expect(bypassedByNoProxy(SERVICE, started.env.NO_PROXY!.split(','))).toBe(false);
    // Dropping it is a trade, so it is said out loud rather than assumed harmless.
    expect(started.warnings.join(' ')).toContain('noProxy');

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

  /**
   * The corpus's editorial line, end to end. A recorded browser makes far more requests on
   * its own behalf than the app makes on purpose, and every one of them used to become a
   * corpus row *and* a discovered service. Filtering the write path is what keeps the
   * services list a list of dependencies.
   */
  test('client-runtime noise reaches the front door and lands nowhere', async () => {
    const before = runtime.db.select().from(schema.recordings).all().length;
    await fetch(`http://${NOISE_SERVICE}:${UPSTREAM_PORT}/v1/invoices`, { proxy: proxyUrl });
    await Bun.sleep(500);

    expect(runtime.db.select().from(schema.recordings).all().length).toBe(before);
    // The service row is the half that matters most: discovery runs off the write path, so
    // a filtered host never appears in `mocktown services list` either.
    const services = runtime.db
      .select()
      .from(schema.services)
      .all()
      .map((row) => row.id);
    expect(services).toContain(SERVICE);
    expect(services).not.toContain(NOISE_SERVICE);
  }, 30_000);

  /**
   * The corpus half of an alias. Declaring one asserts the two hostnames are the same
   * backend, so recording through either has to build one body of evidence — otherwise the
   * second name arrives as a new discovered service and the mock gets written from half a
   * corpus while the other half sits under a name nothing serves.
   */
  test('traffic recorded through an alias belongs to the service it names', async () => {
    const before = runtime.db.select().from(schema.recordings).all().length;
    await fetch(`http://${ALIAS}:${UPSTREAM_PORT}/v1/invoices`, { proxy: proxyUrl });
    await Bun.sleep(500);

    const rows = runtime.db.select().from(schema.recordings).all();
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)!.service).toBe(SERVICE);

    // And no second registry entry: an alias is not a dependency of its own to go and mock.
    const services = runtime.db
      .select()
      .from(schema.services)
      .all()
      .map((row) => row.id);
    expect(services).not.toContain(ALIAS);
    expect(runtime.issues.list({ type: 'undeclared-service' }).some((i) => i.service === ALIAS)).toBe(false);
  }, 30_000);

  /**
   * The other half of the editorial line. A host that is *not* filtered and *not* declared
   * is the interesting case: mocktown records it, and someone now has a decision to make.
   * That was only ever a warning recomputed by `status`, so it vanished on restart and
   * could not be assigned or closed — the shape of a work item, filed as one.
   */
  test('an undeclared host becomes a work item, not a warning', async () => {
    await fetch(`http://${UNDECLARED_SERVICE}:${UPSTREAM_PORT}/v1/invoices`, { proxy: proxyUrl });
    await Bun.sleep(500);

    const discovered = runtime.db
      .select()
      .from(schema.services)
      .all()
      .find((row) => row.id === UNDECLARED_SERVICE);
    expect(discovered?.discovered).toBe(true);

    const issue = runtime.issues.list({ status: 'open' }).find((i) => i.service === UNDECLARED_SERVICE);
    expect(issue).toBeDefined();
    expect(issue!.type).toBe('undeclared-service');
    // A decision needs the command that records it, and the evidence it is made from.
    expect(issue!.suggestedResolution).toContain(`mocktown services set --id ${UNDECLARED_SERVICE}`);
    expect(issue!.links).toContain(`mocktown recordings routes --service ${UNDECLARED_SERVICE}`);

    // A declared service is a decision already made and must never be filed against.
    expect(runtime.issues.list({ type: 'undeclared-service' }).some((i) => i.service === SERVICE)).toBe(false);
  }, 30_000);

  test('stops cleanly and reports what it captured', async () => {
    const stopped = await runtime.stopRecord();
    expect(stopped.recorded).toBeGreaterThanOrEqual(3);
    expect(stopped.services).toContain(SERVICE);
    // Dropped, but never silently: the count and the reason come back with the session.
    expect(stopped.ignored.total).toBeGreaterThanOrEqual(1);
    expect(stopped.ignored.patterns[0]!.pattern).toBe(NOISE_SERVICE);
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
    const mocksDir = workspacePaths(workspace).mocksDir;
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
    expect(unmatched!.type).toBe('unmatched-request');
    // Ranked candidates, not a verdict: the reader sees what the scorer saw and decides
    // whether the best of them is the same endpoint or a different one.
    const nearest = (unmatched!.diagnosis as { nearest: { path: string; score: number; reasons: string[] }[] }).nearest;
    expect(nearest.length).toBeGreaterThan(0);
    expect(nearest[0]!.score).toBeGreaterThan(0);
    expect(nearest.map((c) => c.score)).toEqual([...nearest.map((c) => c.score)].sort((a, b) => b - a));
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

    // The undeclared host is still undeclared, so its work item survives the restart that
    // used to be all it took to lose a discovery warning.
    const undeclared = runtime.issues.list({ status: 'open' }).find((i) => i.service === UNDECLARED_SERVICE);
    expect(undeclared?.type).toBe('undeclared-service');

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

    // A resolve whose verification fails lands on `reopened`, and that used to fall out of
    // every queue: `status: 'open'` is an equality match, so the issues most in need of
    // attention were the ones the obvious filter hid, and an empty list read as done.
    runtime.issues.setStatus(issue.id, 'reopened', 'replay still failed');
    expect(runtime.issues.list({ status: 'open' }).map((i) => i.id)).not.toContain(issue.id);
    expect(runtime.issues.list({ status: 'outstanding' }).map((i) => i.id)).toContain(issue.id);
    // `outstanding` is a question, not a status — the row still says what happened to it.
    expect(runtime.issues.get(issue.id)!.status).toBe('reopened');
    // And it does not sweep up the ones that are genuinely finished.
    runtime.issues.setStatus(issue.id, 'resolved', 'route added');
    expect(runtime.issues.list({ status: 'outstanding' }).map((i) => i.id)).not.toContain(issue.id);
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

  test("the app's own loopback service is denied as itself, not as a missing dependency", async () => {
    // The cost of dropping the blanket `localhost` entry: a service the app reaches by
    // name now arrives here. Denying it is right — the seal has no other answer — but
    // calling it an undeclared third-party dependency would send an agent off to write a
    // mock for the app's own API.
    const response = await fetch('http://app.localhost:9/healthz', { proxy: proxyUrl });
    expect(response.status).toBe(502);

    // The wall hit crosses the admin-server boundary after the response reaches the client.
    let issue = runtime.issues.list({ status: 'open' }).find((i) => i.service === 'app.localhost');
    for (let attempt = 0; attempt < 20 && !issue; attempt++) {
      await Bun.sleep(50);
      issue = runtime.issues.list({ status: 'open' }).find((i) => i.service === 'app.localhost');
    }
    expect(issue).toBeDefined();
    expect(issue!.type).toBe('unknown-service');
    expect(JSON.stringify(issue!.diagnosis)).toContain('loopback');
    // The fix is a config line, and the issue has to be the thing that says so.
    expect(issue!.suggestedResolution).toContain('noProxy');
  }, 30_000);

  test('state reset drops runtime state and re-applies the seed', async () => {
    const before = await runtime.stateFor(SERVICE, { profile: 'default' });
    expect(before.collections.find((c) => c.name === 'invoices')!.count).toBeGreaterThan(0);

    await runtime.resetState({ service: SERVICE, profile: 'default' });

    const after = await runtime.stateFor(SERVICE, { profile: 'default' });
    const invoices = after.collections.find((c) => c.name === 'invoices');
    // Seeded rows come back; the ones the test created during the run do not.
    expect(invoices?.entries.every((e) => e.seeded) ?? true).toBe(true);
  }, 60_000);
});

describe('re-recording a service that is already mocked', () => {
  test('a mocked host is denied in a record session, and `--live` is what reopens it', async () => {
    // Pinned at `generated:`, the host has no provider up during a record run, so routing
    // denies it rather than leaking to the upstream. Correct — and it is why re-recording
    // needs a way back in that is not an edit to mocktown.json and a promise to undo it.
    switchToGeneratedMock();
    const modeFor = () => runtime.routingTable().routes.find((r) => r.host === SERVICE)?.mode;

    await runtime.startRecord({ label: 'rerecord-denied' });
    expect(modeFor()).toBe('deny');
    await runtime.stopRecord();

    await runtime.startRecord({ label: 'rerecord-live', recordOverride: [SERVICE] });
    expect(modeFor()).toBe('record');
    await runtime.stopRecord();

    // Session-scoped: the next run inherits the registry, not the flag.
    await runtime.startRecord({ label: 'rerecord-after' });
    expect(modeFor()).toBe('deny');
    await runtime.stopRecord();
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
  const dir = join(workspacePaths(workspace).mocksDir, SERVICE);
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
