/**
 * What inference is allowed to conclude from a corpus.
 *
 * The bar throughout is the one the feature exists for: a schema drafted from every
 * recording of a route has to accept every one of those recordings. A draft that rejects
 * its own evidence sends the author editing on the first run, which is exactly the loop
 * `shapeDiff` already had.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import { buildSchemas, detectMaps, infer, merge, print, renderSchemaModule, schemaDiff, writeSchemaModule } from '#src/mocks/schema.ts';

/** The printed source, evaluated — the only way to test what the author will actually get. */
function compile(source: string): z.ZodType {
  return new Function('z', `return (${source});`)(z) as z.ZodType;
}

const schemaFor = (...bodies: unknown[]) => compile(print(detectMaps(bodies.map(infer).reduce(merge))));

test('a field missing from some recordings becomes optional, not a failure', () => {
  // The corpus is a sample. One route that sometimes omits `note` used to make every
  // recording that carried it disagree with every recording that did not.
  const schema = schemaFor({ id: 'a', note: 'hi' }, { id: 'b' }, { id: 'c', note: 'yo' });

  expect(schema.safeParse({ id: 'z' }).success).toBe(true);
  expect(schema.safeParse({ id: 'z', note: 'x' }).success).toBe(true);
  // `id` was in all three, so it stays required — optionality has to be earned.
  expect(schema.safeParse({ note: 'x' }).success).toBe(false);
});

test('a field seen both null and populated becomes nullable, and prints as nullable', () => {
  // `topCriticalityRank` is null until a ranking pass runs. Under single-recording
  // comparison, whichever form the corpus caught became "the type" and the other failed.
  const source = print(detectMaps([{ rank: null }, { rank: 3 }].map(infer).reduce(merge)));
  expect(source).toContain('z.number().nullable()');

  const schema = compile(source);
  expect(schema.safeParse({ rank: null }).success).toBe(true);
  expect(schema.safeParse({ rank: 7 }).success).toBe(true);
  expect(schema.safeParse({ rank: 'high' }).success).toBe(false);
});

test('every array element is merged, not only the first', () => {
  // `shapeOf` sampled element 0, so a list whose second entry carried an extra field
  // taught the schema nothing about it — and a mock that returned it was still "missing".
  const schema = schemaFor({ items: [{ id: 'a' }, { id: 'b', label: 'x' }] });
  expect(schema.safeParse({ items: [{ id: 'a', label: 'y' }] }).success).toBe(true);
  // Present in one of two elements, so optional rather than required.
  expect(schema.safeParse({ items: [{ id: 'a' }] }).success).toBe(true);
});

test('an empty array does not erase the item type learned from other recordings', () => {
  // `unknown` is the identity in the merge for exactly this: one recording that caught an
  // empty list must not flatten the shape every other recording established.
  const schema = schemaFor({ rows: [] }, { rows: [{ id: 'a', size: 1 }] }, { rows: [] });
  expect(schema.safeParse({ rows: [] }).success).toBe(true);
  expect(schema.safeParse({ rows: [{ id: 'a', size: 2 }] }).success).toBe(true);
  expect(schema.safeParse({ rows: [{ id: 'a', size: 'big' }] }).success).toBe(false);
});

test('an object keyed by machine-generated ids becomes a record, from one recording', () => {
  // Keyed by data, so no mock can ever produce these keys — every replay reported them
  // missing, and there was no way to say the corpus was describing a map.
  const source = print(
    detectMaps(
      infer({
        memoryCitations: {
          '01HZY8QK5N3M4P6R7S8T9V0WXY': { text: 'a' },
          '01HZY8QK5N3M4P6R7S8T9V0WXZ': { text: 'b' },
        },
      }),
    ),
  );
  expect(source).toContain('z.record(z.string(), ');

  const schema = compile(source);
  expect(schema.safeParse({ memoryCitations: { '01ARZ3NDEKTSV4RRFFQ69G5FAV': { text: 'mine' } } }).success).toBe(true);
  expect(schema.safeParse({ memoryCitations: {} }).success).toBe(true);
});

test('a record whose keys repeat is left an object, even with many observations', () => {
  // The dangerous direction. A `z.record` that should have been an object accepts anything
  // and reports nothing, so promotion has to need evidence the keys are data.
  const schema = schemaFor(
    { user: { id: 'a', name: 'x' } },
    { user: { id: 'b', name: 'y' } },
    { user: { id: 'c', name: 'z' } },
    { user: { id: 'd', name: 'w' } },
  );
  expect(schema.safeParse({ user: { id: 'a', name: 'x' } }).success).toBe(true);
  expect(schema.safeParse({ user: { anything: 'goes' } }).success).toBe(false);
});

test('an object whose readable keys never repeat becomes a record once there are enough observations', () => {
  // Connector ids like `slack-prod` match no identifier pattern, so counting is the only
  // signal left — and it needs several observations before two disjoint key sets mean
  // "map" rather than "the schema changed".
  const schema = schemaFor(
    { tools: { 'slack-prod': { enabled: true } } },
    { tools: { 'jira-eu': { enabled: false } } },
    { tools: { 'gh-main': { enabled: true } } },
    { tools: { 'pd-oncall': { enabled: true } } },
  );
  expect(schema.safeParse({ tools: { 'anything-at-all': { enabled: false } } }).success).toBe(true);
});

