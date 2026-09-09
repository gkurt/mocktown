/**
 * How every client reaches the daemon.
 *
 * The CLI, the MCP server and the GUI all go through `OpenAPILink` against the same HTTP
 * surface — none of them imports the router. That keeps 02-architecture.md's "no client
 * has privileged access to anything" structural rather than aspirational (spike 02's
 * first implementation note).
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { isDaemonListening, readDaemonState } from '#src/config/daemon.ts';
import { contract } from '#src/contract/index.ts';
import { contractSignature } from '#src/contract/walk.ts';

const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), '..', 'daemon', 'index.ts');

export interface DaemonConnection {
  url: string;
  token: string;
}

/**
 * Start the daemon on demand. A developer typing `mocktown status` should not have to
 * know a daemon exists; an agent running unattended certainly should not.
 */
export async function ensureDaemon(): Promise<DaemonConnection> {
  const override = process.env.MOCKTOWN_API;
  if (override) return { url: override, token: process.env.MOCKTOWN_TOKEN ?? '' };

  const existing = readDaemonState();
  if (existing && (await isDaemonListening(existing.port))) {
    // The daemon outlives the shell by design, so the one answering may predate the contract
    // this client was built from. Saying so beats letting a surface read a field the daemon
    // never learned to send — that surfaces as an unattributable TypeError.
    const expected = contractSignature(contract);
    if (existing.contract !== expected) {
      throw new Error(
        `the running daemon (pid ${existing.pid}) was built from a different contract than this client ` +
          `(${existing.contract ?? 'unknown'} != ${expected}) — restart it with \`mocktown daemon stop\`, ` +
          'and the next command will start a fresh one. A recording or serve session in progress is lost with it.',
      );
    }
    return { url: `http://127.0.0.1:${existing.port}/api/v1`, token: existing.token };
  }

  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });

  const ready = await new Promise<{ port: number } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), 20_000);
    let buffered = '';
    const onData = (chunk: Buffer) => {
      buffered += chunk.toString();
      const match = /\{"ready":true,"port":(\d+)/.exec(buffered);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]) });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });

  if (!ready) throw new Error('could not start the Mocktown daemon — run `mocktown daemon start` to see why');
  // Detached so the daemon outlives the command that started it: recording sessions and
  // provider processes have to survive the shell. The pipes have to be released too, or
  // the CLI sits waiting on a stream that will never close.
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();

  const state = readDaemonState();
  if (!state) throw new Error('the daemon started but wrote no state file');
  return { url: `http://127.0.0.1:${state.port}/api/v1`, token: state.token };
}

export function clientFor(connection: DaemonConnection) {
  const link = new OpenAPILink(contract, {
    url: connection.url,
    headers: () => (connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
  });
  return createORPCClient(link) as any;
}
