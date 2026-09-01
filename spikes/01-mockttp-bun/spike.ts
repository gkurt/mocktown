/**
 * Phase 0 / Spike 01 — Mockttp under Bun.
 *
 * Question (docs/design/02-architecture.md): "Must be validated against Bun's
 * node-compat early (it uses Node http internals) — this is a phase-0 spike, with
 * Node-as-sidecar the fallback if Bun compat fails."
 *
 * Run under both runtimes and compare:
 *   bun  run spike.ts
 *   node spike.ts
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { promisify } from 'node:util';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as mockttp from 'mockttp';
import { generateCACertificate } from 'mockttp';

const execFileP = promisify(execFile);
const RUNTIME = typeof (globalThis as any).Bun !== 'undefined' ? 'bun' : 'node';

const results: { name: string; ok: boolean; detail: string }[] = [];
function report() {
  console.log(`\n  runtime: ${RUNTIME} ${RUNTIME === 'bun' ? (globalThis as any).Bun.version : process.version}`);
  for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(38)} ${r.detail}`);
  const f = results.filter((r) => !r.ok).length;
  console.log(`  ${results.length - f}/${results.length} passed\n`);
}
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });
// ONLY=3 runs just test 3; SKIP=5 omits test 5. Both exist because test 5 (WebSockets)
// crashes the Bun process outright when run after the others — see FINDINGS.md.
const ONLY = process.env.ONLY ? Number(process.env.ONLY) : null;
const SKIP = new Set((process.env.SKIP ?? '').split(',').filter(Boolean).map(Number));
let testNo = 0;
const skip = () => {
  testNo++;
  return (ONLY !== null && ONLY !== testNo) || SKIP.has(testNo);
};

mkdirSync('out', { recursive: true });

// Watchdog: a failing WebSocket proxy leaves Mockttp holding the connection open under
// Bun, so the process would otherwise never reach the report.
const watchdog = setTimeout(() => {
  console.log('\n  WATCHDOG: run exceeded 100s — printing partial results');
  report();
  process.exit(1);
}, 100_000);
watchdog.unref?.();

// ── A local HTTPS + WebSocket upstream, so the WS and mock tests don't depend on
//    the public internet (the passthrough/h2 tests deliberately do use it).
const upstreamCert = await generateCACertificate({ subject: { commonName: 'localhost' } });
writeFileSync('out/upstream.pem', upstreamCert.cert);
writeFileSync('out/upstream.key', upstreamCert.key, { mode: 0o600 });
const upstream = https.createServer({ cert: upstreamCert.cert, key: upstreamCert.key }, (req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ upstream: true, path: req.url }));
});
await new Promise<void>((r) => upstream.listen(9443, '127.0.0.1', r));

// ── The front door, as Mocktown would configure it.
const ca = await generateCACertificate({ subject: { commonName: 'Mocktown Spike CA' } });
writeFileSync('out/ca.pem', ca.cert);

const proxy = mockttp.getLocal({
  https: { cert: ca.cert, key: ca.key },
  http2: true, // front door must speak h2 to clients (03-capture.md defers only h3/QUIC)
});
await proxy.start(8123);

const observed: { method: string; url: string; httpVersion: string }[] = [];
proxy.on('request', (r) => observed.push({ method: r.method, url: r.url, httpVersion: r.httpVersion }));

// Route by hostname, exactly as the design's front door does (03-capture.md).
await proxy.forGet('https://mocked.example/api/orders').thenJson(200, { id: 'ord_1', mocked: true });
// The local upstream uses a self-signed cert; trust it for this spike only.
await proxy.forAnyRequest().thenPassThrough({ ignoreHostHttpsErrors: ['localhost', '127.0.0.1'] });
// WebSockets are matched by a separate rule family in Mockttp; recording them is in
// scope for phase 1, mocking them is deferred (03-capture.md).
await proxy.forAnyWebSocket().thenPassThrough({ ignoreHostHttpsErrors: ['localhost', '127.0.0.1'] });

const PROXY = 'http://127.0.0.1:8123';

// ── 1. HTTPS MITM, HTTP/1.1, real upstream ────────────────────────────────────
if (!skip())
  try {
    const { stdout } = await execFileP('curl', [
      '-sS',
      '--max-time',
      '15',
      '--proxy',
      PROXY,
      '--cacert',
      'out/ca.pem',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code} %{http_version}',
      'https://example.com',
    ]);
    const [code, ver] = stdout.trim().split(' ');
    check('HTTPS MITM (h1.1, real upstream)', code === '200', `status=${code} clientHttpVersion=${ver}`);
  } catch (e: any) {
    check('HTTPS MITM (h1.1, real upstream)', false, e.message?.slice(0, 160));
  }

// ── 2. HTTP/2 client through the MITM ─────────────────────────────────────────
if (!skip())
  try {
    const { stdout } = await execFileP('curl', [
      '-sS',
      '--http2',
      '--max-time',
      '15',
      '--proxy',
      PROXY,
      '--cacert',
      'out/ca.pem',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code} %{http_version}',
      'https://cloudflare.com',
    ]);
    const [code, ver] = stdout.trim().split(' ');
    const seenH2 = observed.some((o) => o.url.includes('cloudflare.com') && o.httpVersion === '2.0');
    check(
      'HTTP/2 client through MITM',
      ver === '2' && seenH2,
      `clientHttpVersion=${ver} status=${code} proxyObservedVersion=${observed.find((o) => o.url.includes('cloudflare'))?.httpVersion}`,
    );
  } catch (e: any) {
    check('HTTP/2 client through MITM', false, e.message?.slice(0, 160));
  }

// ── 3. Mock rule served for an unresolvable hostname (the sealed-mode case) ────
if (!skip())
  try {
    const agent = new HttpsProxyAgent(PROXY, { ca: ca.cert } as any);
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request({ host: 'mocked.example', path: '/api/orders', agent, ca: [ca.cert] } as any, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve(`${res.statusCode} ${b}`));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
      req.end();
    });
    check('Mock served for non-existent host', body.includes(`"mocked":true`), body);
  } catch (e: any) {
    check('Mock served for non-existent host', false, e.message?.slice(0, 160));
  }

// ── 4. Bun/Node's own fetch honouring the proxy (the daemon's own client) ──────
if (!skip())
  try {
    const opts: any = { ca: ca.cert };
    const agent = new HttpsProxyAgent(PROXY, opts);
    const body = await new Promise<string>((resolve, reject) => {
      const req = https.request({ host: 'localhost', port: 9443, path: '/ping', agent, rejectUnauthorized: false } as any, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve(`${res.statusCode} ${b}`));
      });
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
      req.end();
    });
    check('Passthrough to local TLS upstream', body.includes(`"upstream":true`), body);
  } catch (e: any) {
    check('Passthrough to local TLS upstream', false, e.message?.slice(0, 160));
  }

// ── 5. WebSockets over TLS through the MITM ───────────────────────────────────
// Client and upstream run under Node on purpose: Bun ships its own `ws` shim whose
// client ignores `agent`/`rejectUnauthorized`, so a Bun-side client would be testing
// Bun's WebSocket rather than the front door. See FINDINGS.md.
if (!skip())
  try {
    const { stdout } = await execFileP('node', ['ws-client-check.mjs', PROXY, 'out/ca.pem', '9444'], { timeout: 30000 });
    const { result } = JSON.parse(stdout.trim().split('\n').pop()!);
    check('WebSocket over TLS through MITM', result === 'echo:ping', `echoed=${JSON.stringify(result)}`);
  } catch (e: any) {
    check('WebSocket over TLS through MITM', false, (e.message ?? String(e)).slice(0, 160));
  }

// ── 6. Plain HTTP through the same port (the front door is one port) ──────────
if (!skip())
  try {
    const body = await new Promise<string>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: 8123, path: 'http://example.com/', method: 'GET', headers: { host: 'example.com' } },
        (res) => {
          res.resume();
          res.on('end', () => resolve(String(res.statusCode)));
        },
      );
      req.on('error', reject);
      req.setTimeout(10000, () => req.destroy(new Error('timeout')));
      req.end();
    });
    check('Plain HTTP proxying on the same port', body === '200', `status=${body}`);
  } catch (e: any) {
    check('Plain HTTP proxying on the same port', false, e.message?.slice(0, 160));
  }

// ── Report ────────────────────────────────────────────────────────────────────
clearTimeout(watchdog);
report();
const failed = results.filter((r) => !r.ok).length;

await proxy.stop();
upstream.close();
process.exit(failed ? 1 : 0);
