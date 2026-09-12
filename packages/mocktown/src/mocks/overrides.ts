/**
 * The overrides layer: corrections that survive the schema being regenerated.
 *
 * A correction used to live in the generated file, so the file could never be written again
 * and a service's schema froze at its first draft — routes recorded later never reached it.
 * Splitting gives each file one owner: `schema.ts` belongs to the corpus, `schema.overrides.ts`
 * to the author, written once and applied on top.
 *
 * An override is a function of the draft, not a schema copied out of it. A pasted replacement
 * pins every field of the route forever; a patch says only what the author knows and keeps
 * tracking the corpus for the rest.
 *
 * Route keys must exist in the draft — a type error, and a load-time failure naming the likely
 * rename. Path templating is a best effort (house rule 5), so a re-capture can promote
 * `/things/abc` to `/things/{thingId}`; an override left silently not applying would hand the
 * corpus back a line the author overruled.
 */
import * as z from 'zod/v4';

/** The default export of a `schema.ts`: response schemas by route, then by status. */
export type SchemaMap = Record<string, Record<number, z.ZodType>>;

export const SCHEMA_FILE = 'schema.ts';
export const OVERRIDES_FILE = 'schema.overrides.ts';

/**
 * The statuses an override may introduce. A mapped type cannot mix literal keys with an open
 * `number` index without collapsing to `number` and losing every precise schema type, so the
 * list is fixed — unioned with the draft's own keys, which keeps a nonstandard code the corpus
 * really caught (a 499, a 520) patchable without opening the door to `2000`.
 */
type HttpStatus =
  | 100
  | 101
  | 102
  | 103
  | 200
  | 201
  | 202
  | 203
  | 204
  | 205
  | 206
  | 207
  | 208
  | 226
  | 300
  | 301
  | 302
  | 303
  | 304
  | 305
  | 307
  | 308
  | 400
  | 401
  | 402
  | 403
  | 404
  | 405
  | 406
  | 407
  | 408
  | 409
  | 410
  | 411
  | 412
  | 413
  | 414
  | 415
  | 416
  | 417
  | 418
  | 421
  | 422
  | 423
  | 424
  | 425
  | 426
  | 428
  | 429
  | 431
  | 451
  | 500
  | 501
  | 502
  | 503
  | 504
  | 505
  | 506
  | 507
  | 508
  | 510
  | 511;

/**
 * How one status is overruled: a function of the drafted schema, or a schema outright. A status
 * the draft does not declare has no `current`, so that case gets `z.ZodType` alone.
 *
 * `Current` is unconstrained on purpose — it is only ever a parameter type, and a `z.ZodType`
 * bound makes the indexed access below unprovable for a generic base.
 */
export type SchemaPatch<Current = z.ZodType> = z.ZodType | ((current: Current) => z.ZodType);

type StatusPatches<Statuses extends Record<number, z.ZodType>> = {
  [Status in HttpStatus | keyof Statuses]?: Status extends keyof Statuses ? SchemaPatch<Statuses[Status & keyof Statuses]> : z.ZodType;
};

export type SchemaOverrides<Base extends SchemaMap> = {
  [Route in keyof Base]?: StatusPatches<Base[Route]>;
};

/*
 * No `defineSchemaOverrides()` helper to go with this, unlike `defineMock`: `satisfies
 * SchemaOverrides<typeof Schemas>` checks exactly as much and leaves the file with no runtime
 * import from mocktown. The daemon generates the file on the newest mocktown; it lands in an
 * app repo pinned to an older one, and a helper call would make it fail to import until that
 * repo bumped — for a file that is pure data. `retype` is the opt-in exception.
 *
 * The base is a type argument for a second reason: a value import of `./schema.ts` would be
 * baked in at first load (Bun's module cache keys on the specifier), so a schema regenerated
 * mid-session would not take effect until a restart. Mocktown loads both files itself.
 */

