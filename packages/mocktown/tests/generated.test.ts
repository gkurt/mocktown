/**
 * How a defective generated mock fails.
 *
 * A module that will not import already degrades cleanly — the service is denied and the
 * reason lands on the provider. A module that imports but whose `seed()` throws used to
 * take `serve start` down with an opaque 500 and nothing in the daemon log, which is the
 * one thing a mock defect must never do: an agent's half-written mock is the normal case
 * this loop is built around (07-issues-agent-loop.md).
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-generated');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { stableName } = await import('#src/redirect/portless.ts');

const workspace = join(root, 'app');
const GOOD = 'good.example.com';
const BAD = 'bad.example.com';
const SESSION = 'session.example.com';
let runtime: InstanceType<typeof ProjectRuntime>;

const typesModule = join(import.meta.dir, '..', 'src', 'mocks', 'types.ts');

function writeMock(service: string, body: string): void {
  const dir = join(workspace, 'mocks', service);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'index.ts'),
    `import { defineMock } from ${JSON.stringify(typesModule)};\nexport default defineMock({\n  service: ${JSON.stringify(service)},\n${body}\n});\n`,
  );
}

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'mocktown.json'),
    JSON.stringify(
      {
        project: 'generated-test',
        services: {
          [GOOD]: { provider: `generated:${GOOD}` },
          [BAD]: { provider: `generated:${BAD}` },
          [SESSION]: { provider: `generated:${SESSION}` },
        },
      },
      null,
      2,
    ),
  );

  // The `state.set(collection, value)` slip: two arguments where the store takes three.
  // It loads fine and throws the moment it runs, which is what makes it the realistic case.
  writeMock(
    BAD,
    `  seed: ({ state }) => {
    (state as any).set("invoices", { id: "inv_1" });
  },
  routes: [{ method: "GET", path: "/v1/invoices", describe: "List", handler: () => ({ status: 200, body: {} }) }],`,
  );
  writeMock(
    GOOD,
    `  seed: ({ state }) => {
    state.set("invoices", "inv_1", { id: "inv_1" });
  },
  routes: [{ method: "GET", path: "/v1/invoices", describe: "List", handler: () => ({ status: 200, body: { ok: true } }) }],`,
  );

  writeMock(
    SESSION,
    `  routes: [
    {
      method: "POST",
      path: "/auth/login",
      describe: "Sign in and hand back a session cookie",
      handler: (req, ctx) => {
        const body = req.body as { email: string; password: string };
        const session = ctx.signIn({ email: body.email, password: body.password });
        if (!session) return { status: 401, body: { error: "bad credentials" } };
        return {
          status: 200,
          headers: { "set-cookie": \`app-session=\${session.token}; Path=/; HttpOnly\` },
          body: { ok: true },
        };
      },
    },
    {
      method: "GET",
      path: "/whoami",
      describe: "Report the profile this request resolved to",
      handler: (_req, ctx) => ({ status: 200, body: { profile: ctx.profile } }),
    },
  ],`,
  );

  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
});

afterAll(async () => {
  await runtime?.stopServe();
  rmSync(root, { recursive: true, force: true });
});

test('a mock whose seed throws is reported, not thrown, and does not stop the others', async () => {
  const started = await runtime.startServe({ sealed: true });

  // The whole point: serve came up. Before the fix this rejected and the CLI printed
  // `error: Internal server error` with no reason anywhere.
  expect(started.session).toBeTruthy();

  const seedFailure = started.warnings.find((w) => w.includes(BAD));
  expect(seedFailure, `no warning named ${BAD}: ${JSON.stringify(started.warnings)}`).toBeTruthy();
  expect(seedFailure).toContain('seed() threw');
  // The reason has to identify the profile, or an agent cannot tell which seed path broke.
  expect(seedFailure).toContain('profile');

  // Denied rather than passed through, exactly like a module that would not import.
  expect(runtime.allBaseUrls().has(BAD)).toBe(false);
  // And the healthy mock is untouched by its neighbour's defect.
  expect(runtime.allBaseUrls().has(GOOD)).toBe(true);
});

test('the healthy mock still serves', async () => {
  const baseUrl = runtime.allBaseUrls().get(GOOD);
  const response = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: GOOD } });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ ok: true });
});

test('preflight is answered by reflection, without a route for it', async () => {
  // The mock above declares no OPTIONS route, and should never have to: a wildcard origin
  // is illegal on a credentialed request, so the only correct answer reflects the caller.
  const baseUrl = runtime.allBaseUrls().get(GOOD);
  const origin = 'https://app.example.com';
  const response = await fetch(`${baseUrl}/v1/invoices`, {
    method: 'OPTIONS',
    headers: {
      host: GOOD,
      origin,
      'access-control-request-method': 'GET',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

  expect(response.status).toBe(204);
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(response.headers.get('access-control-allow-origin')).not.toBe('*');
  expect(response.headers.get('access-control-allow-credentials')).toBe('true');
  expect(response.headers.get('access-control-allow-methods')).toBe('GET');
  expect(response.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
  expect(response.headers.get('vary')).toContain('Origin');
});

test('the real response carries the origin too', async () => {
  // A passing preflight only buys the right to send; without this the browser discards
  // the answer and reports a CORS error on a request the mock served perfectly.
  const baseUrl = runtime.allBaseUrls().get(GOOD);
  const origin = 'https://app.example.com';
  const response = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: GOOD, origin } });
  expect(response.status).toBe(200);
  expect(response.headers.get('access-control-allow-origin')).toBe(origin);
  expect(response.headers.get('access-control-allow-credentials')).toBe('true');
});

test('a same-origin request gets no CORS headers', async () => {
  const baseUrl = runtime.allBaseUrls().get(GOOD);
  const response = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: GOOD } });
  expect(response.headers.get('access-control-allow-origin')).toBeNull();
});

test('a JSON body is parsed even when the client called it text/plain', async () => {
  // `fetch(url, { body: JSON.stringify(x) })` sends text/plain unless told otherwise, and
  // real front ends ship that way. Handing the handler a string where it expects an object
  // does not throw — it reads `body.email` as undefined and answers "invalid credentials"
  // to correct ones, which is the kind of defect that looks like a config problem for a day.
  const baseUrl = runtime.allBaseUrls().get(SESSION);
  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { host: SESSION, 'content-type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify({ email: 'default@mocktown.test', password: 'mock-default-1' }),
  });
  expect(login.status).toBe(200);
  expect(login.headers.get('set-cookie') ?? '').toContain('app-session=mtk_');
});

test('a session cookie resolves the profile, not just a bearer token', async () => {
  // How a browser app actually carries a session: sign-in ends with Set-Cookie and no
  // request after it has an Authorization header at all. Reading only that header pinned
  // such an app to `anonymous` for its whole run, which emptied the axis profiles exist
  // for — `default` and `empty-org` could never take effect.
  const baseUrl = runtime.allBaseUrls().get(SESSION);

  const anon = await fetch(`${baseUrl}/whoami`, { headers: { host: SESSION } });
  expect(await anon.json()).toEqual({ profile: 'anonymous' });

  const login = await fetch(`${baseUrl}/auth/login`, {
    method: 'POST',
    headers: { host: SESSION, 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'default@mocktown.test', password: 'mock-default-1' }),
  });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie') ?? '';
  expect(cookie).toContain('app-session=mtk_');

  const named = await fetch(`${baseUrl}/whoami`, {
    headers: { host: SESSION, cookie: cookie.split(';')[0]! },
  });
  expect(await named.json()).toEqual({ profile: 'default' });

  // The app's other cookies sit beside it without confusing the lookup, and a cookie that
  // no mock minted leaves the caller anonymous rather than guessing.
  const noisy = await fetch(`${baseUrl}/whoami`, {
    headers: { host: SESSION, cookie: `ph_id=abc; ${cookie.split(';')[0]!}; theme=dark` },
  });
  expect(await noisy.json()).toEqual({ profile: 'default' });

  const forged = await fetch(`${baseUrl}/whoami`, { headers: { host: SESSION, cookie: 'app-session=mtk_nope' } });
  expect(await forged.json()).toEqual({ profile: 'anonymous' });
});

test('a `.localhost` alias reaches the mock the Host names', async () => {
  // One provider serves every mock on one port and tells them apart by Host, so a client
  // pointed straight at `http://127.0.0.1:<port>` arrives as `127.0.0.1` and matches
  // nothing — which made the rung-1 EKB recipe, one env var pointing at that URL,
  // unusable from a browser. `<service>.localhost` resolves to loopback with nothing
  // installed and carries the identity in the Host.
  const baseUrl = runtime.allBaseUrls().get(GOOD);
  const aliased = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: `${GOOD}.localhost` } });
  expect(aliased.status).toBe(200);
  expect(await aliased.json()).toEqual({ ok: true });

  // The suffix is not a wildcard: an unknown service is still an unknown service.
  const unknown = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: 'nobody.example.com.localhost' } });
  expect(unknown.status).toBe(501);
});

test('a provider answers to a stable name that is not the service name', async () => {
  // portless fronts each provider under a slugged name — `good.example.com` becomes
  // `good-example-com.<project>.localhost` — which no suffix-stripping turns back into the
  // service. Before this, switching stable names on made every generated mock 501: the
  // feature reported itself as configured and nothing worked.
  const baseUrl = runtime.allBaseUrls().get(GOOD);
  const provider = runtime.provider('generated') as unknown as { setAliases(a: Map<string, string>): void };
  const stable = `${stableName('test-project', GOOD)}.localhost`;

  const before = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: stable } });
  expect(before.status).toBe(501);

  provider.setAliases(new Map([[stable, GOOD]]));
  const after = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: stable } });
  expect(after.status).toBe(200);
  expect(await after.json()).toEqual({ ok: true });

  // An alias names one service; it is not a wildcard for the rest.
  const other = await fetch(`${baseUrl}/v1/invoices`, { headers: { host: 'unrelated.localhost' } });
  expect(other.status).toBe(501);
});