test('a sparse record is not a map, however little its keys repeat', () => {
  // The trap counting alone falls into. Each response sets a different handful of a fixed
  // field list, so the keys look exactly as unrepeating as a map's — but the values are a
  // string here and a number there, which no map's ever are.
  const schema = schemaFor(
    { settings: { theme: 'dark' } },
    { settings: { retries: 3 } },
    { settings: { webhook: 'https://x' } },
    { settings: { verbose: true } },
  );
  expect(schema.safeParse({ settings: { anythingAtAll: 'x' } }).success).toBe(true);
  // Not a record: the declared fields still have declared types.
  expect(schema.safeParse({ settings: { retries: 'three' } }).success).toBe(false);
});

test('a single key that is unmistakably machine-generated is enough', () => {
  // `capabilityConfigurations` held exactly one connector on this org. One key is still a
  // map when it is named `github-1778774879205` — nothing hand-writes that.
  const source = print(detectMaps(infer({ capabilityConfigurations: { 'github-1778774879205': { connectorType: 'github' } } })));
  expect(source).toContain('z.record(z.string(), ');
  expect(compile(source).safeParse({ capabilityConfigurations: { 'slack-1799999999999': { connectorType: 'slack' } } }).success).toBe(true);
});

test('a status is part of the key, so a 404 body never loosens the 200', () => {
  // Merging them would make every field of the 200 optional, and a schema in which
  // everything is optional checks nothing at all.
  const entries = buildSchemas([
    { method: 'GET', pathTemplate: '/v1/things/{id}', statusCode: 200, body: '{"id":"a","name":"x"}' },
    { method: 'GET', pathTemplate: '/v1/things/{id}', statusCode: 404, body: '{"error":"not found"}' },
  ]);

  expect(entries).toHaveLength(2);
  const ok = entries.find((entry) => entry.statusCode === 200)!;
  expect(compile(ok.source).safeParse({ error: 'not found' }).success).toBe(false);
  expect(compile(ok.source).safeParse({ id: 'a', name: 'x' }).success).toBe(true);
});

test('a drafted schema accepts every recording it was drafted from', () => {
  // The whole promise. If a fresh draft rejects its own corpus, verify fails on the first
  // run and the author is back to hand-editing a shape diff.
  const bodies = [
    { id: 'a', rank: null, tags: [], meta: { source: 'ui' } },
    { id: 'b', rank: 2, tags: ['x'], meta: { source: 'api', retries: 1 } },
    { id: 'c', tags: ['y', 'z'], meta: { source: 'cron' } },
  ];
  const entries = buildSchemas(
    bodies.map((body) => ({
      method: 'GET',
      pathTemplate: '/v1/things',
      statusCode: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify(body),
    })),
  );

  const schema = compile(entries[0]!.source);
  for (const body of bodies) expect(schemaDiff(schema, body)).toEqual([]);
  expect(entries[0]!.observations).toBe(3);
});

test('a non-JSON response contributes nothing, but a JSON one mislabelled text/plain does', () => {
  // An HTML error page is not evidence about the JSON contract. A JSON body served as
  // `text/plain` is — and trusting the header instead of the bytes dropped 132 of one
  // capture's 281 responses on the floor, unchecked and reported as a clean run.
  const entries = buildSchemas([
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '<!doctype html>' },
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: 'not json at all' },
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '42' },
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' },
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"b"}' },
  ]);
  expect(entries).toHaveLength(1);
  expect(entries[0]!.observations).toBe(2);
});

test('extra fields are not failures, because a mock may return more than was captured', () => {
  // The rule `shapeDiff` had, kept: no `.strict()` anywhere in the printed source.
  const schema = schemaFor({ id: 'a' });
  expect(schema.safeParse({ id: 'a', addedByTheMock: true }).success).toBe(true);
  expect(print(infer({ id: 'a' }))).not.toContain('strict');
});

test('a failure names the path that failed', () => {
  const schema = schemaFor({ meta: { count: 1 } });
  expect(schemaDiff(schema, { meta: { count: 'one' } })).toEqual(['meta.count: Invalid input: expected number, received string']);
});

test('a checked-in schema is never overwritten without force', () => {
  // The one rule that makes the file the author's rather than the corpus's. Regenerating
  // over it would silently undo every correction, which is the authority we took away.
  const mocksDir = mkdtempSync(join(tmpdir(), 'mocktown-schema-'));
  mkdirSync(join(mocksDir, 'api.example.test'), { recursive: true });
  const entries = buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]);

  const first = writeSchemaModule(mocksDir, 'api.example.test', entries);
  expect(first.written).toBe(true);

  writeFileSync(first.file, '// hand-corrected\n');
  const second = writeSchemaModule(mocksDir, 'api.example.test', entries);
  expect(second.written).toBe(false);
  expect(second.reason).toContain('--force');
  expect(readFileSync(first.file, 'utf8')).toBe('// hand-corrected\n');

  expect(writeSchemaModule(mocksDir, 'api.example.test', entries, { force: true }).written).toBe(true);
  expect(readFileSync(first.file, 'utf8')).toContain('mocktown/mock');
});

test('the rendered module keys schemas by method, path and status', () => {
  const module = renderSchemaModule(
    'api.example.test',
    buildSchemas([{ method: 'get', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]),
    '2026-01-01',
  );
  expect(module).toContain('"GET /v1/things"');
  expect(module).toContain('200:');
  expect(module).toContain('satisfies Record<string, Record<number, z.ZodType>>');
});
