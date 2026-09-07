/**
 * Response schemas: inferred from the corpus once, then owned by the mock author.
 *
 * ## Why this exists
 *
 * Verification used to compare a mock's response against **one** recorded response, field
 * path by field path (`shapeOf` in verify.ts). That treats a single observation as a
 * specification, and a single observation is a poor one:
 *
 *   - It cannot express a union. A rank field is null until a ranking pass runs, and the
 *     corpus holds both forms. Whichever one a given recording happened to catch became
 *     "the type", and the other became a failure — on the same route.
 *   - It cannot tell a record from a map. `{"01KZBD…": {…}}` is keyed by data, so a mock
 *     can never produce that key and every replay reports it missing.
 *   - It cannot be corrected. When the corpus is *wrong* — scrubbing runs before anything
 *     reaches disk, so a redacted field records the redaction's type — there was no way to
 *     say so, and the only way to pass was to build the mock wrong.
 *
 * Merging every recording of a route fixes the first two. Writing the result to a file the
 * author owns fixes the third: the corpus stops being a permanent oracle and becomes what
 * it always was — evidence, good enough to draft from.
 *
 * ## What inference will and will not claim
 *
 * Merging is deliberately conservative, because the two failure directions are not
 * symmetric. A `z.object` that should have been `z.record` is a one-line edit the author
 * makes once; a `z.record` that should have been an object silently stops checking a real
 * payload and nobody finds out. So map promotion needs evidence, and everything else stays
 * an object.
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as z from 'zod/v4';

/** The inferred model. Deliberately smaller than Zod: only what a JSON body can express. */
export type TypeNode =
  | { kind: 'string' | 'number' | 'boolean' | 'null' | 'unknown' }
  | { kind: 'array'; item: TypeNode }
  | { kind: 'object'; fields: Map<string, FieldNode>; observations: number }
  | { kind: 'record'; value: TypeNode }
  | { kind: 'union'; options: TypeNode[] };

export interface FieldNode {
  type: TypeNode;
  /** How many of the enclosing object's observations carried this key. */
  seen: number;
}

type ObjectNode = Extract<TypeNode, { kind: 'object' }>;

const PRIMITIVES = new Set(['string', 'number', 'boolean', 'null']);

/** One JSON value to a type. Every array element counts, never just the first. */
export function infer(value: unknown): TypeNode {
  if (value === null) return { kind: 'null' };
  if (Array.isArray(value)) {
    // An empty array is evidence that the field is an array and nothing else, so its item
    // type is `unknown` rather than absent: `z.array(z.unknown())` still checks the array.
    if (value.length === 0) return { kind: 'array', item: { kind: 'unknown' } };
    return { kind: 'array', item: value.map(infer).reduce(merge) };
  }
  if (typeof value === 'object') {
    const fields = new Map<string, FieldNode>();
    for (const [key, child] of Object.entries(value)) fields.set(key, { type: infer(child), seen: 1 });
    return { kind: 'object', fields, observations: 1 };
  }
  if (typeof value === 'string') return { kind: 'string' };
  if (typeof value === 'number') return { kind: 'number' };
  if (typeof value === 'boolean') return { kind: 'boolean' };
  return { kind: 'unknown' };
}

/**
 * Two observations of the same position, combined.
 *
 * `unknown` is the identity — it means "seen, with nothing in it": an empty array's item,
 * a `{}`. Anything real beats it, which is what stops one empty list in the corpus from
 * erasing what every other recording of the route showed.
 */
export function merge(a: TypeNode, b: TypeNode): TypeNode {
  if (a.kind === 'unknown') return b;
  if (b.kind === 'unknown') return a;
  if (a.kind === 'union' || b.kind === 'union') {
    return unionOf([...(a.kind === 'union' ? a.options : [a]), ...(b.kind === 'union' ? b.options : [b])]);
  }
  if (a.kind === 'array' && b.kind === 'array') return { kind: 'array', item: merge(a.item, b.item) };
  if (a.kind === 'record' && b.kind === 'record') return { kind: 'record', value: merge(a.value, b.value) };
  if (a.kind === 'object' && b.kind === 'object') return mergeObjects(a, b);
  if (a.kind === b.kind && PRIMITIVES.has(a.kind)) return a;
  return unionOf([a, b]);
}

function mergeObjects(a: ObjectNode, b: ObjectNode): ObjectNode {
  const fields = new Map<string, FieldNode>();
  for (const [key, field] of a.fields) fields.set(key, { ...field });
  for (const [key, field] of b.fields) {
    const existing = fields.get(key);
    fields.set(key, existing ? { type: merge(existing.type, field.type), seen: existing.seen + field.seen } : { ...field });
  }
  return { kind: 'object', fields, observations: a.observations + b.observations };
}

