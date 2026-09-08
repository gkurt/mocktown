/**
 * The project's knobs, derived from the schema that already defines them.
 *
 * `mocktown.json` had no surface but a text editor: every option existed only as a Zod
 * field with a `.describe()` nobody could read without opening the source. Enumerating them
 * by hand somewhere else would have been a second list to keep in sync, and the one thing
 * guaranteed about a hand-kept mirror of a schema is that it drifts. So the schema is the
 * list — add a field to `ProjectFile` and it appears in `mocktown config` and in the GUI
 * with its description, its type and its default, with no further work.
 *
 * Values travel as JSON text rather than as a union. `--value true` and `--value '"prod"'`
 * are unambiguous through a CLI flag, an HTTP body and a form field alike, which a bare
 * string is not: it cannot tell `false` the boolean from `"false"` the string.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type * as z from 'zod/v4';
import { ProjectFile } from '#src/config/schema.ts';
import { choicesOf, describedAs, inputShape } from '#src/contract/walk.ts';

export interface Setting {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'string[]';
  description: string;
  /** JSON text: `true`, `24`, `"localhost"`, `null`, `["a","b"]`. */
  value: string;
  default: string;
  choices: string[];
}

/**
 * Not every field is a knob. `project` is identity — renaming it in place would orphan the
 * data directory rather than rename anything. `services` has its own screen and its own
 * command. `scrub.rules` is a list of objects: a form field cannot express one, and pretending
 * otherwise would offer an edit that always fails validation.
 */
const NOT_A_KNOB = new Set(['project', 'services', 'scrub.rules']);

interface Unwrapped {
  node: any;
  type: string;
  defaultValue: unknown;
  hasDefault: boolean;
}

function unwrap(field: z.ZodType): Unwrapped {
  let node: any = field;
  let defaultValue: unknown;
  let hasDefault = false;
  for (let depth = 0; depth < 8; depth++) {
    const def = node?._zod?.def;
    if (!def) break;
    if (def.type === 'default') {
      hasDefault = true;
      defaultValue = typeof def.defaultValue === 'function' ? def.defaultValue() : def.defaultValue;
      node = def.innerType;
      continue;
    }
    if (def.type === 'optional' || def.type === 'nullable' || def.type === 'pipe') {
      node = def.innerType ?? def.in ?? node;
      continue;
    }
    return { node, type: def.type ?? 'string', defaultValue, hasDefault };
  }
  return { node, type: 'string', defaultValue, hasDefault };
}

function leafType(u: Unwrapped): Setting['type'] | null {
  if (u.type === 'boolean') return 'boolean';
  if (u.type === 'number' || u.type === 'int') return 'number';
  if (u.type === 'string' || u.type === 'union' || u.type === 'literal' || u.type === 'enum') return 'string';
  if (u.type === 'array') {
    const element = unwrap(u.node?._zod?.def?.element);
    return element.type === 'string' ? 'string[]' : null;
  }
  return null;
}

function at(source: unknown, key: string): unknown {
  return key.split('.').reduce<any>((node, part) => (node == null ? undefined : node[part]), source);
}

/**
 * One level of nesting is deliberate: every knob in `ProjectFile` is either top-level or
 * lives in a named group, and a general recursion would descend into `services`' record of
 * arbitrary hostnames and emit a "setting" per service.
 */
function walk(shape: Record<string, z.ZodType>, prefix: string[], current: unknown, out: Setting[]): void {
  for (const [name, field] of Object.entries(shape)) {
    const key = [...prefix, name].join('.');
    if (NOT_A_KNOB.has(key)) continue;

    const unwrapped = unwrap(field);
    if (unwrapped.type === 'object' && prefix.length === 0) {
      const inner = inputShape(unwrapped.node);
      if (inner) walk(inner, [name], at(current, name), out);
      continue;
    }

    const type = leafType(unwrapped);
    // Silently skipping a shape no form can render is right; claiming to edit one is not.
    if (!type) continue;

    const value = at(current, name);
    out.push({
      key,
      type,
      description: describedAs(field) || describedAs(unwrapped.node),
      value: JSON.stringify(value === undefined ? (unwrapped.hasDefault ? unwrapped.defaultValue : null) : value),
      default: JSON.stringify(unwrapped.hasDefault ? unwrapped.defaultValue : null),
      choices: choicesOf(unwrapped.node),
    });
  }
}

/** Every editable knob, with the value this project currently has for it. */
export function settingsOf(file: unknown): Setting[] {
  const out: Setting[] = [];
  walk(inputShape(ProjectFile) ?? {}, [], file ?? {}, out);
  return out;
}

/**
 * Write one knob back to `mocktown.json`.
 *
 * The file is re-read rather than serialised from the parsed config, so a comment-free
 * round trip does not quietly rewrite keys the caller never touched — and, more to the
 * point, so a field a *newer* mocktown wrote is not dropped by an older one parsing it away.
 */
export function writeSetting(projectFile: string, key: string, valueJson: string): Setting[] {
  const known = new Map(settingsOf(null).map((setting) => [setting.key, setting]));
  const setting = known.get(key);
  if (!setting) throw new Error(`"${key}" is not a setting. \`mocktown config get\` lists them.`);

  let value: unknown;
  try {
    value = JSON.parse(valueJson);
  } catch {
    throw new Error(`--value must be JSON: ${JSON.stringify(valueJson)} is not. A string needs its quotes, as in '"localhost"'.`);
  }

  const raw = existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')) : {};
  const path = key.split('.');
  const leaf = path.pop()!;
  let node = raw;
  for (const part of path) node = node[part] ??= {};
  node[leaf] = value;

  // Validated before it lands: a config file that will not parse takes every command with
  // it, including the one that would put it right.
  const parsed = ProjectFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${key} rejected: ${parsed.error.issues.map((i) => i.message).join('; ')}`);

  writeFileSync(projectFile, `${JSON.stringify(raw, null, 2)}\n`);
  return settingsOf(parsed.data);
}
