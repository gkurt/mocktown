/**
 * One backend, several hostnames.
 *
 * The same service routinely answers on more than one name — a staging host and its
 * production twin, a vanity domain, a legacy CNAME nothing has migrated off. Mocking only
 * one of them means a client that hardcodes the other *escapes to the real upstream*, which
 * is the failure this product exists to prevent and the one that is hardest to notice: the
 * app works, so nothing looks wrong.
 *
 * Declaring an alias asserts the two names are the same backend, so all three of the things
 * that follow from that have to hold together — the front door routes it, the mock answers
 * to it, and traffic recorded through either lands in one corpus. An alias that cannot mean
 * one service is refused rather than guessed at.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspacePaths } from '#src/config/paths.ts';

const root = join(import.meta.dir, '.tmp-aliases');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { schema } = await import('#src/db/client.ts');

const workspace = join(root, 'app');
const typesModule = join(import.meta.dir, '..', 'src', 'mocks', 'types.ts');

const APP = 'app-staging.example.com';
const PROD = 'app.example.com';
const OTHER = 'billing.example.com';
/** Claimed by two services at once: an alias with no single meaning. */
const DISPUTED = 'shared.example.com';

let runtime: InstanceType<typeof ProjectRuntime>;
let warnings: string[];

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });

  for (const service of [APP, OTHER]) {
    const dir = join(workspacePaths(workspace).mocksDir, service);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'index.ts'),
      `import { defineMock } from ${JSON.stringify(typesModule)};\n` +
        `export default defineMock({\n  service: ${JSON.stringify(service)},\n` +
        `  routes: [{ method: "GET", path: "/v1/orders", describe: "List", handler: () => ({ status: 200, body: { served: ${JSON.stringify(service)} } }) }],\n});\n`,
    );
  }

  writeFileSync(
    join(workspace, 'mocktown.json'),
    JSON.stringify(
      {
        project: 'aliases-test',
        services: {
          // The ordinary case, and the two that cannot be honoured.
          [APP]: { provider: `generated:${APP}`, aliases: [PROD, OTHER, DISPUTED] },
          [OTHER]: { provider: `generated:${OTHER}`, aliases: [DISPUTED] },
        },
      },
      null,
      2,
    ),
  );

  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
  warnings = (await runtime.startServe({ sealed: true })).warnings;
});

afterAll(async () => {
  await runtime?.stopServe();
  rmSync(root, { recursive: true, force: true });
});

test('the registry carries the declared aliases', () => {
  const row = runtime.db
    .select()
    .from(schema.services)
    .all()
    .find((service) => service.id === APP);
  expect(row?.aliases).toEqual([PROD, OTHER, DISPUTED]);
});

test('the mock answers to an alias exactly as it answers to its own name', async () => {
  const baseUrl = runtime.allBaseUrls().get(APP);

  const own = await fetch(`${baseUrl}/v1/orders`, { headers: { host: APP } });
  const aliased = await fetch(`${baseUrl}/v1/orders`, { headers: { host: PROD } });

  expect(aliased.status).toBe(200);
  expect(await aliased.json()).toEqual(await own.json());
});

test('an unmocked host is still 501 — an alias names one host, not a wildcard', async () => {
  const baseUrl = runtime.allBaseUrls().get(APP);
  const response = await fetch(`${baseUrl}/v1/orders`, { headers: { host: 'unrelated.example.com' } });
  expect(response.status).toBe(501);
});

/**
 * The escape this closes. Without the alias in the routing table the front door has no entry
 * for the second hostname, so it falls through — to the real service in an unsealed run.
 */
test('the front door routes the alias to the same provider as the service', () => {
  const table = runtime.routingTable();
  const own = table.routes.find((route) => route.host === APP)!;
  const aliased = table.routes.find((route) => route.host === PROD)!;

  expect(own.mode).toBe('mock');
  // The same decision, not one recomputed for a host that has no provider of its own —
  // computing it independently would find no base URL and deny every aliased request.
  expect(aliased).toEqual({ ...own, host: PROD });
});

test('an alias that cannot mean one service is dropped, and said out loud', async () => {
  // `billing.example.com` is a service in its own right. `shared.example.com` is claimed by
  // both. Neither has a single right answer, and picking a winner silently is the bug nobody
  // would ever find — so they are refused and the run says why.
  const table = runtime.routingTable();

  const collision = warnings.find((warning) => warning.includes(OTHER) && warning.includes('service of its own'));
  expect(collision, `no collision warning in ${JSON.stringify(warnings)}`).toBeTruthy();

  const disputed = warnings.find((warning) => warning.includes(DISPUTED));
  expect(disputed).toContain('routed to neither');

  // The real service keeps its own route and its own mock, unshadowed by the alias claim.
  expect(table.routes.filter((route) => route.host === OTHER)).toHaveLength(1);
  const baseUrl = runtime.allBaseUrls().get(OTHER);
  const response = await fetch(`${baseUrl}/v1/orders`, { headers: { host: OTHER } });
  expect(await response.json()).toEqual({ served: OTHER });

  // A disputed alias reaches nothing rather than one of the two claimants.
  expect(table.routes.some((route) => route.host === DISPUTED)).toBe(false);
  const ambiguous = await fetch(`${baseUrl}/v1/orders`, { headers: { host: DISPUTED } });
  expect(ambiguous.status).toBe(501);
});
