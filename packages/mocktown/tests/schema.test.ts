/**
 * What inference is allowed to conclude from a corpus.
 *
 * The bar throughout is the one the feature exists for: a schema drafted from every
 * recording of a route has to accept every one of those recordings. A draft that rejects
 * its own evidence sends the author editing on the first run, which is exactly the loop
 * `shapeDiff` already had.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as z from 'zod/v4';
import {
  buildSchemas,
  detectMaps,
  driftBetween,
  infer,
  merge,
  print,
  renderSchemaModule,
  schemaDiff,
  schemaPaths,
  type TypeNode,
  writeSchemaModule,
} from '#src/mocks/schema.ts';
import { Scrubber } from '#src/scrub/scrubber.ts';

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

test('a draft with no overrides module beside it is never overwritten without force', () => {
  // The rule every schema written before the overrides layer still relies on: those files
  // hold their corrections inline, so regenerating over one silently undoes every
  // correction — the authority the corpus is not supposed to have.
  const mocksDir = mkdtempSync(join(tmpdir(), 'mocktown-schema-'));
  mkdirSync(join(mocksDir, 'api.example.test'), { recursive: true });
  const entries = buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]);
  const { schema, overrides } = schemaPaths(mocksDir, 'api.example.test');
  writeFileSync(schema, '// hand-corrected\n');

  const declined = writeSchemaModule(mocksDir, 'api.example.test', entries);
  expect(declined.written).toBe(false);
  expect(declined.reason).toContain('--force');
  expect(readFileSync(schema, 'utf8')).toBe('// hand-corrected\n');
  // And it did not quietly create the overrides module either: that would arm the redraft
  // rule below against corrections nobody had moved out yet.
  expect(existsSync(overrides)).toBe(false);

  expect(writeSchemaModule(mocksDir, 'api.example.test', entries, { force: true }).written).toBe(true);
  expect(readFileSync(schema, 'utf8')).toContain('mocktown/mock');
});

test('a draft is regenerated once an overrides module exists, and the overrides module is not', () => {
  // The trade the layer makes: the draft belongs to the corpus and is rewritten on every
  // run, which is only safe because corrections live in a file that is written once.
  const mocksDir = mkdtempSync(join(tmpdir(), 'mocktown-schema-'));
  mkdirSync(join(mocksDir, 'api.example.test'), { recursive: true });
  const entries = buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]);

  const first = writeSchemaModule(mocksDir, 'api.example.test', entries);
  expect(first.written).toBe(true);
  expect(first.overridesWritten).toBe(true);
  expect(readFileSync(first.overridesFile, 'utf8')).toContain('satisfies SchemaOverrides');

  writeFileSync(first.overridesFile, '// mine\n');
  const richer = buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a","note":"b"}' }]);
  const second = writeSchemaModule(mocksDir, 'api.example.test', richer);
  expect(second.written).toBe(true);
  expect(second.overridesWritten).toBe(false);
  expect(readFileSync(second.file, 'utf8')).toContain('note');
  expect(readFileSync(first.overridesFile, 'utf8')).toBe('// mine\n');
});

test('the rendered module keys schemas by method, path and status', () => {
  const module = renderSchemaModule(
    'api.example.test',
    buildSchemas([{ method: 'get', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]),
  );
  expect(module).toContain('"GET /v1/things"');
  expect(module).toContain('200:');
  expect(module).toContain('satisfies Record<string, Record<number, z.ZodType>>');
});

test('a redacted field is marked, so the author knows the value is a stub', () => {
  // The corpus cannot say this for itself: after the numeric fix a scrubbed count is still
  // a number, so nothing in the body distinguishes `totalTokens: 91234` from a real one.
  // The field rule is a pure function of the name, so the same question answers it later.
  const scrubber = new Scrubber();
  const note = (field: string, type: TypeNode) => {
    const rule = scrubber.fieldRule(field);
    if (!rule) return undefined;
    const kinds = type.kind === 'union' ? type.options.map((option) => option.kind) : [type.kind];
    if (!kinds.every((kind) => kind === 'string' || kind === 'number' || kind === 'null')) return undefined;
    return `scrubbed as \`${rule.kind}\``;
  };
  const [entry] = buildSchemas(
    [
      {
        method: 'GET',
        pathTemplate: '/v1/usage',
        statusCode: 200,
        body: '{"tokenUsage":{"totalTokens":91234},"requestCount":7}',
      },
    ],
    note,
  );

  expect(entry!.source).toContain('totalTokens: z.number(), // scrubbed as `token`');
  // A field the rules never touched carries no comment, or the marking means nothing.
  expect(entry!.source).toContain('requestCount: z.number(),\n');
  // And `tokenUsage` matches the rule by name but is an object the scrubber walked
  // through, so marking it would put noise on the line above the one that matters.
  expect(entry!.source).toContain('tokenUsage: z.object({\n');
  // The source still compiles: a comment is a comment, not a broken expression.
  expect(compile(entry!.source).safeParse({ tokenUsage: { totalTokens: 1 }, requestCount: 2 }).success).toBe(true);
});

test('a checked-in schema reads back as the model it was printed from', () => {
  // `--check` diffs against what the author wrote, so the round trip has to hold or every
  // check reports drift that is not there.
  const [entry] = buildSchemas([
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a","rank":null,"tags":["x"],"meta":{"n":1}}' },
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"b","rank":2,"tags":[],"meta":{"n":2},"extra":true}' },
  ]);
  expect(driftBetween({ 'GET /v1/things': { 200: compile(entry!.source) } }, [entry!])).toEqual([]);
});

test('check reports what the corpus gained and what it no longer shows', () => {
  const schema = z.object({ id: z.string(), retired: z.string() });
  const drafted = buildSchemas([
    { method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a","added":5}' },
    { method: 'GET', pathTemplate: '/v1/other', statusCode: 200, body: '{"x":1}' },
  ]);
  const drift = driftBetween({ 'GET /v1/things': { 200: schema }, 'GET /v1/gone': { 200: schema } }, drafted);

  expect(drift.map((entry) => `${entry.kind} ${entry.route} ${entry.path}`).sort()).toEqual([
    'field-added GET /v1/things added',
    'field-removed GET /v1/things retired',
    'route-added GET /v1/other (root)',
    'route-removed GET /v1/gone (root)',
  ]);
});

test('check stays quiet about the corrections the schema exists to let you make', () => {
  // A `z.record` where the corpus sees an object is the map fix; `z.unknown()` is an
  // explicit abstention; optionality tracks how much traffic was captured, not the
  // contract. Reporting any of these would nag on every run, forever.
  const schema = z.object({
    tools: z.record(z.string(), z.object({ enabled: z.boolean() })),
    payload: z.unknown(),
    sometimes: z.string(),
  });
  const drafted = buildSchemas([
    {
      method: 'GET',
      pathTemplate: '/v1/a',
      statusCode: 200,
      body: '{"tools":{"slack-1":{"enabled":true}},"payload":{"deep":[1]},"sometimes":"x"}',
    },
    { method: 'GET', pathTemplate: '/v1/a', statusCode: 200, body: '{"tools":{"jira-2":{"enabled":false}},"payload":"a string now"}' },
  ]);
  expect(driftBetween({ 'GET /v1/a': { 200: schema } }, drafted)).toEqual([]);
});

test('a genuine type change is reported', () => {
  // The guard above must not turn into "type changes never surface".
  const drafted = buildSchemas([{ method: 'GET', pathTemplate: '/v1/a', statusCode: 200, body: '{"count":"12"}' }]);
  const drift = driftBetween({ 'GET /v1/a': { 200: z.object({ count: z.number() }) } }, drafted);

  expect(drift).toHaveLength(1);
  expect(drift[0]!.kind).toBe('type-changed');
  expect(drift[0]!.detail).toBe('the schema says number; the corpus now shows string');
});

test('a nullable the author widened is not drift, but narrowing it is', () => {
  const drafted = buildSchemas([
    { method: 'GET', pathTemplate: '/v1/a', statusCode: 200, body: '{"rank":null}' },
    { method: 'GET', pathTemplate: '/v1/a', statusCode: 200, body: '{"rank":3}' },
  ]);
  // The author declared the union the corpus shows: nothing to say.
  expect(driftBetween({ 'GET /v1/a': { 200: z.object({ rank: z.number().nullable() }) } }, drafted)).toEqual([]);
  // The author declared only half of it: the corpus still shows the other half.
  expect(driftBetween({ 'GET /v1/a': { 200: z.object({ rank: z.number() }) } }, drafted)).toHaveLength(1);
});

test('the rendered module asks formatters to leave it alone', () => {
  // This file is thousands of lines of generated literal in someone else's repo, where
  // `bun check --write` runs over everything. One such run rewrote two of these files by
  // ~2000 lines each, which is a diff nobody can review and a file that then flips style
  // depending on who ran what last.
  const module = renderSchemaModule(
    'api.example.test',
    buildSchemas([{ method: 'get', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]),
  );

  expect(module).toContain('// biome-ignore-all format:');

  // Prettier has no file-level opt-out: `// prettier-ignore` covers the next node only. It
  // works here because the entire schema *is* one node, so the directive has to sit
  // immediately before `export default` — anywhere else and it protects nothing.
  expect(module).toContain('// prettier-ignore\nexport default {');
  // Two of them, because Prettier's directive is per-node and the file has two nodes: the
  // import and the export. Without the first, every run flips one line's quote style.
  expect(module).toContain("// prettier-ignore\nimport { z } from 'mocktown/mock';");
});

test('a redraft of an unchanged corpus produces an unchanged file', () => {
  // The draft is rewritten on every run, so anything in it that moves on its own — a
  // generation date, a total — is a diff on a schema that did not change.
  const entries = buildSchemas([{ method: 'GET', pathTemplate: '/v1/things', statusCode: 200, body: '{"id":"a"}' }]);
  expect(renderSchemaModule('api.example.test', entries)).toBe(renderSchemaModule('api.example.test', entries));
  expect(renderSchemaModule('api.example.test', entries)).not.toMatch(/\d{4}-\d{2}-\d{2}/);
});
