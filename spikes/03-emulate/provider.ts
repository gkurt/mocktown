/**
 * The emulate provider — the wrapper 06-emulation.md requires:
 *
 *   "emulate is wrapped, never load-bearing. It runs as child processes managed by its
 *    provider; nothing outside the provider layer imports it or assumes its config format."
 *
 * This is the seam. Everything emulate-shaped is inside this file: the CLI invocation,
 * the port-allocation scheme, the stdout parsing, the config format. Callers see only
 * `start()` / `stop()` / `baseUrlFor()`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';

export interface EmulateProviderOptions {
  services: string[];
  seedFile?: string;
  /** Base port; emulate assigns base+n per service in the order given. */
  basePort?: number;
  startupTimeoutMs?: number;
}

export class EmulateProvider {
  private child?: ChildProcess;
  private urls = new Map<string, string>();
  private exited?: { code: number | null; signal: NodeJS.Signals | null };
  readonly log: string[] = [];

  constructor(private readonly options: EmulateProviderOptions) {}

  /** emulate binds base+n per service, so we need a run of free ports, not just one. */
  private static async findFreePortRun(count: number, from = 4400): Promise<number> {
    for (let base = from; base < from + 500; base += count) {
      const free = await Promise.all(
        Array.from(
          { length: count },
          (_, i) =>
            new Promise<boolean>((resolve) => {
              const s = createServer();
              s.once('error', () => resolve(false));
              s.listen(base + i, '127.0.0.1', () => s.close(() => resolve(true)));
            }),
        ),
      );
      if (free.every(Boolean)) return base;
    }
    throw new Error('no free port run available for the emulate provider');
  }

  async start(): Promise<Map<string, string>> {
    const basePort = this.options.basePort ?? (await EmulateProvider.findFreePortRun(this.options.services.length));
    const args = ['emulate', 'start', '-p', String(basePort), '-s', this.options.services.join(',')];
    if (this.options.seedFile) args.push('--seed', this.options.seedFile);

    this.child = spawn('bunx', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child.on('exit', (code, signal) => {
      this.exited = { code, signal };
    });

    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () =>
          reject(new Error(`emulate did not report all services within ${this.options.startupTimeoutMs ?? 20000}ms\n${this.log.join('')}`)),
        this.options.startupTimeoutMs ?? 20000,
      );
      const onChunk = (buf: Buffer) => {
        const text = buf.toString();
        this.log.push(text);
        // emulate announces one line per service: "  stripe  http://localhost:4300"
        for (const [, service, url] of text.matchAll(/^\s*(\S+)\s+(https?:\/\/\S+)\s*$/gm)) {
          // Rewrite localhost -> 127.0.0.1: emulate binds all interfaces, and we only
          // ever want loopback (10-security.md).
          this.urls.set(service, url.replace('//localhost:', '//127.0.0.1:'));
        }
        if (this.options.services.every((s) => this.urls.has(s))) {
          clearTimeout(timer);
          resolve();
        }
      };
      this.child!.stdout?.on('data', onChunk);
      this.child!.stderr?.on('data', onChunk);
      this.child!.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`emulate exited during startup with code ${code}\n${this.log.join('')}`));
      });
    });

    await ready;

    // The banner is NOT a readiness signal: emulate announces every service's URL before
    // they are all listening. With three services, the third was still refusing
    // connections seconds after it was announced. Probe until each one answers.
    await Promise.all([...this.urls].map(([service, url]) => this.waitForListening(service, url)));

    return new Map(this.urls);
  }

  private async waitForListening(service: string, url: string, timeoutMs = 20000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'no attempt made';
    while (Date.now() < deadline) {
      if (this.exited) throw new Error(`emulate exited before "${service}" was listening`);
      try {
        // Any HTTP answer means the listener is up; a 404 is as good as a 200 here.
        await fetch(url, { signal: AbortSignal.timeout(1000) });
        return;
      } catch (e: any) {
        lastError = e?.message ?? String(e);
        await new Promise((r) => setTimeout(r, 150));
      }
    }
    throw new Error(`emulate announced "${service}" at ${url} but it never started listening (${lastError})`);
  }

  baseUrlFor(service: string): string {
    const url = this.urls.get(service);
    if (!url) throw new Error(`emulate provider is not serving "${service}"`);
    return url;
  }

  get isRunning(): boolean {
    return !!this.child && this.exited === undefined;
  }

  async stop(): Promise<void> {
    if (!this.child || this.exited) return;
    const child = this.child;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
