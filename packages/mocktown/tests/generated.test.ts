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

const workspace = join(root, 'app');
const GOOD = 'good.example.com';
const BAD = 'bad.example.com';
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
        services: { [GOOD]: { provider: `generated:${GOOD}` }, [BAD]: { provider: `generated:${BAD}` } },
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
