/**
 * Commander gives strings; the contract wants the declared type.
 *
 * Its own module rather than the CLI entry point's, because the entry point parses `argv`
 * as a side effect of being imported — so nothing else, a test included, could reach this.
 */
import type * as z from 'zod/v4';
import { fieldInfo, inputShape } from '#src/contract/walk.ts';

/** `recordOverride` -> `--record-override`, the flag name a generated option carries. */
export const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

/** The type inside a `string[]`, looking through the `.optional()` / `.default()` wrappers. */
function elementType(field: z.ZodType): string | null {
  let node: any = field;
  for (let depth = 0; depth < 8; depth++) {
    const def = node?._zod?.def;
    if (!def) return null;
    if (def.type === 'array') return def.element?._zod?.def?.type ?? null;
    node = def.innerType ?? def.in;
    if (!node) return null;
  }
  return null;
}

/**
 * A nested flag's value, as JSON — with one concession.
 *
 * A list of strings is usually a list of one, and making someone write
 * `--aliases '["app.example.com"]'` to say a single hostname is a tax with nothing behind
 * it. A bare value becomes a one-element list. Splitting on commas would be the obvious
 * next step and is wrong: `--flows` carries shell commands, and those contain commas.
 */
function parseNested(name: string, value: string, element: string | null): unknown {
  const wrap = (parsed: unknown) => (element && !Array.isArray(parsed) ? [parsed] : parsed);
  try {
    return wrap(JSON.parse(value));
  } catch {
    if (element === 'string') return [value];
    // The parser's own message names a character offset in a string the caller cannot see.
    throw new Error(`--${kebab(name)} takes JSON, and ${JSON.stringify(value)} is not. For a list, write it as '["a","b"]'.`);
  }
}

/** Commander gives strings; the contract wants the declared type. */
// Exported for the surfaces test: the coercion is a house rule, so something has to hold it.
export function coerceInput(schema: z.ZodType, options: Record<string, unknown>): Record<string, unknown> {
  const shape = inputShape(schema);
  if (!shape) return options;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options)) {
    const field = shape[name];
    if (value === undefined || !field) continue;
    const { type } = fieldInfo(field);
    if (type === 'object' || type === 'record' || type === 'array') {
      // Nested inputs (seed editors, knob values, profile credentials) arrive as JSON on
      // one flag — spike 02 flagged this as the open question; JSON is the honest answer.
      out[name] = typeof value === 'string' ? parseNested(name, value, type === 'array' ? elementType(field) : null) : value;
    } else if (type === 'number' || type === 'int') {
      out[name] = typeof value === 'string' ? Number(value) : value;
    } else {
      out[name] = value;
    }
  }
  return out;
}