/**
 * Flatten a union, collapse anything mergeable, and unwrap a single option.
 *
 * Two objects in a union are two observations of one thing, not two alternatives: merging
 * them keeps the optionality bookkeeping that later tells "always present" from "sometimes
 * present". Only genuinely different kinds survive side by side.
 */
function unionOf(options: TypeNode[]): TypeNode {
  const out: TypeNode[] = [];
  for (const option of options) {
    if (option.kind === 'unknown') continue;
    const twin = out.findIndex((existing) => existing.kind === option.kind);
    if (twin >= 0) out[twin] = merge(out[twin]!, option);
    else out.push(option);
  }
  if (out.length === 0) return { kind: 'unknown' };
  if (out.length === 1) return out[0]!;
  return { kind: 'union', options: out };
}

/**
 * How much an object's keys repeat across its observations: 1 when every observation
 * carried every key, about 1/n when they share none.
 *
 * A record has fixed field names, so its keys repeat perfectly. A map is keyed by data, so
 * its keys barely repeat at all. Counting is enough to tell them apart, and counting has
 * the advantage of not caring what the keys look like.
 */
export function repeatRate(node: ObjectNode): number {
  if (node.fields.size === 0 || node.observations === 0) return 1;
  let seen = 0;
  for (const field of node.fields.values()) seen += field.seen;
  return seen / (node.fields.size * node.observations);
}

/**
 * Keys no schema author would ever write by hand: a UUID, a ULID, an ObjectId, a long
 * opaque token.
 *
 * This is the escape hatch for the case counting cannot reach — a map seen in a single
 * recording, where there is nothing to compare its keys against. The pattern list is
 * deliberately narrow: it matches identifiers with a fixed machine-generated form and
 * nothing else, so a map keyed by something readable (`"slack-prod"`, an email address) is
 * left as an object for the author to correct. Missing one of those costs an edit; wrongly
 * promoting a real record costs silent non-verification.
 */
const OPAQUE_KEY = [
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, // uuid
  /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, // ulid
  /^[0-9a-f]{24}$/, // objectid
  /^[0-9a-f]{32,}$/, // hex digest
  /^[A-Za-z0-9_-]{22,}$/, // long opaque token
  /^[A-Za-z][A-Za-z0-9]*[-_]\d{10,}$/, // slug plus a minted timestamp: `github-1778774879205`
];
const isOpaqueKey = (key: string) => OPAQUE_KEY.some((pattern) => pattern.test(key));

/**
 * Whether every value under these keys is the same sort of thing.
 *
 * This is what separates a map from a *sparse record* — a settings object where each
 * response happens to carry a different handful of a fixed field list. Both have keys that
 * fail to repeat, so counting alone cannot tell them apart, but a map's values are all one
 * type by construction while a sparse record's are a string here and a number there. For
 * objects it asks only that some key is common to all of them: map entries drawn from one
 * type still differ in their optional fields.
 */
function isHomogeneous(node: ObjectNode): boolean {
  const types = [...node.fields.values()].map((field) => field.type);
  const [first] = types;
  if (!first) return false;
  if (!types.every((type) => type.kind === first.kind)) return false;
  if (first.kind !== 'object') return true;

  const objects = types as ObjectNode[];
  return [...objects[0]!.fields.keys()].some((key) => objects.every((object) => object.fields.has(key)));
}

const MAP_MIN_OBSERVATIONS = 3;
const MAP_MAX_REPEAT_RATE = 0.5;
const MAP_MIN_KEYS = 2;

function looksLikeMap(node: ObjectNode): boolean {
  const keys = [...node.fields.keys()];
  if (keys.length === 0) return false;
  // Every key machine-generated: conclusive on its own, even from a single observation and
  // even for a single key. No API hand-writes a field called `01ARZ3NDEKTSV4RRFFQ69G5FAV`.
  if (keys.every(isOpaqueKey)) return true;
  // Otherwise the keys have to be seen not repeating across several observations, and the
  // values have to look like entries rather than fields. Two observations that happen to
  // share no keys are as likely to be a schema change as a map, so wait for a third.
  return (
    keys.length >= MAP_MIN_KEYS &&
    node.observations >= MAP_MIN_OBSERVATIONS &&
    repeatRate(node) < MAP_MAX_REPEAT_RATE &&
    isHomogeneous(node)
  );
}

