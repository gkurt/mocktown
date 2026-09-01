/**
 * The contract walk: one traversal that the CLI, the MCP server and the OpenAPI
 * generator all consume. Measured at 44 lines in spike 02, which is why we own it
 * instead of taking `orpc-mcp` (0.x, single maintainer) or `trpc-cli` (tRPC-only).
 *
 * Owning it is also what lets house rules be structural: `readOnlyHint` derived from the
 * HTTP method, `--json` on every command.
 */
import type * as z from 'zod/v4';

export interface ProcedureInfo {
  /** Dotted contract path, e.g. ["services", "list"]. */
  path: string[];
  method: string;
  /** OpenAPI-style route path, e.g. "/services/{id}". */
  route: string;
  summary?: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
}

/**
 * oRPC hangs the contract definition off a `~orpc` property. This is the single point of
 * coupling to oRPC internals in the whole walk — if it moves, exactly one function
 * changes and every generator is untouched.
 */
function procedureDef(node: unknown): any {
  const def = (node as any)?.['~orpc'];
  return def && 'route' in def && 'inputSchema' in def ? def : undefined;
}

export function walkContract(router: unknown, prefix: string[] = []): ProcedureInfo[] {
  const def = procedureDef(router);
  if (def) {
    return [
      {
        path: prefix,
        method: def.route?.method ?? 'POST',
        route: def.route?.path ?? `/${prefix.join('/')}`,
        summary: def.route?.summary,
        inputSchema: def.inputSchema,
        outputSchema: def.outputSchema,
      },
    ];
  }
  if (typeof router !== 'object' || router === null) return [];
  return Object.entries(router).flatMap(([key, child]) => walkContract(child, [...prefix, key]));
}

/** The raw Zod shape of a procedure's input — what MCP tools and CLI flags are built from. */
export function inputShape(schema: z.ZodType): Record<string, z.ZodType> | undefined {
  return (schema as any)?._zod?.def?.shape;
}

/**
 * The text `.describe()` put on a field.
 *
 * Zod 4 registers descriptions in `z.globalRegistry`, not on `_zod.def`, so reading the
 * def yields `undefined` for every field — which is how every generated CLI flag silently
 * lost its help text. `.description` is the accessor that survives that change.
 */
export function describedAs(node: unknown): string {
  return (node as any)?.description ?? '';
}

/**
 * The literal forms a union accepts, so a generated flag can document `generated:<name>`
 * instead of leaving the caller to discover it from a validation failure.
 */
export function choicesOf(node: unknown): string[] {
  const options: any[] = (node as any)?._zod?.def?.options ?? [];
  return options
    .map((option) => {
      const def = option?._zod?.def;
      if (def?.type === 'literal') return def.values?.map(String).join('|') ?? '';
      // A template literal's parts interleave strings and schemas; the schemas become
      // placeholders named for what they are, which is what a caller needs to see.
      if (def?.type === 'template_literal') {
        return (def.parts ?? []).map((part: any) => (typeof part === 'string' ? part : '<name>')).join('');
      }
      return '';
    })
    .filter(Boolean);
}

export interface FieldInfo {
  type: string;
  optional: boolean;
  description: string;
}

/** Unwrap `.optional()` / `.default()` so a generated flag reflects the value's real type. */
export function fieldInfo(field: z.ZodType): FieldInfo {
  let node: any = field;
  let optional = false;
  let description = describedAs(node);
  for (let depth = 0; depth < 8; depth++) {
    const def = node?._zod?.def;
    if (!def) break;
    description ||= describedAs(node);
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable' || def.type === 'pipe') {
      if (def.type !== 'pipe') optional = true;
      node = def.innerType ?? def.in ?? node;
      continue;
    }
    if (def.type === 'union') {
      const choices = choicesOf(node);
      if (choices.length) description = `${description ? `${description}. ` : ''}One of: ${choices.join(', ')}`;
    }
    return { type: def.type ?? 'string', optional, description };
  }
  return { type: 'string', optional, description };
}
