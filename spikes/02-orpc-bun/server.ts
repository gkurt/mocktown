/**
 * The daemon's HTTP surface: oRPC's OpenAPIHandler plus static file serving, both on
 * one `Bun.serve` — no web framework, as decided in 02-architecture.md.
 */

import { OpenAPIGenerator } from '@orpc/openapi';
import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { implement } from '@orpc/server';
import { ZodToJsonSchemaConverter } from '@orpc/zod/zod4';
import { file } from 'bun';
import { contract, type Service } from './contract.ts';

// ── An in-memory stand-in for the project's SQLite registry ───────────────────
const registry = new Map<string, Service>([
  [
    'api.stripe.com',
    { id: 'api.stripe.com', provider: 'emulator:stripe', seed: 'seeds/stripe.yaml', lastSeenAt: '2026-08-30T09:14:00.000Z' },
  ],
  ['api.github.com', { id: 'api.github.com', provider: 'emulator:github', lastSeenAt: '2026-08-30T11:02:00.000Z' }],
  ['internal-billing.acme', { id: 'internal-billing.acme', provider: 'generated:billing', lastSeenAt: null }],
  ['telemetry.acme', { id: 'telemetry.acme', provider: 'passthrough', lastSeenAt: '2026-08-31T07:41:00.000Z' }],
]);

// ── Implementation, typed against the contract ────────────────────────────────
const os = implement(contract);

export const router = os.router({
  services: {
    list: os.services.list.handler(({ input }) => ({
      project: input.project,
      services: [...registry.values()].filter((s) => !input.provider || s.provider === input.provider),
    })),
    set: os.services.set.handler(({ input }) => {
      const service: Service = {
        id: input.id,
        provider: input.provider,
        ...(input.seed !== undefined ? { seed: input.seed } : {}),
        lastSeenAt: registry.get(input.id)?.lastSeenAt ?? null,
      };
      registry.set(input.id, service);
      return { project: input.project, service };
    }),
  },
});

// ── One handler, mounted under the versioned API prefix ───────────────────────
const handler = new OpenAPIHandler(router);
const openapi = await new OpenAPIGenerator({ schemaConverters: [new ZodToJsonSchemaConverter()] }).generate(contract, {
  info: { title: 'Mocktown daemon API', version: '1' },
  servers: [{ url: '/api/v1' }],
});

export function startServer(port = 0, token?: string) {
  return Bun.serve({
    port,
    hostname: '127.0.0.1', // 10-security.md: the daemon API never leaves loopback
    async fetch(request) {
      const url = new URL(request.url);

      // 10-security.md: a per-session bearer token, so other local users and drive-by
      // browser requests to localhost can't drive the daemon.
      if (token && url.pathname.startsWith('/api/') && url.pathname !== '/api/v1/openapi.json') {
        if (request.headers.get('authorization') !== `Bearer ${token}`) {
          return Response.json({ error: 'unauthorized' }, { status: 401 });
        }
      }

      // Free agent-facing documentation, straight off the contract (02-architecture.md).
      if (url.pathname === '/api/v1/openapi.json') {
        return Response.json(openapi);
      }

      const { matched, response } = await handler.handle(request, { prefix: '/api/v1' });
      if (matched) return response;

      // Static GUI files on the same server — no second process, no framework.
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      const asset = file(`./public${path}`);
      if (await asset.exists()) return new Response(asset);

      return new Response('Not found', { status: 404 });
    },
  });
}

export { openapi };
