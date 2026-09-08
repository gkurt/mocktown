/**
 * Where a running daemon is, for the callers that only need to find it.
 *
 * This lives beside the paths rather than in `daemon/server.ts` because reading a small JSON
 * file should not mean importing the server that writes it: the CLI does this before every
 * command, and the runtime — which the server imports — would otherwise be reaching back
 * into its own importer for a port number.
 */
import { existsSync, readFileSync } from 'node:fs';
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
