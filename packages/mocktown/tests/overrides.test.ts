/**
 * What the overrides layer has to guarantee: a correction still stands after a redraft, and
 * everything it did not say keeps following the corpus. The rest are the failure modes the
 * single-file design could not have — an orphaned override, and a stale draft in the cache.
 */
import { afterAll, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { applyOverrides, renderOverridesModule, retype, type SchemaMap } from '#src/mocks/overrides.ts';
import { buildSchemas, driftBetween, loadSchemaLayer, schemaPaths, writeSchemaModule } from '#src/mocks/schema.ts';

// The last test loads generated modules, and the generated schema imports `mocktown/mock`
// — which only resolves inside the package. So this suite's scratch root lives here rather
// than in the system temp directory.
const root = join(import.meta.dir, '.tmp-overrides');
afterAll(() => rmSync(root, { recursive: true, force: true }));

const draft = (): SchemaMap => ({
  'GET /v1/things/{thingId}': { 200: z.object({ id: z.string(), count: z.string() }), 404: z.object({ Error: z.string() }) },
});

test('a patch corrects one field and leaves the rest of the body alone', () => {
  // `count` was scrubbed into a string; saying so must not pin `id` to today.
  const base = draft();
  const { schemas, overridden } = applyOverrides(
    base,
    { 'GET /v1/things/{thingId}': { 200: (current: z.ZodObject) => current.extend({ count: z.number() }) } },
    'schema.overrides.ts',
  );

  const schema = schemas['GET /v1/things/{thingId}']![200]!;
  expect(schema.safeParse({ id: 'a', count: 3 }).success).toBe(true);
  expect(schema.safeParse({ id: 'a', count: '3' }).success).toBe(false);
  // Untouched by the patch, so still exactly what the corpus said.
  expect(schema.safeParse({ count: 3 }).success).toBe(false);
  expect(overridden).toEqual(new Set(['GET /v1/things/{thingId} 200']));
});

test('a patch tracks the draft it is applied to, not the one it was written against', () => {
  // The API grew a field the correction says nothing about, so it arrives on its own.
  const grown: SchemaMap = {
    'GET /v1/things/{thingId}': { 200: z.object({ id: z.string(), count: z.string(), owner: z.string() }), 404: z.object({}) },
  };
  const { schemas } = applyOverrides(
    grown,
    { 'GET /v1/things/{thingId}': { 200: (current: z.ZodObject) => current.extend({ count: z.number() }) } },
    'schema.overrides.ts',
  );

  const schema = schemas['GET /v1/things/{thingId}']![200]!;
  expect(schema.safeParse({ id: 'a', count: 3, owner: 'x' }).success).toBe(true);
  expect(schema.safeParse({ id: 'a', count: 3 }).success).toBe(false);
});

test('a schema replaces a drafted status, and declares one the corpus never caught', () => {
  const { schemas, overridden } = applyOverrides(
    draft(),
    { 'GET /v1/things/{thingId}': { 404: z.object({ Error: z.string(), Code: z.number() }), 500: z.object({ Error: z.string() }) } },
    'schema.overrides.ts',
  );

  expect(schemas['GET /v1/things/{thingId}']![404]!.safeParse({ Error: 'x' }).success).toBe(false);
  expect(schemas['GET /v1/things/{thingId}']![500]!.safeParse({ Error: 'x' }).success).toBe(true);
  expect(overridden.has('GET /v1/things/{thingId} 500')).toBe(true);
});

test('an override keyed to a route that no longer exists fails loudly, naming the rename', () => {
  // A re-capture can re-template a route out from under an override. Ignoring the orphan
  // hands the corpus back a line the author overruled, silently.
  expect(() => applyOverrides(draft(), { 'GET /v1/things/abc': { 200: z.object({}) } }, 'schema.overrides.ts')).toThrow(
    /did the route become "GET \/v1\/things\/\{thingId\}"\?/,
  );
});

test('a function patch on a status the draft does not declare is refused', () => {
  // Nothing to patch; calling it with undefined fails somewhere far less legible.
  expect(() =>
    applyOverrides(draft(), { 'GET /v1/things/{thingId}': { 500: (current: z.ZodObject) => current } }, 'schema.overrides.ts'),
  ).toThrow(/declares no 500/);
});

test('a patch that returns something other than a schema is refused', () => {
  expect(() =>
    applyOverrides(draft(), { 'GET /v1/things/{thingId}': { 200: () => ({ id: 'string' }) as never } }, 'schema.overrides.ts'),
  ).toThrow(/not a schema/);
});

test('the draft is never mutated, so `--check` still sees what the corpus said', () => {
  const base = draft();
  const before = base['GET /v1/things/{thingId}']![200]!;
  applyOverrides(base, { 'GET /v1/things/{thingId}': { 200: z.object({}) } }, 'schema.overrides.ts');
  expect(base['GET /v1/things/{thingId}']![200]).toBe(before);
});

test('drift marks the entries an override decided, and reports them anyway', () => {
  // Dropping these would hide an override going stale; not marking them buries the real news.
  const entries = buildSchemas([{ method: 'GET', pathTemplate: '/v1/things/{thingId}', statusCode: 200, body: '{"id":"a","count":"3"}' }]);
  const { schemas, overridden } = applyOverrides(
    { 'GET /v1/things/{thingId}': { 200: z.object({ id: z.string(), count: z.string() }) } },
    { 'GET /v1/things/{thingId}': { 200: (current: z.ZodObject) => current.extend({ count: z.number() }) } },
    'schema.overrides.ts',
  );

  const drift = driftBetween(schemas, entries, overridden);
  expect(drift).toHaveLength(1);
  expect(drift[0]!.path).toBe('count');
  expect(drift[0]!.overridden).toBe(true);
});

test('a regenerated draft reaches an unchanged overrides module without a restart', async () => {
  // Why the base is a type and mocktown loads both files: a static import would be served
  // from Bun's cache, making every redraft invisible until a daemon restart.
  const mocksDir = join(root, 'mocks');
  const service = 'api.example.test';
  mkdirSync(join(mocksDir, service), { recursive: true });
  const { overrides } = schemaPaths(mocksDir, service);

  writeSchemaModule(mocksDir, service, buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]));
  writeFileSync(
    overrides,
    `import { z, type SchemaOverrides } from 'mocktown/mock';\n` +
      `import type Schemas from './schema.ts';\n` +
      `export default {\n` +
      `  'GET /v1/things': { 200: (current: z.ZodObject) => current.extend({ id: z.number() }) },\n` +
      `} satisfies SchemaOverrides<typeof Schemas>;\n`,
  );

  const first = await loadSchemaLayer(mocksDir, service);
  expect(first!.schemas['GET /v1/things']![200]!.safeParse({ id: 1 }).success).toBe(true);
  expect(first!.overridden).toEqual(new Set(['GET /v1/things 200']));

  // The corpus grows a field. Only the draft is rewritten; the overrides module is byte-identical.
  writeSchemaModule(
    mocksDir,
    service,
    buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a","note":"b"}' }]),
  );

  const second = await loadSchemaLayer(mocksDir, service);
  const schema = second!.schemas['GET /v1/things']![200]!;
  expect(schema.safeParse({ id: 1, note: 'b' }).success).toBe(true);
  // The correction survived the redraft, and the new field arrived under it.
  expect(schema.safeParse({ id: 1 }).success).toBe(false);
});

