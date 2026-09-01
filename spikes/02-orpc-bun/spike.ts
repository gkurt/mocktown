/**
 * Phase 0 / Spike 02 — oRPC on Bun.
 *
 * Question (docs/design/02-architecture.md): can oRPC's OpenAPIHandler + static file
 * serving run on `Bun.serve` with no web framework, and can one contract really drive
 * three surfaces — HTTP API, CLI, and MCP — including the generation path (existing
 * adapters vs. "worst case … a couple hundred lines we own")?
 *
 *   bun run spike.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { contract } from './contract.ts';
import { buildMcpServer } from './mcp.ts';
import { openapi, startServer } from './server.ts';
import { walkContract } from './walk.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

const TOKEN = 'spike-session-token';
const server = startServer(0, TOKEN);
const BASE = `http://127.0.0.1:${server.port}/api/v1`;
const authed = { authorization: `Bearer ${TOKEN}` };

// ── 1. OpenAPIHandler on Bun.serve, GET with query params ─────────────────────
{
  const res = await fetch(`${BASE}/services?project=acme-api`, { headers: authed });
  const body: any = await res.json();
  check(
    'OpenAPIHandler on Bun.serve (GET)',
    res.status === 200 && body.services?.length > 0,
    `status=${res.status} services=${body.services?.length}`,
  );
}

// ── 2. PUT with a path parameter and a JSON body ──────────────────────────────
{
  const res = await fetch(`${BASE}/services/api.slack.com`, {
    method: 'PUT',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'acme-api', provider: 'emulator:slack' }),
  });
  const body: any = await res.json();
  check(
    'PUT with path param + body',
    res.status === 200 && body.service?.provider === 'emulator:slack',
    `status=${res.status} provider=${body.service?.provider}`,
  );
}

// ── 3. Server-side validation from the same Zod schema ────────────────────────
{
  const res = await fetch(`${BASE}/services/x`, {
    method: 'PUT',
    headers: { ...authed, 'content-type': 'application/json' },
    body: JSON.stringify({ project: 'acme-api', provider: 'not-a-valid-provider' }),
  });
  check('Contract validation rejects bad input', res.status === 400, `status=${res.status}`);
}

// ── 4. Static GUI files from the same Bun.serve, no framework ─────────────────
{
  const res = await fetch(`http://127.0.0.1:${server.port}/`);
  const html = await res.text();
  check(
    'Static files on the same server',
    res.status === 200 && html.includes('Mocktown GUI shell'),
    `status=${res.status} bytes=${html.length}`,
  );
}

// ── 5. Bearer token enforced (10-security.md) ─────────────────────────────────
{
  const res = await fetch(`${BASE}/services?project=acme-api`);
  check('Bearer token required on /api', res.status === 401, `unauthenticated status=${res.status}`);
}

// ── 6. OpenAPI document generated from the contract ───────────────────────────
{
  const paths = Object.keys((openapi as any).paths ?? {});
  const getParams = (openapi as any).paths?.['/services']?.get?.parameters?.map((p: any) => p.name) ?? [];
  check(
    'OpenAPI generated from contract',
    paths.includes('/services') && paths.includes('/services/{id}') && getParams.includes('project'),
    `paths=[${paths.join(', ')}] /services params=[${getParams.join(',')}]`,
  );
}

// ── 7. Typed client round-trip ────────────────────────────────────────────────
{
  const client: any = createORPCClient(
    new OpenAPILink(contract, {
      url: BASE,
      headers: () => authed,
    }),
  );
  const out = await client.services.list({ project: 'acme-api' });
  check('Typed oRPC client round-trip', out.project === 'acme-api' && Array.isArray(out.services), `services=${out.services.length}`);
}

// ── 8. The contract walk finds every procedure ────────────────────────────────
{
  const procs = walkContract(contract);
  check(
    'Contract walk enumerates procedures',
    procs.length === 2 && procs.every((p) => p.inputSchema && p.route),
    procs.map((p) => `${p.path.join('.')}=${p.method} ${p.route}`).join('  '),
  );
}

// ── 9. CLI generated from the contract (spawned as a real process) ────────────
{
  const proc = Bun.spawn(['bun', 'run', 'cli.ts', 'services', 'list', '--project', 'acme-api', '--json'], {
    env: { ...process.env, MOCKTOWN_API: BASE, MOCKTOWN_TOKEN: TOKEN },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  let ok = false,
    detail = stderr.trim().slice(0, 90);
  try {
    const parsed = JSON.parse(stdout.trim());
    ok = parsed.project === 'acme-api';
    detail = `${parsed.services.length} services`;
  } catch {}
  check('CLI generated from the contract', ok, detail);
}

// ── 10. MCP tools generated from the same walk ────────────────────────────────
{
  const mcp = buildMcpServer(BASE, () => authed);
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'spike', version: '0' });
  await Promise.all([mcp.connect(st), client.connect(ct)]);
  const { tools } = await client.listTools();
  const listTool = tools.find((t) => t.name === 'services_list');
  const called = await client.callTool({ name: 'services_list', arguments: { project: 'acme-api' } });
  const payload = JSON.parse((called.content as any)[0].text);
  check(
    'MCP server generated from the contract',
    tools.length === 2 && listTool?.annotations?.readOnlyHint === true && payload.services.length > 0,
    `tools=[${tools.map((t) => t.name).join(',')}] readOnlyHint respected`,
  );
  await client.close();
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n  runtime: bun ${Bun.version}`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`  ${results.length - failed}/${results.length} passed\n`);
server.stop();
process.exit(failed ? 1 : 0);
