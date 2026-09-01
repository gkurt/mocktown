/**
 * A long-running daemon for poking at by hand:
 *   bun run serve.ts
 *   MOCKTOWN_API=http://127.0.0.1:4499/api/v1 MOCKTOWN_TOKEN=<token> bun run cli.ts services list --project acme-api
 */
import { startServer } from './server.ts';

const token = 'spike-session-token';
const s = startServer(4499, token);
console.log(`listening on http://127.0.0.1:${s.port}`);
console.log(`  api:     http://127.0.0.1:${s.port}/api/v1  (Authorization: Bearer ${token})`);
console.log(`  openapi: http://127.0.0.1:${s.port}/api/v1/openapi.json  (unauthenticated, it's just docs)`);
console.log(`  gui:     http://127.0.0.1:${s.port}/`);
