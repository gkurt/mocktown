/**
 * The contract walk: one traversal that both the CLI and the MCP server consume.
 *
 * 02-architecture.md budgeted "worst case … a couple hundred lines we own" for this.
 * This file is the measurement.
 */
import type * as z from 'zod/v4';

export interface ProcedureInfo {
  /** Dotted contract path, e.g. "services.list" */
  path: string[];
  method: string;
  /** OpenAPI-style route path, e.g. "/services/{id}" */
  route: string;
  summary?: string;
  inputSchema: z.ZodType;
  outputSchema?: z.ZodType;
}

/**
 * oRPC hangs the contract definition off a `~orpc` property. This is the single
 * point of coupling to oRPC internals in the whole walk — if it ever moves, exactly
 * one function needs updating and the CLI/MCP generators are untouched.
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
