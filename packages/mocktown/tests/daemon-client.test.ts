/**
 * Auto-starting the daemon, and the way it used to die.
 *
 * The CLI spawned it with piped stdio to read a ready line, then destroyed the pipes so the
 * command could exit. That left a detached process writing into closed fds: it survived
 * until its first log line and then went with EPIPE, which surfaced on the *next* command as
 * `the socket connection was closed unexpectedly` — naming neither the daemon nor the cause.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-daemon-client');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ensureDaemon } = await import('#src/cli/daemon-client.ts');
const { readDaemonState, isDaemonListening, isProcessAlive } = await import('#src/config/daemon.ts');
const { daemonLogFile } = await import('#src/config/paths.ts');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
});

afterAll(() => {
  const state = readDaemonState();
  if (state && isProcessAlive(state.pid)) process.kill(state.pid, 'SIGTERM');
  rmSync(root, { recursive: true, force: true });
});

test('an auto-started daemon owns a sink that outlives the command', async () => {
  const connection = await ensureDaemon();
  const state = readDaemonState()!;
  expect(state.pid).toBeGreaterThan(0);
  expect(connection.url).toBe(`http://127.0.0.1:${state.port}/api/v1`);
  expect(await isDaemonListening(state.port)).toBe(true);

  // The daemon's stdout reached a file, so a later write has somewhere to go. A pipe the
  // CLI destroyed would leave this missing and the process one log line from death.
  const log = daemonLogFile();
  expect(existsSync(log)).toBe(true);
  expect(readFileSync(log, 'utf8')).toContain(`"port":${state.port}`);

  // Readiness is the state file, not the ready line — so the pid answering is the one spawned.
  expect(isProcessAlive(state.pid)).toBe(true);
}, 30_000);