/** Promote objects whose keys are data to `record`, depth-first. */
export function detectMaps(node: TypeNode): TypeNode {
  if (node.kind === 'array') return { kind: 'array', item: detectMaps(node.item) };
  if (node.kind === 'record') return { kind: 'record', value: detectMaps(node.value) };
  if (node.kind === 'union') return unionOf(node.options.map(detectMaps));
  if (node.kind !== 'object') return node;

  const fields = new Map([...node.fields].map(([key, field]) => [key, { ...field, type: detectMaps(field.type) }] as const));
  const walked: ObjectNode = { ...node, fields };
  if (!looksLikeMap(walked)) return walked;

  // Every key's value merged into one: what the record's value type has to accept.
  const value = [...walked.fields.values()].map((field) => field.type).reduce(merge, { kind: 'unknown' } as TypeNode);
  return { kind: 'record', value };
}

// ── printing ───────────────────────────────────────────────────────────────────────────

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const propertyKey = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** The model as Zod source. `indent` is the current depth, so nesting stays readable. */
export function print(node: TypeNode, indent = 0): string {
  const pad = '  '.repeat(indent + 1);
  const close = '  '.repeat(indent);

  switch (node.kind) {
    case 'string':
    case 'number':
    case 'boolean':
      return `z.${node.kind}()`;
    case 'null':
      return 'z.null()';
    // Nothing in the corpus ever had a value here — an empty array's item, or a `{}`.
    // `unknown` accepts anything, which is the honest thing to say about no evidence.
    case 'unknown':
      return 'z.unknown()';
    case 'array':
      return `z.array(${print(node.item, indent)})`;
    case 'record':
      return `z.record(z.string(), ${print(node.value, indent)})`;
    case 'union': {
      // `T | null` prints as `.nullable()`, which is what a reviewer expects to read.
      const nullable = node.options.some((option) => option.kind === 'null');
      const rest = node.options.filter((option) => option.kind !== 'null');
      if (rest.length === 0) return 'z.null()';
      if (rest.length === 1) return `${print(rest[0]!, indent)}${nullable ? '.nullable()' : ''}`;
      const body = `z.union([\n${rest.map((option) => `${pad}${print(option, indent + 1)},`).join('\n')}\n${close}])`;
      return nullable ? `${body}.nullable()` : body;
    }
    case 'object': {
      if (node.fields.size === 0) return 'z.object({})';
      const lines = [...node.fields]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, field]) => {
          // Present in some observations but not all, so the mock is free to omit it.
          // Without this, one route with a slimmer variant fails against its own corpus.
          const optional = field.seen < node.observations ? '.optional()' : '';
          return `${pad}${propertyKey(name)}: ${print(field.type, indent + 1)}${optional},`;
        });
      return `z.object({\n${lines.join('\n')}\n${close}})`;
    }
  }
}

// ── the artifact ───────────────────────────────────────────────────────────────────────

export interface RouteObservation {
  method: string;
  pathTemplate: string;
  statusCode: number;
  body: string | null;
}

/**
 * A body as a JSON document, or undefined when it is not one.
 *
 * Deliberately not driven by `content-type`. Real APIs serve JSON as `text/plain` — on one
 * staging capture that was 132 of 281 responses, and trusting the header exempted every
 * one of them from body comparison entirely, which reads as a clean run rather than as an
 * unchecked one. What settles it is whether the bytes parse into an object or an array; a
 * bare number or a quoted string parses too, and neither is a document with a shape.
 */
export function parseJsonBody(body: string | null): unknown | undefined {
  if (!body) return undefined;
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined; // html, a plain-text error, or a truncated body
  }
}

export interface SchemaEntry {
  route: string;
  statusCode: number;
  observations: number;
  source: string;
}

/** `GET /v1/things` — how a schema is addressed, in the generated file and at verify time. */
export const schemaKey = (method: string, pathTemplate: string) => `${method.toUpperCase()} ${pathTemplate}`;

/**
 * Group observations by route and status, merge each group, print it.
 *
 * Status is part of the key because a 404 body is not a slim 200. Merging them would make
 * every field optional, and a schema where everything is optional checks nothing.
 */
export function buildSchemas(observations: RouteObservation[]): SchemaEntry[] {
  const groups = new Map<string, { route: string; statusCode: number; nodes: TypeNode[] }>();

  for (const observation of observations) {
    const parsed = parseJsonBody(observation.body);
    if (parsed === undefined) continue;
    const route = schemaKey(observation.method, observation.pathTemplate);
    const key = `${route} ${observation.statusCode}`;
    const group = groups.get(key) ?? { route, statusCode: observation.statusCode, nodes: [] };
    group.nodes.push(infer(parsed));
    groups.set(key, group);
  }

  return [...groups.values()]
    .map((group) => ({
      route: group.route,
      statusCode: group.statusCode,
      observations: group.nodes.length,
      source: print(detectMaps(group.nodes.reduce(merge))),
    }))
    .sort((a, b) => a.route.localeCompare(b.route) || a.statusCode - b.statusCode);
}