/**
 * One field deep inside a drafted schema, retyped — the shape most real corrections take.
 * `.extend()` reaches the top level and no further, but a scrubbed token count sits at
 * `data.messages[].parts[].providerMetadata.tokenUsage.inputTokens`, and the only other way to
 * reach it is to paste the whole route back.
 *
 * Paths use the vocabulary `--check` and verify failures already print, so the fix is the line
 * you were shown. `[]` descends into an array element, `{}` into a record value.
 *
 * Optionality and nullability are preserved: how often a field appeared is a fact about the
 * capture, not the type being corrected (`walkDrift` declines to compare it for the same
 * reason). A path that is not there throws rather than being ignored.
 */
export function retype<T extends z.ZodType>(schema: T, changes: Record<string, z.ZodType>): z.ZodType {
  let result: z.ZodType = schema;
  for (const [path, replacement] of Object.entries(changes)) result = replaceAt(result, steps(path), replacement, path);
  return result;
}

type Step = { kind: 'field'; name: string } | { kind: 'element' } | { kind: 'value' };

/** `data[].tokenUsage.inputTokens` -> field, element, field, field. */
function steps(path: string): Step[] {
  const parsed: Step[] = [];
  for (const segment of path.split('.')) {
    const name = segment.replace(/(\[\]|\{\})+$/, '');
    if (!name) throw new Error(`"${path}" is not a field path`);
    parsed.push({ kind: 'field', name });
    for (const marker of segment.slice(name.length).match(/\[\]|\{\}/g) ?? []) {
      parsed.push(marker === '[]' ? { kind: 'element' } : { kind: 'value' });
    }
  }
  return parsed;
}

const defOf = (schema: unknown): Record<string, unknown> | undefined => (schema as { _zod?: { def?: Record<string, unknown> } })?._zod?.def;

/** Wrappers peeled off, with the means to put them back. Only what the printer emits. */
function peel(schema: z.ZodType, path: string): { core: z.ZodType; wrap: (inner: z.ZodType) => z.ZodType } {
  const kind = defOf(schema)?.type;
  if (kind !== 'optional' && kind !== 'nullable') return { core: schema, wrap: (inner) => inner };
  const inner = peel(defOf(schema)!.innerType as z.ZodType, path);
  return { core: inner.core, wrap: (next) => (kind === 'optional' ? inner.wrap(next).optional() : inner.wrap(next).nullable()) };
}

function replaceAt(schema: z.ZodType, remaining: Step[], replacement: z.ZodType, path: string): z.ZodType {
  const { core, wrap } = peel(schema, path);
  const [step, ...rest] = remaining;
  if (!step) return wrap(replacement);

  const def = defOf(core);
  const kind = def?.type;

  if (step.kind === 'field') {
    if (kind !== 'object' && kind !== 'interface')
      throw new Error(`"${path}": expected an object at "${step.name}", found ${kind ?? 'nothing'}`);
    const shape = def!.shape as Record<string, z.ZodType>;
    const child = shape[step.name];
    if (!child) throw new Error(`"${path}": the schema has no "${step.name}" here`);
    return wrap((core as z.ZodObject).extend({ [step.name]: replaceAt(child, rest, replacement, path) }));
  }
  if (step.kind === 'element') {
    if (kind !== 'array') throw new Error(`"${path}": [] needs an array here, found ${kind ?? 'nothing'}`);
    return wrap(z.array(replaceAt(def!.element as z.ZodType, rest, replacement, path)));
  }
  if (kind !== 'record' && kind !== 'map') throw new Error(`"${path}": {} needs a record here, found ${kind ?? 'nothing'}`);
  // The printer only ever emits `z.record(z.string(), …)`, so the key schema is a string one.
  return wrap(z.record(def!.keyType as z.ZodString, replaceAt(def!.valueType as z.ZodType, rest, replacement, path)));
}

