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