test('the starter overrides module compiles to an empty, valid layer', () => {
  // It ships next to every freshly drafted schema.
  expect(renderOverridesModule('api.example.test')).toContain('export default {} satisfies SchemaOverrides<typeof Schemas>;');
  const { schemas, overridden } = applyOverrides(draft(), {}, 'schema.overrides.ts');
  expect(Object.keys(schemas)).toEqual(['GET /v1/things/{thingId}']);
  expect(overridden.size).toBe(0);
});

/**
 * Both `mocks schema` return shapes, against the contract and through the renderer. A field
 * missing from one is rejected at the daemon boundary, not by the compiler.
 */
test('both mocks.schema results satisfy the contract and render', async () => {
  const { contract } = await import('#src/contract/index.ts');
  const { walkContract } = await import('#src/contract/walk.ts');
  const { RENDERERS } = await import('#src/cli/render.ts');

  const procedure = walkContract(contract).find((entry) => entry.path.join('.') === 'mocks.schema');
  const output = procedure!.outputSchema!;
  const render = RENDERERS['mocks.schema']!;

  const common = {
    project: 'app',
    service: 'api.example.test',
    file: '/w/.mocktown/mocks/api.example.test/schema.ts',
    overridesFile: '/w/.mocktown/mocks/api.example.test/schema.overrides.ts',
    recordings: 12,
    routes: [{ route: 'GET /v1/things', statusCode: 200, observations: 12 }],
  };

  const write = output.parse({ ...common, written: true, overridesWritten: true, checked: false, ok: true, drift: [] });
  expect(render(write).join('\n')).toContain('schema.overrides.ts');

  const check = output.parse({
    ...common,
    written: false,
    overridesWritten: false,
    checked: true,
    ok: false,
    drift: [
      {
        route: 'GET /v1/things',
        statusCode: 200,
        kind: 'field-added',
        path: 'owner',
        detail: 'the corpus has string here',
        overridden: false,
      },
      { route: 'GET /v1/things', statusCode: 200, kind: 'type-changed', path: 'count', detail: 'the schema says number', overridden: true },
    ],
  });
  const lines = render(check).join('\n');
  // The API moving leads; the correction is kept, but told apart from it.
  expect(lines).toContain('1 difference between');
  expect(lines).toContain('1 further difference on entries');
});