export interface ResolvedSchemas {
  schemas: SchemaMap;
  /** `"<route> <status>"` for every entry an override decided, for drift to stay honest about. */
  overridden: Set<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

/** Zod by duck type: a workspace with a second copy of Zod should still work. */
const isZodType = (value: unknown): value is z.ZodType =>
  isRecord(value) && '_zod' in value && typeof (value as { safeParse?: unknown }).safeParse === 'function';

/** `GET /things/abc` against `GET /things/{thingId}` — equal once parameters are wildcards. */
function sameShape(a: string, b: string): boolean {
  const segments = (route: string) => route.split('/').map((part) => (part.startsWith('{') && part.endsWith('}') ? '*' : part));
  const left = segments(a);
  const right = segments(b);
  if (left.length !== right.length) return false;
  return left.every((part, index) => part === right[index] || part === '*' || right[index] === '*');
}

/** The route the author probably meant. Ambiguity gets no guess — two named renames help nobody. */
function nearestRoute(base: SchemaMap, route: string): string | null {
  const candidates = Object.keys(base).filter((known) => sameShape(known, route));
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * The drafted schemas with the author's corrections applied. `base` is never mutated —
 * `mocks schema --check` diffs against it and must keep seeing what the corpus said.
 */
export function applyOverrides(base: SchemaMap, overrides: unknown, file: string): ResolvedSchemas {
  if (!isRecord(overrides)) {
    throw new Error(`${file} must default-export the result of defineSchemaOverrides(); it exports ${typeof overrides}`);
  }

  const schemas: SchemaMap = {};
  for (const [route, statuses] of Object.entries(base)) schemas[route] = { ...statuses };
  const overridden = new Set<string>();

  for (const [route, patches] of Object.entries(overrides)) {
    const current = schemas[route];
    if (!current) {
      const near = nearestRoute(base, route);
      throw new Error(
        `${file} overrides "${route}", which ${SCHEMA_FILE} does not declare` +
          (near ? ` — did the route become "${near}"?` : '. Check the route against the drafted schema.'),
      );
    }
    if (!isRecord(patches)) throw new Error(`${file}: the override for "${route}" must be an object keyed by status code`);

    for (const [status, patch] of Object.entries(patches)) {
      const code = Number(status);
      if (!Number.isInteger(code)) throw new Error(`${file}: "${status}" is not a status code (in the override for "${route}")`);

      const drafted = current[code];
      let resolved: unknown = patch;
      if (typeof patch === 'function') {
        if (!drafted) {
          throw new Error(
            `${file} patches "${route}" ${code} with a function, but the draft declares no ${code} for that route. ` +
              'A status the corpus never caught has nothing to patch — declare it with a schema instead.',
          );
        }
        resolved = (patch as (schema: z.ZodType) => unknown)(drafted);
        if (!isZodType(resolved)) throw new Error(`${file}: the patch for "${route}" ${code} returned ${typeof resolved}, not a schema`);
      } else if (!isZodType(patch)) {
        throw new Error(`${file}: the override for "${route}" ${code} must be a Zod schema or a function returning one`);
      }

      current[code] = resolved as z.ZodType;
      overridden.add(`${route} ${code}`);
    }
  }

  return { schemas, overridden };
}

/**
 * The starter, written empty alongside a freshly drafted schema. Its existence is what makes
 * `schema.ts` regenerable, so leaving the author to create it would freeze the schema again.
 */
export function renderOverridesModule(service: string): string {
  return `/**
 * Corrections to the drafted response schemas for \`${service}\`.
 *
 * \`${SCHEMA_FILE}\` is rewritten from the recordings on every run, so an edit there is gone at
 * the next capture. This file is written once and applied on top of whatever it last drafted.
 *
 *   'GET /v1/things/{thingId}': {
 *     200: (current) => current.extend({ count: z.number() }),  // a top-level field
 *     201: (current) => retype(current, {                       // ...or one at any depth
 *       'data.items[].tokenUsage.inputTokens': z.number(),
 *     }),
 *     404: z.object({ Error: z.string() }),                     // replace a drafted body
 *     500: z.object({ Error: z.string() }),                     // a status the corpus never caught
 *   },
 *
 * Prefer the first two: a patch keeps tracking the corpus for every field it does not name.
 * \`retype\` takes the paths \`--check\` and verify failures already print. Say why on the line —
 * \`--check\` reports the difference for as long as the correction stands.
 *
 * A route key that no longer exists fails to load, naming the likely rename.
 * Import \`z\` and \`retype\` from \`mocktown/mock\`.
 */
import type { SchemaOverrides } from 'mocktown/mock';
import type Schemas from './${SCHEMA_FILE}';

export default {} satisfies SchemaOverrides<typeof Schemas>;
`;
}
