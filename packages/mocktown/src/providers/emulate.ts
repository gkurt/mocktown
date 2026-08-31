/**
 * The emulate provider — the wrapper 06-emulation.md requires:
 *
 *   "emulate is wrapped, never load-bearing. It runs as child processes managed by its
 *    provider; nothing outside the provider layer imports it or assumes its config format."
 *
 * This file is the seam. Everything emulate-shaped is inside it: the CLI invocation, the
 * port-allocation scheme, the stdout parsing, the seed file format. If emulate is
 * abandoned tomorrow, famous services degrade to generated mocks and no other file
 * changes.
 *
 * Verified 7/8 in spike 03. The failing test is test 6 and it is not ours to fix:
 * emulate binds every interface with no way to constrain it, so host mode warns.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { networkInterfaces } from "node:os";
import { isAbsolute, resolve } from "node:path";
import { findFreePortRun, waitForListening } from "../util/ports.ts";
import type { Provider, ProviderCtx, ResetScope, StateSnapshot } from "./types.ts";
import type { EndpointRecipe } from "../mocks/types.ts";
import { EMULATE_RECIPES } from "../ekb/emulate-recipes.ts";

export interface EmulateProviderOptions {
  /** emulate service ids, e.g. `stripe`, `github`. */
  emulateServices: string[];
  /** emulate service id -> the hostname the app actually calls. */
  hostnames: Map<string, string>;
  seedFile?: string;
  startupTimeoutMs?: number;
}

export class EmulateProvider implements Provider {
  readonly name = "emulate";
  readonly kind = "emulator" as const;
  private child?: ChildProcess;
  private urls = new Map<string, string>();     // emulate service id -> baseUrl
  private exited?: { code: number | null };
  private ctx?: ProviderCtx;
  readonly log: string[] = [];
  warnings: string[] = [];

  constructor(private readonly options: EmulateProviderOptions) {}

  get services(): string[] {
    return this.options.emulateServices.map((s) => this.options.hostnames.get(s) ?? s);
  }

  get running(): boolean {
    return !!this.child && this.exited === undefined;
  }

  baseUrls(): Map<string, string> {
    const out = new Map<string, string>();
    for (const [service, url] of this.urls) out.set(this.options.hostnames.get(service) ?? service, url);
    return out;
  }

  async start(ctx: ProviderCtx): Promise<Map<string, string>> {
    if (this.running) return this.baseUrls();
    this.ctx = ctx;
    this.exited = undefined;
    this.urls.clear();
    this.log.length = 0;

    // One process, base port plus an offset per service — so we need a contiguous run of
    // free ports, not one free port (spike 03).
    const basePort = await findFreePortRun(this.options.emulateServices.length);
    const args = ["emulate", "start", "-p", String(basePort), "-s", this.options.emulateServices.join(",")];
    const seed = this.resolveSeed(ctx);
    if (seed) args.push("--seed", seed);

    this.child = spawn("bunx", args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child.on("exit", (code) => { this.exited = { code }; });

    await this.awaitBanner();
    // The banner announces every service before they are all listening; with three
    // services the third was still refusing connections seconds later (spike 03).
    await Promise.all([...this.urls].map(([service, url]) =>
      waitForListening(url).catch(() => {
        throw new Error(`emulate announced "${service}" at ${url} but it never started listening`);
      })));

    this.warnings = this.exposureWarnings();
    return this.baseUrls();
  }

  private resolveSeed(ctx: ProviderCtx): string | undefined {
    const seed = this.options.seedFile;
    if (!seed) return undefined;
    return isAbsolute(seed) ? seed : resolve(ctx.workspace ?? process.cwd(), seed);
  }

  private awaitBanner(): Promise<void> {
    const timeoutMs = this.options.startupTimeoutMs ?? 20_000;
    return new Promise<void>((resolvePromise, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`emulate did not report all services within ${timeoutMs}ms\n${this.log.join("")}`)),
        timeoutMs,
      );
      const onChunk = (buf: Buffer) => {
        const text = buf.toString();
        this.log.push(text);
        // emulate announces one line per service: "  stripe  http://localhost:4300"
        for (const [, service, url] of text.matchAll(/^\s*(\S+)\s+(https?:\/\/\S+)\s*$/gm)) {
          // Rewrite localhost -> 127.0.0.1 so nothing downstream resolves to ::1 and misses.
          this.urls.set(service!, url!.replace("//localhost:", "//127.0.0.1:"));
        }
        if (this.options.emulateServices.every((s) => this.urls.has(s))) { clearTimeout(timer); resolvePromise(); }
      };
      this.child!.stdout?.on("data", onChunk);
      this.child!.stderr?.on("data", onChunk);
      this.child!.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`emulate exited during startup with code ${code}\n${this.log.join("")}`));
      });
    });
  }

  /**
   * emulate binds every interface and offers no way to restrict it — not via
   * `emulate start`, not via its programmatic API (spike 03). The GitHub emulator mints
   * OAuth tokens, so on a shared network this is a real exposure, not a nicety. Sandbox
   * mode solves it by construction; host mode has to say so out loud.
   */
  private exposureWarnings(): string[] {
    const external = Object.values(networkInterfaces())
      .flatMap((list) => list ?? [])
      .filter((iface) => !iface.internal && iface.family === "IPv4")
      .map((iface) => iface.address);
    if (external.length === 0) return [];
    return [
      `emulate binds every interface: its mock services (including OAuth token issuance) ` +
      `are reachable from this machine's LAN address${external.length > 1 ? "es" : ""} ${external.join(", ")}. ` +
      `Sealed sandbox mode removes this by construction.`,
    ];
  }

  /**
   * Emulator providers reset by child-process restart with the same seed config
   * (12-scenario-controls.md) — spike-verified, at a cost of a few seconds, so this is
   * fine for `mocktown state reset` and too slow to run between every test case.
   */
  async reset(_scope: ResetScope): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("emulate provider was never started");
    await this.stop();
    await this.start(ctx);
  }

  /**
   * Best-effort, and 06-emulation.md says gaps here are acceptable: emulate exposes no
   * introspection API, so we report what we know rather than inventing a shape.
   */
  state(service: string): StateSnapshot {
    return {
      collections: [],
      note: `State introspection is not available for emulate-backed services. ${service} is served by an emulate child process; use its own API to inspect entities.`,
    };
  }

  ekbEntries(): { service: string; recipe: EndpointRecipe }[] {
    const out: { service: string; recipe: EndpointRecipe }[] = [];
    for (const emulateService of this.options.emulateServices) {
      const hostname = this.options.hostnames.get(emulateService) ?? emulateService;
      for (const recipe of EMULATE_RECIPES[emulateService] ?? []) out.push({ service: hostname, recipe });
    }
    return out;
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.urls.clear();
    if (!child || child.exitCode !== null) { this.exited = { code: child?.exitCode ?? 0 }; return; }
    // SIGTERM with a SIGKILL fallback; 3s is what the spike found sufficient.
    await new Promise<void>((resolvePromise) => {
      const force = setTimeout(() => child.kill("SIGKILL"), 3000);
      child.once("exit", () => { clearTimeout(force); resolvePromise(); });
      child.kill("SIGTERM");
    });
    this.exited = { code: child.exitCode };
  }
}

/** `emulator:stripe` -> `stripe`. The registry names providers, not emulate internals. */
export function emulateServiceId(providerRef: string): string | null {
  return providerRef.startsWith("emulator:") ? providerRef.slice("emulator:".length) : null;
}