test('retype reaches a field the corpus got wrong, however deep it is', () => {
  // A scrubbed token count several levels down, which `.extend()` cannot reach.
  const drafted = z.object({
    data: z.object({
      messages: z.array(
        z.object({
          id: z.string(),
          usage: z.object({ inputTokens: z.string(), cacheReadTokens: z.string().optional() }).optional(),
        }),
      ),
    }),
  });

  const fixed = retype(drafted, {
    'data.messages[].usage.inputTokens': z.number(),
    'data.messages[].usage.cacheReadTokens': z.number(),
  });

  expect(fixed.safeParse({ data: { messages: [{ id: 'a', usage: { inputTokens: 5 } }] } }).success).toBe(true);
  expect(fixed.safeParse({ data: { messages: [{ id: 'a', usage: { inputTokens: '5' } }] } }).success).toBe(false);
  // The wrappers the draft had are still there: `usage` optional, `cacheReadTokens` optional.
  expect(fixed.safeParse({ data: { messages: [{ id: 'a' }] } }).success).toBe(true);
  expect(fixed.safeParse({ data: { messages: [{ id: 'a', usage: { inputTokens: 5, cacheReadTokens: 1 } }] } }).success).toBe(true);
  // And everything it did not name is untouched.
  expect(fixed.safeParse({ data: { messages: [{ usage: { inputTokens: 5 } }] } }).success).toBe(false);
});

test('retype descends records, and refuses a path that is not there', () => {
  const drafted = z.object({ byId: z.record(z.string(), z.object({ count: z.string() })) });
  expect(retype(drafted, { 'byId{}.count': z.number() }).safeParse({ byId: { a: { count: 2 } } }).success).toBe(true);

  // Same bargain as the route keys: never stop applying in silence.
  expect(() => retype(drafted, { 'byId{}.total': z.number() })).toThrow(/has no "total" here/);
  expect(() => retype(drafted, { 'byId[].count': z.number() })).toThrow(/\[\] needs an array here/);
});
