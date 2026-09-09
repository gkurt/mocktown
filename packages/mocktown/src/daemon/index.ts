#!/usr/bin/env bun
/**
 * The daemon process. One long-running server owns all logic and exposes a local
 * HTTP/JSON API (02-architecture.md); every other surface is a client of it.
 *
 *   bun src/daemon/index.ts [--port <n>]
 */
import { removeOwnDaemonState } from '#src/config/daemon.ts';
import { shutdownAllRuntimes } from '#src/daemon/runtime.ts';
import { startDaemon } from '#src/daemon/server.ts';

const portArg = process.argv.indexOf('--port');
const port = portArg !== -1 ? Number(process.argv[portArg + 1]) : undefined;

const daemon = await startDaemon({ port });
console.log(JSON.stringify({ ready: true, port: daemon.port, url: daemon.url }));

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  // Providers are child processes and the front door is a Node sidecar; leaving either
  // running would leave a MITM proxy holding a developer's traffic with nothing driving it.
  await shutdownAllRuntimes();
  await daemon.stop();
  // Only if the registration is still ours: an orphan daemon from an earlier shell shares
  // this file with the one that wrote it last, and unlinking blind on the way out deletes a
  // live daemon's registration — leaving it running with no client able to find it.
  removeOwnDaemonState();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
