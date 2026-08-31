/**
 * `ProjectRuntime` — everything the daemon owns for one project: the front door, the
 * providers, the recorder, the issue engine and the scenario state.
 *
 * 02-architecture.md's discipline is that the daemon owns all logic and every client is
 * thin. That only holds if the logic lives somewhere, and this is it — the API handlers
 * in `router.ts` are a thin projection of this class, which is what makes the CLI, the
 * MCP server and (later) the GUI equivalent by construction rather than by care.
 */
import { existsSync, mkdirSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { openProjectDb, schema } from "../db/client.ts";
import { ensureRegistered, resolveProject, type ResolvedProject } from "../config/project.ts";
import { projectPaths } from "../config/paths.ts";
import { ensureProjectCa } from "../frontdoor/ca.ts";
import { FrontDoor, type CapturedExchange, type WallHit } from "../frontdoor/controller.ts";
import { routeForProvider, type Route, type RoutingTable } from "../frontdoor/routing.ts";
import { Recorder, endSession, startSession } from "../capture/recorder.ts";
import { captureEnv } from "../capture/launch.ts";
import { Scrubber } from "../scrub/scrubber.ts";
import { rulesFromConfig } from "../scrub/rules.ts";
import { IssueEngine } from "../issues/engine.ts";
import { EmulateProvider, emulateServiceId } from "../providers/emulate.ts";
import { GeneratedProvider } from "../providers/generated.ts";
import type { Provider } from "../providers/types.ts";
import { ensureDefaultProfiles } from "../scenario/profiles.ts";
import { describeKnobs, effectiveKnobs } from "../scenario/knobs.ts";
import { templatePath } from "../capture/normalize.ts";
import { id } from "../util/id.ts";

export interface RuntimeMode {
  kind: "idle" | "record" | "serve";
  sealed: boolean;
}

export class ProjectRuntime {
  readonly db: Db;
  readonly issues: IssueEngine;
  private project: ResolvedProject;
  private scrubber: Scrubber;
  private frontDoor?: FrontDoor;
  private recorder?: Recorder;
  private providers: Provider[] = [];
  private sessionId: string | null = null;
  private sessionSeed = "mocktown-default-seed";
  private recordedCount = 0;
  mode: RuntimeMode = { kind: "idle", sealed: false };

  constructor(project: ResolvedProject) {
    this.project = project;
    ensureRegistered(project);
    this.db = openProjectDb(project.name);
    ensureDefaultProfiles(this.db);
    this.syncRegistryFromConfig();
    this.issues = new IssueEngine(this.db, project.paths?.issuesDir ?? null);
    this.scrubber = new Scrubber(rulesFromConfig(project.file?.scrub), project.file?.scrub?.entropyBackstop ?? true);
  }

  get name(): string { return this.project.name; }
  get resolved(): ResolvedProject { return this.project; }
  get session(): string | null { return this.sessionId; }
  get currentScrubber(): Scrubber { return this.scrubber; }

  /** Re-read `mocktown.json` — an agent editing the registry should not need a restart. */
  reload(): void {
    this.project = resolveProject({ project: this.project.name, cwd: this.project.workspace ?? process.cwd() });
    this.syncRegistryFromConfig();
    this.scrubber = new Scrubber(rulesFromConfig(this.project.file?.scrub), this.project.file?.scrub?.entropyBackstop ?? true);
  }

  /**
   * The committed file is the source of truth for configured services; the table also
   * holds services discovered from traffic, which the file does not know about yet.
   */
  private syncRegistryFromConfig(): void {
    for (const [host, config] of Object.entries(this.project.file?.services ?? {})) {
      this.db.insert(schema.services)
        .values({ id: host, provider: config.provider, seed: config.seed ?? null, discovered: false })
        .onConflictDoUpdate({
          target: schema.services.id,
          set: { provider: config.provider, seed: config.seed ?? null, discovered: false },
        })
        .run();
    }
    for (const host of this.project.local.passthrough) {
      this.db.insert(schema.services)
        .values({ id: host, provider: "passthrough", discovered: false })
        .onConflictDoUpdate({ target: schema.services.id, set: { provider: "passthrough" } })
        .run();
    }
  }

  services() {
    return this.db.select().from(schema.services).all();
  }

  // ── Front door ──────────────────────────────────────────────────────────────

  private async ensureFrontDoor(): Promise<FrontDoor> {
    if (this.frontDoor?.isRunning) return this.frontDoor;
    const ca = await ensureProjectCa(this.project.name);
    this.frontDoor = new FrontDoor(
      { ca, port: this.project.local.frontDoorPort },
      {
        onExchange: (exchange) => this.onExchange(exchange),
        onWallHit: (hit) => this.onWallHit(hit),
        onPinnedClient: (event) => this.onPinnedClient(event),
      },
    );
    await this.frontDoor.start();
    return this.frontDoor;
  }

  private onExchange(exchange: CapturedExchange): void {
    // Only `record` persists. `passthrough` is explicitly not recorded (03-capture.md's
    // mode table), and `mock` traffic is the mock's own output, not evidence about reality.
    if (exchange.mode !== "record" || !this.recorder) return;
    this.recorder.record(exchange);
    this.recordedCount++;
  }

  private onWallHit(hit: WallHit): void {
    const url = new URL(hit.url);
    // Scrub before the request is stored on an issue: issues embed requests and flow
    // through the same scrubber (10-security.md).
    const scrubbed = this.scrubber.scrub({
      id: id("hit"), method: hit.method, url: hit.url, statusCode: 502,
      requestHeaders: hit.headers, requestBody: hit.body,
      responseHeaders: {}, responseBody: "",
    });

    this.issues.file({
      type: hit.reason === "unknown-host" ? "unknown-service" : "unmatched-request",
      service: url.hostname,
      method: hit.method,
      path: url.pathname,
      pathTemplate: templatePath(url.pathname),
      sessionId: this.sessionId,
      request: { method: scrubbed.method, url: scrubbed.url, headers: scrubbed.requestHeaders, body: scrubbed.requestBody },
      diagnosis: { reason: WALL_REASONS[hit.reason](url.hostname, hit.provider) },
      suggestedResolution: WALL_RESOLUTIONS[hit.reason](url.hostname, hit.provider),
    });
  }

  private onPinnedClient(event: { hostname: string | undefined; reason: string }): void {
    const host = event.hostname ?? "(unknown host)";
    this.issues.file({
      type: "pinned-client",
      service: host,
      sessionId: this.sessionId,
      diagnosis: { reason: event.reason },
      // Surfaced, never auto-resolved: 03-capture.md documents pinning as out of scope,
      // and an issue that quietly closed itself would hide a real coverage gap.
      suggestedResolution:
        `The client refused Mocktown's certificate for ${host}. Certificate pinning is out of scope — ` +
        `either disable pinning in a development build, or exclude this host with ` +
        `\`mocktown services set --id ${host} --provider passthrough\` and accept that its traffic is not mocked.`,
    });
  }

  /** The routing table the front door applies, derived from the registry and providers. */
  private routingTable(): RoutingTable {
    // Full base URLs, not host:port — the route needs the provider's scheme as well, or
    // an https client reaches a cleartext emulator and gets a 502.
    const baseUrls = this.allBaseUrls();
    const routes: Route[] = this.services().map((service) =>
      routeForProvider(service.id, service.provider, baseUrls));

    return {
      routes,
      // In record mode an unknown host is new evidence, so it is recorded. In serve mode
      // it is a wall-hit, so it is denied and filed. Never passthrough, either way.
      fallthrough: this.mode.kind === "record" ? "record" : "deny",
    };
  }

  private async applyRouting(): Promise<void> {
    const frontDoor = await this.ensureFrontDoor();
    await frontDoor.applyRouting(this.routingTable());
  }

  // ── Record mode ─────────────────────────────────────────────────────────────

  async startRecord(opts: { label?: string; seed?: string } = {}): Promise<{ session: string; proxyUrl: string; caCertPath: string; env: Record<string, string> }> {
    if (this.mode.kind === "serve") await this.stopServe();

    this.sessionSeed = opts.seed ?? this.sessionSeed;
    this.sessionId = startSession(this.db, "record", { seed: this.sessionSeed, label: opts.label });
    this.recordedCount = 0;
    // A fresh scrubber per session: placeholders are session-scoped by design, which is
    // what makes `{{secret:stripe-secret-key#1}}` mean "the same key as earlier".
    this.scrubber = new Scrubber(rulesFromConfig(this.project.file?.scrub), this.project.file?.scrub?.entropyBackstop ?? true);
    this.recorder = new Recorder(this.db, this.project.name, this.scrubber, this.sessionId);
    this.mode = { kind: "record", sealed: false };
    this.issues.startBatch();

    const frontDoor = await this.ensureFrontDoor();
    await this.applyRouting();

    const ca = await ensureProjectCa(this.project.name);
    const proxyUrl = `http://127.0.0.1:${frontDoor.port}`;
    return {
      session: this.sessionId,
      proxyUrl,
      caCertPath: ca.certPath,
      env: captureEnv({ proxyUrl, caCertPath: ca.certPath }),
    };
  }

  async stopRecord(): Promise<{ session: string | null; recorded: number; services: string[] }> {
    const session = this.sessionId;
    const recorded = this.recordedCount;
    const services = session
      ? [...new Set(this.db.select().from(schema.recordings).where(eq(schema.recordings.sessionId, session)).all().map((r) => r.service))]
      : [];

    if (session) endSession(this.db, session);
    this.recorder = undefined;
    this.sessionId = null;
    this.mode = { kind: "idle", sealed: false };
    await this.frontDoor?.stop();
    this.frontDoor = undefined;
    return { session, recorded, services };
  }

  // ── Serve mode ──────────────────────────────────────────────────────────────

  async startServe(opts: { seed?: string; sealed?: boolean } = {}): Promise<{ session: string; proxyUrl: string; caCertPath: string; env: Record<string, string>; warnings: string[] }> {
    if (this.mode.kind === "record") await this.stopRecord();

    this.sessionSeed = opts.seed ?? this.sessionSeed;
    this.sessionId = startSession(this.db, "serve", { seed: this.sessionSeed });
    this.mode = { kind: "serve", sealed: opts.sealed ?? true };
    this.issues.startBatch();

    await this.startProviders();
    const frontDoor = await this.ensureFrontDoor();
    await this.applyRouting();

    const ca = await ensureProjectCa(this.project.name);
    const proxyUrl = `http://127.0.0.1:${frontDoor.port}`;
    return {
      session: this.sessionId,
      proxyUrl,
      caCertPath: ca.certPath,
      env: captureEnv({ proxyUrl, caCertPath: ca.certPath }),
      warnings: this.providers.flatMap((p) => p.warnings),
    };
  }

  private async startProviders(): Promise<void> {
    await this.stopProviders();
    const ctx = {
      project: this.project.name,
      workspace: this.project.workspace,
      sessionId: this.sessionId!,
      sessionSeed: this.sessionSeed,
    };
    const registry = this.services();

    // One emulate process serves every emulator-backed service (spike 03), so they are
    // collected into a single supervisor rather than one provider each.
    const emulateServices: string[] = [];
    const hostnames = new Map<string, string>();
    const seeds: string[] = [];
    for (const service of registry) {
      const emulateId = emulateServiceId(service.provider);
      if (!emulateId) continue;
      emulateServices.push(emulateId);
      hostnames.set(emulateId, service.id);
      if (service.seed) seeds.push(service.seed);
    }

    const started: Provider[] = [];

    if (emulateServices.length > 0) {
      const distinctSeeds = [...new Set(seeds)];
      const provider = new EmulateProvider({
        emulateServices,
        hostnames,
        seedFile: distinctSeeds[0],
      });
      if (distinctSeeds.length > 1) {
        // emulate takes one seed file for the whole process; saying so beats silently
        // ignoring the others and leaving a service mysteriously unseeded.
        provider.warnings.push(
          `emulate accepts a single seed file per process, so only "${distinctSeeds[0]}" was applied. ` +
          `Merge ${distinctSeeds.slice(1).join(", ")} into it, or the other services run on emulate's built-in defaults.`,
        );
      }
      await provider.start(ctx);
      started.push(provider);
    }

    if (this.project.paths && existsSync(this.project.paths.mocksDir)) {
      const provider = new GeneratedProvider({
        db: this.db,
        mocksDir: this.project.paths.mocksDir,
        knobsFor: (service, profile) => this.knobsFor(service, profile),
        onUnmatched: (event) => this.onMockUnmatched(event),
      });
      await provider.start(ctx);
      started.push(provider);
    }

    this.providers = started;
    this.persistEkb();
  }

  /**
   * The endpoint knowledge base is an accreting asset (05-redirection.md), so every
   * provider's recipes are folded into it whenever they start: emulate's come from the
   * seeded table, a generated mock's come from the module its agent wrote. Entries are
   * replaced per (service, source) rather than appended, or a restart would duplicate
   * every recipe.
   */
  private persistEkb(): void {
    for (const provider of this.providers) {
      const source = provider.kind === "emulator" ? "emulate-skill" : `generated:${provider.name}`;
      const services = new Set(provider.ekbEntries().map((e) => e.service));
      for (const service of services) {
        this.db.delete(schema.ekb)
          .where(and(eq(schema.ekb.service, service), eq(schema.ekb.source, source)))
          .run();
      }
      for (const { service, recipe } of provider.ekbEntries()) {
        this.db.insert(schema.ekb).values({
          id: id("ekb"),
          service,
          rung: recipe.rung,
          envVar: recipe.envVar ?? null,
          language: recipe.language ?? null,
          snippet: recipe.snippet ?? null,
          note: recipe.note ?? null,
          source,
        }).run();
      }
    }
  }

  private onMockUnmatched(event: {
    service: string; method: string; path: string; request: unknown; diagnosis: unknown;
    kind: "unmatched-request" | "near-miss" | "unknown-service"; suggestedResolution: string;
  }): void {
    const generated = this.providers.find((p) => p.kind === "generated") as GeneratedProvider | undefined;
    const moduleFile = generated?.moduleFile(event.service);
    const links = [
      ...(moduleFile ? [moduleFile] : []),
      `mocktown corpus export --service ${event.service}`,
      `mocktown recordings routes --service ${event.service}`,
    ];

    this.issues.file({
      type: event.kind,
      service: event.service,
      method: event.method,
      path: event.path,
      pathTemplate: templatePath(event.path),
      sessionId: this.sessionId,
      request: event.request,
      diagnosis: event.diagnosis,
      suggestedResolution: event.suggestedResolution,
      links,
    });
  }

  private async stopProviders(): Promise<string[]> {
    const names = this.providers.map((p) => p.name);
    await Promise.all(this.providers.map((p) => p.stop()));
    this.providers = [];
    return names;
  }

  async stopServe(): Promise<{ stopped: string[] }> {
    const stopped = await this.stopProviders();
    if (this.sessionId) endSession(this.db, this.sessionId);
    this.sessionId = null;
    this.mode = { kind: "idle", sealed: false };
    await this.frontDoor?.stop();
    this.frontDoor = undefined;
    return { stopped };
  }

  // ── Scenario controls ───────────────────────────────────────────────────────

  knobsFor(service: string, profile: string): Record<string, unknown> {
    const manifest = this.providerFor(service)?.knobs?.(service);
    return effectiveKnobs(this.db, manifest, service, profile);
  }

  describeKnobsFor(service: string, profile: string) {
    return describeKnobs(this.db, this.providerFor(service)?.knobs?.(service), service, profile);
  }

  knobManifest(service: string) {
    return this.providerFor(service)?.knobs?.(service);
  }

  providerFor(service: string): Provider | undefined {
    return this.providers.find((p) => p.services.includes(service));
  }

  /**
   * A reset closes the session and starts a new one, and recordings and issues are tagged
   * by session id (12-scenario-controls.md) — so "what happened after the reset" stays a
   * question the corpus can answer.
   */
  async resetState(scope: { service?: string; profile?: string } = {}): Promise<{ reset: string[]; session: string; restarted: string[] }> {
    const reset: string[] = [];
    const restarted: string[] = [];

    for (const provider of this.providers) {
      if (scope.service && !provider.services.includes(scope.service)) continue;
      await provider.reset(scope);
      reset.push(...(scope.service ? [scope.service] : provider.services));
      // Emulator resets are a process restart, which costs seconds — worth saying so.
      if (provider.kind === "emulator") restarted.push(provider.name);
    }

    if (this.sessionId) endSession(this.db, this.sessionId);
    this.sessionId = startSession(this.db, this.mode.kind === "record" ? "record" : "serve", { seed: this.sessionSeed });
    this.db.insert(schema.journal)
      .values({ id: id("jrn"), sessionId: this.sessionId, kind: "state-reset", service: scope.service ?? null, payload: scope })
      .run();

    // Provider base URLs change across an emulate restart, so routing has to follow.
    if (this.frontDoor?.isRunning) await this.applyRouting();

    return { reset: [...new Set(reset)], session: this.sessionId, restarted };
  }

  // ── Status ──────────────────────────────────────────────────────────────────

  providerStatuses() {
    return this.providers.map((provider) => ({
      name: provider.name,
      kind: provider.kind,
      services: provider.services,
      running: provider.running,
      baseUrls: Object.fromEntries(provider.baseUrls()),
      warnings: provider.warnings,
    }));
  }

  frontDoorStatus() {
    return {
      running: this.frontDoor?.isRunning ?? false,
      port: this.frontDoor?.isRunning ? this.frontDoor.port : null,
      mode: (this.mode.kind === "record" ? "record" : "deny") as "record" | "deny",
    };
  }

  /** Where a service's mock is reachable, for the verify harness and `mocktown env`. */
  baseUrlFor(service: string): string | undefined {
    return this.providerFor(service)?.baseUrls().get(service);
  }

  allBaseUrls(): Map<string, string> {
    const out = new Map<string, string>();
    for (const provider of this.providers) for (const [service, url] of provider.baseUrls()) out.set(service, url);
    return out;
  }

  ensureDirs(): void {
    mkdirSync(projectPaths(this.project.name).root, { recursive: true });
    if (this.project.paths) mkdirSync(this.project.paths.issuesDir, { recursive: true });
  }

  async shutdown(): Promise<void> {
    await this.stopProviders();
    await this.frontDoor?.stop();
    this.frontDoor = undefined;
  }
}

/** One runtime per project, kept alive for the daemon's lifetime. */
const runtimes = new Map<string, ProjectRuntime>();

export function runtimeFor(projectName: string, cwd?: string): ProjectRuntime {
  const existing = runtimes.get(projectName);
  if (existing) return existing;
  const runtime = new ProjectRuntime(resolveProject({ project: projectName, cwd }));
  runtime.ensureDirs();
  runtimes.set(projectName, runtime);
  return runtime;
}

export async function shutdownAllRuntimes(): Promise<void> {
  await Promise.all([...runtimes.values()].map((r) => r.shutdown()));
  runtimes.clear();
}

/**
 * Why a request hit the wall, and what to do about it. An issue must be resolvable by an
 * agent that read nothing but the issue (07-issues-agent-loop.md), so a wrong reason here
 * is worse than a vague one — it sends the agent to edit the wrong thing.
 */
const WALL_REASONS: Record<WallHit["reason"], (host: string, provider?: string) => string> = {
  "unknown-host": (host) =>
    `No entry in the service registry for "${host}", and the front door is sealed, so the request was denied rather than sent to the real host.`,
  deny: (host) => `"${host}" is registered as \`deny\`.`,
  "provider-down": (host, provider) =>
    `"${host}" is registered as \`${provider}\`, but that provider is not running, so there was nowhere to send the request. Denying is deliberate: falling back to the real host would leak traffic to production.`,
};

const WALL_RESOLUTIONS: Record<WallHit["reason"], (host: string, provider?: string) => string> = {
  "unknown-host": (host) =>
    `Decide what this host should be: \`mocktown services set --id ${host} --provider record\` to capture it, \`generated:${host}\` to mock it, or \`passthrough\` to allow it out explicitly.`,
  deny: (host) => `Change the registry entry for ${host} if this request should be served.`,
  "provider-down": (host) =>
    `Find out why the provider did not start — \`mocktown providers list\` reports the load error — then \`mocktown serve start\` again. For a generated mock, a module that fails to import is the usual cause.`,
};
