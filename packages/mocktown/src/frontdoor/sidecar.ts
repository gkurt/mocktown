/**
 * The front door's Node half — 02-architecture.md's sidecar decision.
 *
 * Mockttp under Bun loses HTTP/2 and WebSockets and can segfault on the WebSocket path;
 * none of it is fixable from userland (spike 01). So the proxy runs on Node while
 * everything else stays on Bun, and the daemon drives it over Mockttp's own admin-server
 * protocol — a supported configuration, not a workaround.
 *
 * This process owns nothing but the admin server: no disk, no database, no policy. All
 * routing decisions and every byte that gets persisted are the daemon's, which is what
 * keeps "scrub before disk" (10-security.md) true across the process boundary.
 *
 *   node src/frontdoor/sidecar.ts <adminPort>
 */
import * as mockttp from 'mockttp';

// `bun run` puts a `node` on PATH that is Bun in disguise when no Node is installed, so
// the sidecar would come up on the runtime it exists to avoid — and pass every test that
// stays off the HTTP/2 and WebSocket paths. Refusing here keeps the failure loud.
if (process.versions.bun) {
  console.error(
    'front door sidecar: `node` resolved to Bun (bun run shims it when Node is not installed). ' +
      'The proxy must run on real Node; install one on PATH or set MOCKTOWN_NODE to its path.',
  );
  process.exit(3);
}

const adminPort = Number(process.argv[2]);
if (!Number.isInteger(adminPort) || adminPort <= 0) {
  console.error('usage: node sidecar <adminPort>');
  process.exit(2);
}

const admin = mockttp.getAdminServer({});
await admin.start({ port: adminPort, host: '127.0.0.1' });

// The daemon waits for this line rather than for the process to look alive: a child's
// stdout is evidence of intent, not of readiness (spike 03), so we print it only once
// the admin server is actually listening.
console.log(JSON.stringify({ ready: true, adminPort }));

let stopping = false;
async function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  try {
    await admin.stop();
  } catch {
    /* the daemon is going away regardless */
  }
  process.exit(signal === 'SIGTERM' || signal === 'SIGINT' ? 0 : 1);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
// If the daemon dies without stopping us, its stdin pipe closes and we follow it down —
// an orphaned MITM proxy holding a developer's traffic is the failure to avoid.
process.stdin.on('close', () => void shutdown('parent-gone'));
process.stdin.resume();