const header = (service: string, generatedAt: string, total: number) => `/**
 * Response schemas for \`${service}\`.
 *
 * Drafted ${generatedAt} from ${total} recorded response${total === 1 ? '' : 's'}.
 *
 * **This file is yours to edit.** It is scaffolded from the corpus, not owned by it:
 * \`mocktown mocks schema\` will not overwrite it once it exists. Verification checks the
 * mock against *this*, so correcting a line here is how you overrule a recording.
 *
 * Expect to correct it, because the corpus is a witness and not a contract:
 *
 *   - It can be wrong. Scrubbing runs before anything reaches disk, so a redacted field
 *     records the redaction's type rather than the API's.
 *   - It only shows what was exercised. A field no recording ever populated is missing
 *     here, and one that happened to be null throughout is inferred \`z.null()\`.
 *   - Map detection is deliberately shy. An object keyed by data is promoted to
 *     \`z.record\` only when its keys are machine-generated or observed not to repeat;
 *     below that it is left as an object, because the opposite mistake checks nothing.
 *
 * Unknown keys are allowed by design — no \`.strict()\` — since a mock may legitimately
 * return more than the corpus happened to capture.
 */
import { z } from 'mocktown/mock';
`;

/** The generated module, ready to write. */
export function renderSchemaModule(service: string, entries: SchemaEntry[], generatedAt: string): string {
  const total = entries.reduce((sum, entry) => sum + entry.observations, 0);

  const byRoute = new Map<string, SchemaEntry[]>();
  for (const entry of entries) byRoute.set(entry.route, [...(byRoute.get(entry.route) ?? []), entry]);

  const blocks = [...byRoute].map(([route, statuses]) => {
    const lines = statuses.map((entry) => {
      const indented = entry.source
        .split('\n')
        .map((line, index) => (index === 0 ? line : `    ${line}`))
        .join('\n');
      return `    ${entry.statusCode}: ${indented}, // ${entry.observations} recorded`;
    });
    return `  ${JSON.stringify(route)}: {\n${lines.join('\n')}\n  },`;
  });

  return `${header(service, generatedAt, total)}
export default {
${blocks.join('\n')}
} satisfies Record<string, Record<number, z.ZodType>>;
`;
}

export interface WriteSchemaResult {
  file: string;
  written: boolean;
  /** Why it was not written, when it was not. */
  reason?: string;
}

/**
 * Write `mocks/<service>/schema.ts`, once.
 *
 * The same rule the module scaffold follows for `index.ts`: never overwrite something an
 * author has already edited. A schema that regenerated itself would silently undo every
 * correction — which is exactly the authority the corpus is not supposed to have.
 */
export function writeSchemaModule(
  mocksDir: string,
  service: string,
  entries: SchemaEntry[],
  options: { force?: boolean; generatedAt?: string } = {},
): WriteSchemaResult {
  const file = join(mocksDir, service, 'schema.ts');
  if (existsSync(file) && !options.force) {
    return { file, written: false, reason: 'a schema is already checked in; pass --force to redraft it from the corpus' };
  }
  writeFileSync(file, renderSchemaModule(service, entries, options.generatedAt ?? new Date().toISOString().slice(0, 10)));
  return { file, written: true };
}

export type SchemaMap = Record<string, Record<number, z.ZodType>>;

/**
 * The checked-in schema for a service, or null when there is none.
 *
 * Cache-busted on mtime like the mock module itself, so editing a schema takes effect on
 * the next verify without restarting the daemon.
 */
export async function loadSchemas(mocksDir: string, service: string): Promise<SchemaMap | null> {
  const file = join(mocksDir, service, 'schema.ts');
  if (!existsSync(file)) return null;
  const imported = await import(`${file}?v=${statSync(file).mtimeMs}`);
  const map = imported.default;
  if (!map || typeof map !== 'object') throw new Error(`${file} has no default export`);
  return map as SchemaMap;
}

/**
 * What a body fails in a schema, phrased the way `shapeDiff` phrases it so an issue reads
 * the same whichever path produced it.
 */
export function schemaDiff(schema: z.ZodType, body: unknown): string[] {
  const result = schema.safeParse(body);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const path = issue.path.map((segment) => (typeof segment === 'number' ? '[]' : `.${String(segment)}`)).join('');
    return `${path ? path.replace(/^\./, '') : '(root)'}: ${issue.message}`;
  });
}
