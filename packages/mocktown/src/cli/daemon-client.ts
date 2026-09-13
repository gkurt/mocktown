/**
 * How every client reaches the daemon.
 *
 * The CLI, the MCP server and the GUI all go through `OpenAPILink` against the same HTTP
 * surface — none of them imports the router. That keeps 02-architecture.md's "no client
 * has privileged access to anything" structural rather than aspirational (spike 02's
 * first implementation note).
 */
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createORPCClient } from '@orpc/client';
import { OpenAPILink } from '@orpc/openapi-client/fetch';
import { type DaemonState, isDaemonListening, isProcessAlive, readDaemonState } from '#src/config/daemon.ts';
import { daemonLogFile, globalConfigDir } from '#src/config/paths.ts';
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

  // Detached so the daemon outlives the command that started it, and pointed at a log file
  // rather than a pipe: the CLI exits, so a pipe would have to be closed, and the daemon
  // then dies of EPIPE at its next log line — reaching the *next* command as a closed
  // socket, long after the cause. Readiness comes off the state file for the same reason.
  mkdirSync(globalConfigDir(), { recursive: true });
  const logFile = daemonLogFile();
  const log = openSync(logFile, 'w', 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, [daemonEntry], { detached: true, stdio: ['ignore', log, log], env: process.env });
  } finally {
    closeSync(log);
  }
  child.unref();

  const state = await waitForDaemon(child.pid!);
  if (!state) throw new Error(`could not start the Mocktown daemon${logTail(logFile)}`);
  return { url: `http://127.0.0.1:${state.port}/api/v1`, token: state.token };
}

/** The daemon writes its state before it announces itself, so the file is the readiness signal. */
async function waitForDaemon(pid: number, timeoutMs = 20_000): Promise<DaemonState | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = readDaemonState();
    // Matched on pid: a state file left by an earlier daemon must not read as this one's.
    if (state?.pid === pid && (await isDaemonListening(state.port))) return state;
    if (!isProcessAlive(pid)) return null;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

/** Why it failed, rather than an instruction to go and reproduce it. */
function logTail(file: string, lines = 12): string {
  try {
    const text = readFileSync(file, 'utf8').trimEnd();
    return text ? ` — its output is in ${file}:\n${text.split('\n').slice(-lines).join('\n')}` : ` — it logged nothing to ${file}`;
  } catch {
    return ` — and wrote no log to ${file}`;
  }
}

export function clientFor(connection: DaemonConnection) {
  const link = new OpenAPILink(contract, {
    url: connection.url,
    headers: () => (connection.token ? { authorization: `Bearer ${connection.token}` } : {}),
  });
  return createORPCClient(link) as any;
}
