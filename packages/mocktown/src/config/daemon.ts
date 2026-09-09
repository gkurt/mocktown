/**
 * Where a running daemon is, for the callers that only need to find it.
 *
 * This lives beside the paths rather than in `daemon/server.ts` because reading a small JSON
 * file should not mean importing the server that writes it: the CLI does this before every
 * command, and the runtime — which the server imports — would otherwise be reaching back
 * into its own importer for a port number.
 *
 * The file is a claim, not a fact: a daemon that was killed, crashed or lost a reboot leaves
 * one behind. Everything that acts on it goes through `daemonLiveness` rather than trusting
 * the pid it reads, because the alternative — dialling a dead port — surfaces as
 * `the socket connection was closed unexpectedly`, which names neither the daemon nor the
 * file to delete.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { daemonStateFile } from '#src/config/paths.ts';

export interface DaemonState {
  port: number;
  token: string;
  pid: number;
  /** What the client compares against to know it is older or newer than the running process. */
  contract?: string;
}

/** How a client finds a running daemon. Returns null when none has been started. */
export function readDaemonState(): DaemonState | null {
  const file = daemonStateFile();
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Whether that pid still names a live process. */
export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 delivers nothing; it only runs the permission and existence checks.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM is a process this user may not signal — someone else's daemon, but alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether a daemon is answering on that port. The API document needs no token (10-security.md). */
export async function isDaemonListening(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/v1/openapi.json`, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

export type DaemonLiveness =
  | { status: 'none' }
  /** A state file whose pid is gone: nothing is listening and nothing ever will. */
  | { status: 'stale'; state: DaemonState }
  /** The pid is alive but the port does not answer — a wedged daemon, or a recycled pid. */
  | { status: 'unresponsive'; state: DaemonState }
  | { status: 'running'; state: DaemonState };

/**
 * What the state file is actually worth right now.
 *
 * The pid check is the cheap one and catches the common case (a machine that rebooted with a
 * daemon registered); the port probe catches the two the pid cannot — a pid the OS has since
 * handed to something else, and a daemon still running but no longer serving.
 */
export async function daemonLiveness(): Promise<DaemonLiveness> {
  const state = readDaemonState();
  if (!state) return { status: 'none' };
  if (!isProcessAlive(state.pid)) return { status: 'stale', state };
  if (!(await isDaemonListening(state.port))) return { status: 'unresponsive', state };
  return { status: 'running', state };
}

/** Drop the registration. Only for a caller that has established the file is stale, or its own. */
export function removeDaemonState(): void {
  rmSync(daemonStateFile(), { force: true });
}

/**
 * Drop the registration on the way out, but only when it is still ours.
 *
 * Two daemons can be running at once — an orphan from a previous shell and the one that
 * registered — and only the last writer is in the file. A daemon that unlinks on shutdown
 * without checking takes the *other* one's registration with it, leaving a healthy daemon
 * that no client can find. A file that fails to parse belongs to nobody and is cleared.
 */
export function removeOwnDaemonState(): void {
  const file = daemonStateFile();
  if (!existsSync(file)) return;
  const state = readDaemonState();
  if (state && state.pid !== process.pid) return;
  removeDaemonState();
}
