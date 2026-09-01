/**
 * Port allocation. `findFreePortRun` exists because one emulate process serves N
 * services on consecutive ports (spike 03), so probing a single port and assuming the
 * next is free is a race on a developer's machine.
 */
import { createServer } from 'node:net';

function bindable(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    const done = () => server.close(() => resolve(true));
    host ? server.listen(port, host, done) : server.listen(port, done);
  });
}

/**
 * A port is free only if it is free *both* ways it gets bound here. The daemon binds
 * `127.0.0.1`; the front door and emulate bind every interface. On macOS neither bind
 * conflicts with the other at probe time, so checking one address alone hands out a port
 * that then dies with an opaque `EADDRINUSE` inside whichever process claimed it second.
 */
async function probe(port: number): Promise<boolean> {
  return (await bindable(port, '127.0.0.1')) && (await bindable(port));
}

export async function findFreePort(from = 4500, span = 500): Promise<number> {
  for (let port = from; port < from + span; port++) if (await probe(port)) return port;
  throw new Error(`no free port in ${from}..${from + span}`);
}

export async function findFreePortRun(count: number, from = 4600, span = 500): Promise<number> {
  for (let base = from; base < from + span; base += count) {
    const free = await Promise.all(Array.from({ length: count }, (_, i) => probe(base + i)));
    if (free.every(Boolean)) return base;
  }
  throw new Error(`no run of ${count} free ports in ${from}..${from + span}`);
}

/** A child process's stdout is evidence of intent, not of readiness (spike 03). */
export async function waitForListening(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(1000) });
      return;
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error(`${url} never started listening (${lastError})`);
}
