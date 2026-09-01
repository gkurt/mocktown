/**
 * `ProjectRuntime` — everything the daemon owns for one project: the front door, the
 * providers, the recorder, the issue engine and the scenario state.
 *
 * 02-architecture.md's discipline is that the daemon owns all logic and every client is
 * thin. That only holds if the logic lives somewhere, and this is it — the API handlers
 * in `router.ts` are a thin projection of this class, which is what makes the CLI, the
 * MCP server and (later) the GUI equivalent by construction rather than by care.
 */
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { captureEnv, type NoProxyPlan, planNoProxy } from '#src/capture/launch.ts';
import { NoiseFilter, NoiseTally } from '#src/capture/noise.ts';
import { templatePath } from '#src/capture/normalize.ts';
import { endSession, Recorder, startSession } from '#src/capture/recorder.ts';
import { projectPaths } from '#src/config/paths.ts';
import { ensureRegistered, type ResolvedProject, resolveProject } from '#src/config/project.ts';
import { FeedBus, summarize } from '#src/daemon/events.ts';
import type { Db } from '#src/db/client.ts';
import { openProjectDb, schema } from '#src/db/client.ts';
import { type EnvArtifacts, generateEnv } from '#src/env/generate.ts';
import { ensureProjectCa } from '#src/frontdoor/ca.ts';
import { type CapturedExchange, type CapturedSocket, FrontDoor, type WallHit } from '#src/frontdoor/controller.ts';
import { escapingHosts, type Route, type RoutingTable, routeForProvider } from '#src/frontdoor/routing.ts';
import { IssueEngine } from '#src/issues/engine.ts';
import { EmulateProvider, emulateServiceId } from '#src/providers/emulate.ts';
import { GeneratedProvider } from '#src/providers/generated.ts';
import type { Provider, StateSnapshot } from '#src/providers/types.ts';
import { type PortlessSettings, type PortlessStatus, releasePortless, syncPortless, unavailable } from '#src/redirect/portless.ts';
import { Sandbox, type SandboxMode, type SandboxStatus } from '#src/sandbox/sandbox.ts';
import { type SandboxVerifyResult, verifySandbox } from '#src/sandbox/verify.ts';
import { describeKnobs, effectiveKnobs } from '#src/scenario/knobs.ts';
import { ensureDefaultProfiles } from '#src/scenario/profiles.ts';
import { rulesFromConfig } from '#src/scrub/rules.ts';
import { Scrubber } from '#src/scrub/scrubber.ts';
import { id } from '#src/util/id.ts';

export interface RuntimeMode {
  kind: 'idle' | 'record' | 'serve';
  sealed: boolean;
}

/**
 * What a seal run needs to know about a window of traffic: which services were actually
 * exercised, and what hit the wall. Kept as a window rather than a running total because
 * the question a seal answers is "during *these* flows", not "ever".
 */
export interface Observation {
  services: Set<string>;
  wallHits: { host: string; method: string; path: string; reason: string }[];
}

/** A window is evidence, not a log: past this many hits the flows have already failed. */
const MAX_OBSERVED_WALL_HITS = 200;

export class ProjectRuntime {
  readonly db: Db;
  readonly issues: IssueEngine;
  /** The live feed every surface reads (09-gui-plugins.md). Ephemeral, bounded, body-free. */
  readonly feed = new FeedBus();
  private project: ResolvedProject;
  private scrubber: Scrubber;
  private frontDoor?: FrontDoor;
  private recorder?: Recorder;
  private providers: Provider[] = [];
  private sessionId: string | null = null;
  private sessionSeed = 'mocktown-default-seed';
  private recordedCount = 0;
  private noise: NoiseFilter;
  private readonly noiseTally = new NoiseTally();
  private observation: Observation | null = null;
  private configStamp = '-';
  /**
   * Services forced to `record` for the duration of a run, whatever the registry says. A
   * drift check needs exactly this: the registry points a service at its mock, and judging
   * the mock means going back to the real service *once*, deliberately, with the app's own
   * credentials (07-issues-agent-loop.md's re-record run). Without an override the front
   * door would deny — correctly, since a mocked service that quietly reached production
   * would be the worst failure this product has — so the override is explicit, scoped to
   * one run, and named in the run's own report.
   */
  private recordOverride = new Set<string>();
  /** Last proven portless status. Cached because proving it costs a request (redirect/portless.ts). */
  private portless: PortlessStatus | null = null;
  mode: RuntimeMode = { kind: 'idle', sealed: false };

  constructor(project: ResolvedProject) {
    this.project = project;
    ensureRegistered(project);
    this.db = openProjectDb(project.name);
    ensureDefaultProfiles(this.db);
    this.syncRegistryFromConfig();
    this.issues = new IssueEngine(this.db, project.paths?.issuesDir ?? null, (issue) =>
      this.feed.publish({
        kind: 'issue',
        service: issue.service,
        method: issue.method,
        path: issue.pathTemplate,
        statusCode: null,
        mode: null,
        durationMs: null,
        summary: summarize.issue(issue.type, issue.service, issue.status, issue.occurrences),
        ref: issue.id,
      }),
    );
    this.scrubber = new Scrubber(rulesFromConfig(project.file?.scrub), project.file?.scrub?.entropyBackstop ?? true);
    this.noise = new NoiseFilter(project.file?.capture);
    this.configStamp = this.stampConfig();
  }

  get name(): string {
    return this.project.name;
  }
  get resolved(): ResolvedProject {
    return this.project;
  }
  get session(): string | null {
    return this.sessionId;
  }
  get currentScrubber(): Scrubber {
    return this.scrubber;
  }

  /** Re-read `mocktown.json` — an agent editing the registry should not need a restart. */
  reload(): void {
    this.project = resolveProject({ project: this.project.name, cwd: this.project.workspace ?? process.cwd() });
    this.configStamp = this.stampConfig();
    this.syncRegistryFromConfig();
    this.scrubber = new Scrubber(rulesFromConfig(this.project.file?.scrub), this.project.file?.scrub?.entropyBackstop ?? true);
    this.noise = new NoiseFilter(this.project.file?.capture);
  }

  /** Modification times of the two config files, so a reload only happens when one changed. */
  private stampConfig(): string {
    const mtime = (path: string) => {
      try {
        return String(statSync(path).mtimeMs);
      } catch {
        return '-';
      }
    };
    if (!this.project.paths) return '-';
    return `${mtime(this.project.paths.projectFile)}:${mtime(this.project.paths.localConfig)}`;
  }

  reloadIfChanged(): void {
    if (this.stampConfig() !== this.configStamp) this.reload();
  }

  /**
   * The committed file is the source of truth for configured services; the table also
   * holds services discovered from traffic, which the file does not know about yet.
   */
  private syncRegistryFromConfig(): void {
    for (const [host, config] of Object.entries(this.project.file?.services ?? {})) {
      this.db
        .insert(schema.services)
        .values({ id: host, provider: config.provider, seed: config.seed ?? null, discovered: false })
        .onConflictDoUpdate({
          target: schema.services.id,
          set: { provider: config.provider, seed: config.seed ?? null, discovered: false },
        })
        .run();
    }
    for (const host of this.project.local.passthrough) {
      this.db
        .insert(schema.services)
        .values({ id: host, provider: 'passthrough', discovered: false })
        .onConflictDoUpdate({ target: schema.services.id, set: { provider: 'passthrough' } })
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
        onSocket: (socket) => this.onSocket(socket),
        onSocketLifecycle: (event) => this.onSocketLifecycle(event),
        onWallHit: (hit) => this.onWallHit(hit),
        onPinnedClient: (event) => this.onPinnedClient(event),
      },
    );
    await this.frontDoor.start();
    return this.frontDoor;
  }

  private onExchange(exchange: CapturedExchange): void {
    // Served traffic is not persisted, but a seal run still has to know a service was
    // *used* — that is what separates a real redirect gap from a dependency the flows
    // never touched (05-redirection.md).
    if (this.observation) this.observation.services.add(hostOf(exchange.url));

    // Client-runtime noise never becomes evidence: no corpus row, and so no service row
    // either, since `touchService` is what discovers one (capture/noise.ts). It still
    // transited the front door in whatever mode routing chose — filtering the corpus is not
    // a passthrough, and nothing here lets a request out that would otherwise be denied.
    const noise = this.noise.match(exchange.url);
    if (noise) {
      this.noiseTally.note(noise);
      return;
    }

    // Only `record` persists. `passthrough` is explicitly not recorded (03-capture.md's
    // mode table), and `mock` traffic is the mock's own output, not evidence about reality.
    const row = exchange.mode === 'record' && this.recorder ? this.recorder.record(exchange) : null;
    if (row) this.recordedCount++;

    // The feed shows everything the front door did, in every mode — watching mock traffic
    // go by is most of what the GUI is for. It carries no bodies, and the path is
    // templated and scrubbed before it leaves here (09-gui-plugins.md).
    const { service, pathTemplate } = this.describeForFeed(exchange.url);
    this.feed.publish({
      kind: 'exchange',
      service,
      method: exchange.method.toUpperCase(),
      path: pathTemplate,
      statusCode: exchange.statusCode,
      mode: exchange.mode,
      durationMs: exchange.durationMs,
      summary: summarize.exchange(exchange.mode, exchange.method.toUpperCase(), service, pathTemplate, exchange.statusCode),
      ref: row?.id ?? null,
    });
  }

  /**
   * A WebSocket conversation, delivered when it closes. It lands in the corpus by the same
   * rule as an HTTP exchange: only `record` mode persists, because a mock's own frames are
   * not evidence about the real service (03-capture.md's mode table).
   */
  private onSocket(socket: CapturedSocket): void {
    if (this.observation) this.observation.services.add(hostOf(socket.url.replace(/^ws/, 'http')));
    if (socket.mode !== 'record' || !this.recorder) return;
    const row = this.recorder.recordSocket(socket);
    if (row) this.recordedCount++;
  }

  /** A socket opening or closing. The corpus row only lands at close, so the feed says both. */
  private onSocketLifecycle(event: { url: string; phase: 'open' | 'close'; frames: number; mode: string }): void {
    const { service, pathTemplate } = this.describeForFeed(event.url.replace(/^ws/, 'http'));
    this.feed.publish({
      kind: 'socket',
      service,
      method: 'WS',
      path: pathTemplate,
      statusCode: null,
      mode: event.mode,
      durationMs: null,
      summary:
        event.phase === 'open'
          ? `${event.mode} WS open ${service}${pathTemplate}`
          : `${event.mode} WS closed ${service}${pathTemplate} after ${event.frames} frame${event.frames === 1 ? '' : 's'}`,
      ref: null,
    });
  }

  /**
   * A URL reduced to what the feed may carry. The query string is dropped entirely and the
   * path is templated then scrubbed, because a credential in a path segment is a real
   * pattern and the feed is the one surface that shows traffic it does not persist.
   */
  private describeForFeed(url: string): { service: string; pathTemplate: string } {
    try {
      const parsed = new URL(url);
      return { service: parsed.hostname, pathTemplate: this.scrubber.scrubText(templatePath(parsed.pathname)) };
    } catch {
      return { service: '(unparseable)', pathTemplate: '' };
    }
  }

  private onWallHit(hit: WallHit): void {
    const url = new URL(hit.url);
    // A denied browser update is not a missing dependency. The request stays denied — this
    // only keeps it out of a queue a human is expected to work through.
    const noise = this.noise.match(hit.url);
    if (noise) {
      this.noiseTally.note(noise);
      return;
    }

    if (this.observation && this.observation.wallHits.length < MAX_OBSERVED_WALL_HITS) {
      this.observation.wallHits.push({ host: url.hostname, method: hit.method, path: url.pathname, reason: hit.reason });
    }

    const feedPath = this.describeForFeed(hit.url).pathTemplate;
    this.feed.publish({
      kind: 'wall-hit',
      service: url.hostname,
      method: hit.method,
      path: feedPath,
      statusCode: 502,
      mode: 'deny',
      durationMs: null,
      summary: summarize.wallHit(hit.method, url.hostname, feedPath, hit.reason),
      ref: null,
    });
    // Scrub before the request is stored on an issue: issues embed requests and flow
    // through the same scrubber (10-security.md).
    const scrubbed = this.scrubber.scrub({
      id: id('hit'),
      method: hit.method,
      url: hit.url,
      statusCode: 502,
      requestHeaders: hit.headers,
      requestBody: hit.body,
      responseHeaders: {},
      responseBody: '',
    });

    this.issues.file({
      type: hit.reason === 'unknown-host' || hit.reason === 'own-service' ? 'unknown-service' : 'unmatched-request',
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
    const host = event.hostname ?? '(unknown host)';
    this.issues.file({
      type: 'pinned-client',
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

  /** A feed line with no request behind it: a mode change, a provider coming up, a reset. */
  private note(kind: 'session' | 'provider' | 'drift', summary: string, extras: { service?: string; ref?: string } = {}): void {
    this.feed.publish({
      kind,
      service: extras.service ?? null,
      method: null,
      path: null,
      statusCode: null,
      mode: null,
      durationMs: null,
      summary,
      ref: extras.ref ?? null,
    });
  }

  /** A drift run's verdict, for the live feed. The run itself lives in `drift/watch.ts`. */
  announceDrift(summary: string): void {
    this.note('drift', summary);
  }

  /** The routing table the front door applies, derived from the registry and providers. */
  private routingTable(): RoutingTable {
    // Full base URLs, not host:port — the route needs the provider's scheme as well, or
    // an https client reaches a cleartext emulator and gets a 502.
    const baseUrls = this.allBaseUrls();
    const serving = this.mode.kind === 'serve';
    const sealed = serving && this.mode.sealed;
    const servedBy = this.providerNamesByService();
    const routes: Route[] = this.services().map((service) =>
      this.recordOverride.has(service.id)
        ? { host: service.id, mode: 'record' as const }
        : routeForProvider(service.id, service.provider, baseUrls, {
            serving,
            sealed,
            discovered: service.discovered,
            servedBy: servedBy.get(service.id),
          }),
    );

    return {
      routes,
      // In record mode an unknown host is new evidence, so it is recorded. In serve mode
      // it is a wall-hit, so it is denied and filed. Never passthrough, either way.
      fallthrough: this.mode.kind === 'record' ? 'record' : 'deny',
    };
  }

  /**
   * The bypass list for this project, computed rather than fixed: a registered
   * `.localhost` service drops the blanket `localhost` entry, and the project names its
   * own local hosts in `noProxy`. One computation feeds the launch wrapper,
   * `.env.mocktown` and the diagnostics, so they cannot disagree about what bypasses the
   * front door.
   */
  private noProxyPlan(): NoProxyPlan {
    const stable = this.portless?.available ? this.portless : null;
    return planNoProxy({
      declared: this.project.file?.noProxy,
      services: this.services().map((service) => service.id),
      // A stable name must bypass: the app has to reach its own mock directly, or the
      // request for it would enter the front door and be denied as an unknown host.
      required: stable ? [`.${this.portlessSettings().tld}`] : undefined,
    });
  }

  /**
   * What the bypass list costs, in both directions — each one is otherwise a silent
   * failure. A dropped `localhost` sends the app's own services into the front door; an
   * entry that still shadows a registered service means that service can never be
   * recorded, however the run is configured.
   */
  private noProxyWarnings(plan: NoProxyPlan): string[] {
    const warnings: string[] = [];
    if (plan.droppedLocalhost) {
      warnings.push(
        'NO_PROXY no longer carries the blanket `localhost` entry, because a registered service sits under that suffix. ' +
          'Loopback by IP still bypasses the front door, but a service the app reaches as `localhost:<port>` by name now goes ' +
          'through it and will be denied. List those hosts in `noProxy` in mocktown.json.',
      );
    }
    if (plan.bypassed.length > 0) {
      warnings.push(
        `NO_PROXY excludes ${plan.bypassed.join(', ')}, so traffic to ${plan.bypassed.length === 1 ? 'it' : 'them'} cannot be ` +
          'captured. Proxy clients match NO_PROXY by domain suffix, so an entry takes every name underneath it — including the ' +
          'portless TLD, which has to bypass for the app to reach its own mocks. Give the service a name outside those suffixes.',
      );
    }
    return warnings;
  }

  private async applyRouting(): Promise<void> {
    const frontDoor = await this.ensureFrontDoor();
    await frontDoor.applyRouting(this.routingTable());
  }

  // ── Record mode ─────────────────────────────────────────────────────────────

  async startRecord(
    opts: { label?: string; seed?: string; recordOverride?: string[] } = {},
  ): Promise<{ session: string; proxyUrl: string; caCertPath: string; env: Record<string, string>; warnings: string[] }> {
    if (this.mode.kind === 'serve') await this.stopServe();
    this.recordOverride = new Set(opts.recordOverride ?? []);

    this.sessionSeed = opts.seed ?? this.sessionSeed;
    this.sessionId = startSession(this.db, 'record', { seed: this.sessionSeed, label: opts.label });
    this.recordedCount = 0;
    this.noiseTally.reset();
    // A fresh scrubber per session: placeholders are session-scoped by design, which is
    // what makes `{{secret:stripe-secret-key#1}}` mean "the same key as earlier".
    this.scrubber = new Scrubber(rulesFromConfig(this.project.file?.scrub), this.project.file?.scrub?.entropyBackstop ?? true);
    this.noise = new NoiseFilter(this.project.file?.capture);
    this.recorder = new Recorder(this.db, this.project.name, this.scrubber, this.sessionId);
    this.mode = { kind: 'record', sealed: false };
    this.issues.startBatch();

    const frontDoor = await this.ensureFrontDoor();
    await this.applyRouting();

    const ca = await ensureProjectCa(this.project.name);
    await this.syncPortless();
    const proxyUrl = `http://127.0.0.1:${frontDoor.port}`;
    this.note('session', `record mode started on :${frontDoor.port} — session ${this.sessionId}`, { ref: this.sessionId });
    // Computed after `syncPortless`, because a live stable name adds its TLD to the list.
    const noProxy = this.noProxyPlan();
    return {
      session: this.sessionId,
      proxyUrl,
      caCertPath: ca.certPath,
      env: captureEnv({ proxyUrl, caCertPath: ca.certPath, noProxy: noProxy.entries }),
      warnings: this.noProxyWarnings(noProxy),
    };
  }

  async stopRecord(): Promise<{
    session: string | null;
    recorded: number;
    services: string[];
    ignored: { total: number; patterns: { pattern: string; count: number; why: string }[] };
    warnings: string[];
  }> {
    const session = this.sessionId;
    const recorded = this.recordedCount;
    const ignored = { total: this.noiseTally.total, patterns: this.noiseTally.entries() };
    const warnings = recorded === 0 ? this.emptyRecordingHints() : [];
    // A filter nobody can see is how a real dependency goes missing without anyone noticing,
    // so a session that dropped more than it kept says so rather than looking clean.
    if (recorded > 0 && ignored.total > recorded) {
      warnings.push(
        `Dropped ${ignored.total} request${ignored.total === 1 ? '' : 's'} as client-runtime noise, more than the ${recorded} kept. ` +
          'If a dependency of yours is missing from the corpus, name it in `capture.keep` in mocktown.json.',
      );
    }
    const services = session
      ? [
          ...new Set(
            this.db
              .select()
              .from(schema.recordings)
              .where(eq(schema.recordings.sessionId, session))
              .all()
              .map((r) => r.service),
          ),
        ]
      : [];

    if (session) endSession(this.db, session);
    this.recordOverride.clear();
    this.note('session', `record mode stopped — ${recorded} exchange${recorded === 1 ? '' : 's'} recorded`, { ref: session ?? undefined });
    this.recorder = undefined;
    this.sessionId = null;
    this.mode = { kind: 'idle', sealed: false };
    await this.frontDoor?.stop();
    this.frontDoor = undefined;
    return { session, recorded, services, ignored, warnings };
  }

  /**
   * Why a recording run captured nothing. Both causes are invisible from the outside —
   * the app looks correctly configured and the front door reports no error — so the
   * moment the count comes back zero is the only place to say it.
   */
  private emptyRecordingHints(): string[] {
    const plan = this.noProxyPlan();
    return [
      'No exchange reached the front door. The usual cause is a client that ignores the proxy env vars — ' +
        'anything on fetch/undici needs NODE_USE_ENV_PROXY=1, and Java needs the keystore flags (`mocktown env`).',
      // Named when the registry already knows the service, described either way: a host
      // that never got through is a host discovery never saw, so it cannot be listed.
      ...this.noProxyWarnings(plan),
      ...(plan.bypassed.length === 0
        ? [
            `NO_PROXY is \`${plan.entries.join(',')}\`, and proxy clients match it by domain suffix — an entry takes every name ` +
              'underneath it. A service under one of those suffixes, or named in `noProxy` in mocktown.json, never reaches the front door.',
          ]
        : []),
    ];
  }

  // ── Serve mode ──────────────────────────────────────────────────────────────

  async startServe(
    opts: { seed?: string; sealed?: boolean } = {},
  ): Promise<{ session: string; proxyUrl: string; caCertPath: string; env: Record<string, string>; warnings: string[] }> {
    if (this.mode.kind === 'record') await this.stopRecord();

    this.sessionSeed = opts.seed ?? this.sessionSeed;
    this.sessionId = startSession(this.db, 'serve', { seed: this.sessionSeed });
    this.mode = { kind: 'serve', sealed: opts.sealed ?? true };
    this.issues.startBatch();

    await this.startProviders();
    const frontDoor = await this.ensureFrontDoor();
    await this.applyRouting();

    const ca = await ensureProjectCa(this.project.name);
    await this.syncPortless();
    const proxyUrl = `http://127.0.0.1:${frontDoor.port}`;
    this.note(
      'session',
      `serve mode started on :${frontDoor.port} (unknown hosts: ${this.mode.sealed ? 'deny' : 'record'}) — session ${this.sessionId}`,
      { ref: this.sessionId },
    );
    const noProxy = this.noProxyPlan();
    return {
      session: this.sessionId,
      proxyUrl,
      caCertPath: ca.certPath,
      env: captureEnv({ proxyUrl, caCertPath: ca.certPath, noProxy: noProxy.entries }),
      warnings: [...this.providers.flatMap((p) => p.warnings), ...this.escapeWarnings(), ...this.noProxyWarnings(noProxy)],
    };
  }

  /**
   * A served run that still reaches a real third-party API has to say so. The registry
   * decision stands — this is the warning that stops it from being a silent one.
   */
  private escapeWarnings(): string[] {
    return escapingHosts(this.routingTable()).map(
      (host) =>
        `${host} still reaches the real upstream: the registry says \`${this.services().find((s) => s.id === host)?.provider}\`. ` +
        `Serve it with \`mocktown services set --id ${host} --provider generated:${host}\`, or \`--provider deny\` to wall it off.`,
    );
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
            `Merge ${distinctSeeds.slice(1).join(', ')} into it, or the other services run on emulate's built-in defaults.`,
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
    for (const provider of started) {
      this.note('provider', `${provider.name} (${provider.kind}) up for ${provider.services.join(', ') || 'no services'}`, {
        ref: provider.name,
      });
    }
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
      const source = provider.kind === 'emulator' ? 'emulate-skill' : `generated:${provider.name}`;
      const services = new Set(provider.ekbEntries().map((e) => e.service));
      for (const service of services) {
        this.db
          .delete(schema.ekb)
          .where(and(eq(schema.ekb.service, service), eq(schema.ekb.source, source)))
          .run();
      }
      for (const { service, recipe } of provider.ekbEntries()) {
        this.db
          .insert(schema.ekb)
          .values({
            id: id('ekb'),
            service,
            rung: recipe.rung,
            envVar: recipe.envVar ?? null,
            language: recipe.language ?? null,
            snippet: recipe.snippet ?? null,
            note: recipe.note ?? null,
            source,
          })
          .run();
      }
    }
  }

  private onMockUnmatched(event: {
    service: string;
    method: string;
    path: string;
    request: unknown;
    diagnosis: unknown;
    kind: 'unmatched-request' | 'near-miss' | 'unknown-service';
    suggestedResolution: string;
  }): void {
    const generated = this.providers.find((p) => p.kind === 'generated') as GeneratedProvider | undefined;
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
    await this.releaseStableNames();
    this.note('session', stopped.length ? `serve mode stopped — ${stopped.join(', ')} down` : 'serve mode stopped');
    if (this.sessionId) endSession(this.db, this.sessionId);
    this.sessionId = null;
    this.mode = { kind: 'idle', sealed: false };
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
   * One service's state, whichever provider serves it. Awaited because emulate-backed
   * introspection is an HTTP round trip to the emulator's own API, while a generated mock
   * reads our SQLite (06-emulation.md).
   */
  async stateFor(service: string, opts: { profile?: string; collection?: string } = {}): Promise<StateSnapshot & { provider: string }> {
    const provider = this.providerFor(service);
    if (!provider) {
      throw new Error(`no running provider serves "${service}". Run \`mocktown serve start\` first.`);
    }
    const snapshot = provider.state
      ? await provider.state(service, opts)
      : { collections: [], note: `The ${provider.kind} provider does not implement state introspection.` };
    return { ...snapshot, provider: provider.name };
  }

  /**
   * State across every provider at once — the shape a GUI dashboard and a panel index
   * need. Counts only: a full dump per service could be enormous, and `state get` is one
   * call away. A service whose provider cannot introspect is *listed*, with the reason,
   * rather than omitted; a missing row would read as "this service has no state".
   */
  async stateOverview(profile?: string): Promise<
    {
      service: string;
      provider: string | null;
      introspectable: boolean;
      collections: { name: string; count: number }[];
      note: string | null;
    }[]
  > {
    const rows = [];
    for (const service of this.services()) {
      const provider = this.providerFor(service.id);
      if (!provider) {
        rows.push({
          service: service.id,
          provider: null,
          introspectable: false,
          collections: [],
          note: `Not served by a running provider (registry says \`${service.provider}\`), so it has no state to read.`,
        });
        continue;
      }
      const snapshot = await this.stateFor(service.id, { profile });
      rows.push({
        service: service.id,
        provider: provider.name,
        introspectable: snapshot.collections.length > 0,
        collections: snapshot.collections.map((c) => ({ name: c.name, count: c.count })),
        note: snapshot.note,
      });
    }
    return rows;
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
      if (provider.kind === 'emulator') restarted.push(provider.name);
    }

    if (this.sessionId) endSession(this.db, this.sessionId);
    this.sessionId = startSession(this.db, this.mode.kind === 'record' ? 'record' : 'serve', { seed: this.sessionSeed });
    this.db
      .insert(schema.journal)
      .values({ id: id('jrn'), sessionId: this.sessionId, kind: 'state-reset', service: scope.service ?? null, payload: scope })
      .run();

    this.note(
      'session',
      `state reset for ${reset.length ? [...new Set(reset)].join(', ') : 'nothing running'} — session ${this.sessionId}`,
      {
        ref: this.sessionId,
      },
    );

    // Provider base URLs change across an emulate restart, so routing has to follow.
    if (this.frontDoor?.isRunning) await this.applyRouting();

    return { reset: [...new Set(reset)], session: this.sessionId, restarted };
  }

  // ── The sandbox ─────────────────────────────────────────────────────────────

  /**
   * Built from the *current* project file every time, so a `mocktown.json` edit to the
   * base image or the port list takes effect on the next `sandbox up` without a daemon
   * restart. It is safe to rebuild freely: the boundary's state lives on disk and in the
   * container engine, never in this object.
   */
  private sandbox(): Sandbox {
    return new Sandbox({
      project: this.project.name,
      workspace: this.project.workspace,
      dataDir: projectPaths(this.project.name).root,
      loadCaCert: async () => (await ensureProjectCa(this.project.name)).cert,
      config: {
        image: this.project.file?.sandbox.image ?? 'auto',
        browser: this.project.file?.sandbox.browser ?? true,
        ports: this.project.file?.sandbox.ports ?? [],
      },
    });
  }

  sandboxStatus(): Promise<SandboxStatus> {
    return this.sandbox().status();
  }

  /**
   * The sandbox needs a front door to relay to, so a mode is started if none is running.
   * `record` and `sealed` differ only in the front door's fallthrough — the boundary
   * itself is identical, which is what makes `sandbox record` usable for building the
   * corpus and for certification alike (04-sandbox.md).
   */
  async sandboxUp(opts: { mode?: SandboxMode; frontDoorPort?: number; rebuild?: boolean } = {}): Promise<SandboxStatus> {
    const mode = opts.mode ?? 'sealed';
    let port = opts.frontDoorPort ?? this.frontDoorStatus().port;
    if (!port) {
      if (mode === 'record') await this.startRecord({ label: 'sandbox' });
      else await this.startServe({ sealed: true });
      port = this.frontDoorStatus().port;
    }
    if (!port) throw new Error('the front door could not be started, so there is nothing for the sandbox to relay to');
    return this.sandbox().up({ mode, frontDoorPort: port, rebuild: opts.rebuild });
  }

  sandboxDown(): Promise<{ removed: string[] }> {
    return this.sandbox().down();
  }

  sandboxExec(command: string): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return this.sandbox().exec(command);
  }

  sandboxVerify(): Promise<SandboxVerifyResult> {
    const sandbox = this.sandbox();
    const state = sandbox.readState();
    if (!state) {
      return Promise.resolve({
        ok: false,
        checks: [{ name: 'sandbox is running' as const, status: 'fail' as const, detail: 'bring it up first with `mocktown sandbox up`' }],
        probedHost: null,
      });
    }
    return verifySandbox(sandbox, { mode: state.mode, image: state.image });
  }

  // ── Observation windows ─────────────────────────────────────────────────────

  beginObservation(): void {
    this.observation = { services: new Set(), wallHits: [] };
  }

  endObservation(): Observation {
    const observed = this.observation ?? { services: new Set<string>(), wallHits: [] };
    this.observation = null;
    return observed;
  }

  /**
   * The generated env-var setup. It lives here rather than in the API handler because the
   * seal reads the same coverage report the `env` procedures render — one computation, so
   * a service reported "covered" by `mocktown env` cannot be a redirect gap in a seal run.
   */
  envArtifacts(): EnvArtifacts {
    const frontDoor = this.frontDoorStatus();
    const portless = this.portless;
    const stable = portless?.available ? portless : null;
    // A stable name is only written once it has been proven end to end, and it brings a CA
    // bundle covering the portless issuer as well as the project's. Its TLD reaches
    // NO_PROXY through `noProxyPlan`, which owns that decision for every surface.
    const baseUrls = this.allBaseUrls();
    for (const entry of stable?.names ?? []) baseUrls.set(entry.service, entry.url);
    return generateEnv({
      project: this.name,
      proxyUrl: `http://127.0.0.1:${frontDoor.port ?? this.project.local.frontDoorPort ?? 4400}`,
      caCertPath: stable?.caBundle ?? projectPaths(this.name).caCert,
      noProxy: this.noProxyPlan().entries,
      baseUrls,
      ekb: this.db
        .select()
        .from(schema.ekb)
        .all()
        .map((row) => ({ ...row })),
      services: this.services().map((s) => s.id),
    });
  }

  // ── Stable names ────────────────────────────────────────────────────────────

  private portlessSettings(): PortlessSettings {
    const config = this.project.file?.portless;
    return { tld: config?.tld ?? 'localhost', port: config?.port ?? 443, tls: config?.tls ?? true };
  }

  /** The last proven status, never a guess: an unsynced project says so rather than reading as broken. */
  portlessStatus(): PortlessStatus {
    const enabled = this.project.file?.portless?.enabled ?? false;
    return (
      this.portless ??
      unavailable(
        enabled,
        enabled ? 'no serve session has synced stable names yet — `mocktown env portless sync`' : 'portless is off for this project',
      )
    );
  }

  /**
   * Prove portless works and claim a name per service. Best-effort by construction: this
   * is called from `startServe`, and a portless failure must never be the reason a mock
   * session did not start (05-redirection.md — wrapped, not load-bearing).
   */
  async syncPortless(): Promise<PortlessStatus> {
    const enabled = this.project.file?.portless?.enabled ?? false;
    try {
      this.portless = await syncPortless({
        project: this.project.name,
        workspace: this.project.workspace,
        enabled,
        settings: this.portlessSettings(),
        baseUrls: this.allBaseUrls(),
        projectCaPath: projectPaths(this.project.name).caCert,
      });
    } catch (error) {
      this.portless = unavailable(enabled, `portless sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (enabled)
      this.note(
        'provider',
        this.portless.available
          ? `stable names: ${this.portless.names.map((n) => n.url).join(', ')}`
          : `stable names unavailable — ${this.portless.reason}`,
      );
    return this.portless;
  }

  private async releaseStableNames(): Promise<void> {
    if (!this.portless) return;
    await releasePortless(this.portless, this.portlessSettings(), this.project.workspace).catch(() => {});
    this.portless = null;
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
      mode: (this.mode.kind === 'record' ? 'record' : 'deny') as 'record' | 'deny',
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

  /** Which provider is serving each host right now, for routing and issue attribution. */
  private providerNamesByService(): Map<string, string> {
    const out = new Map<string, string>();
    for (const provider of this.providers) for (const service of provider.baseUrls().keys()) out.set(service, provider.name);
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
  if (existing) {
    existing.reloadIfChanged();
    return existing;
  }
  const runtime = new ProjectRuntime(resolveProject({ project: projectName, cwd }));
  runtime.ensureDirs();
  runtimes.set(projectName, runtime);
  return runtime;
}

export async function shutdownAllRuntimes(): Promise<void> {
  await Promise.all([...runtimes.values()].map((r) => r.shutdown()));
  runtimes.clear();
}

/** The service a URL belongs to, for the observation window. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Why a request hit the wall, and what to do about it. An issue must be resolvable by an
 * agent that read nothing but the issue (07-issues-agent-loop.md), so a wrong reason here
 * is worse than a vague one — it sends the agent to edit the wrong thing.
 */
const WALL_REASONS: Record<WallHit['reason'], (host: string, provider?: string) => string> = {
  'unknown-host': (host) =>
    `No entry in the service registry for "${host}", and the front door is sealed, so the request was denied rather than sent to the real host.`,
  deny: (host) => `"${host}" is registered as \`deny\`.`,
  'provider-down': (host, provider) =>
    `"${host}" is registered as \`${provider}\`, but that provider is not running, so there was nowhere to send the request. Denying is deliberate: falling back to the real host would leak traffic to production.`,
  // Loopback, so almost certainly not a dependency at all. Reporting it as an undeclared
  // third-party service would send an agent off to write a mock for the app's own API.
  'own-service': (host) =>
    `"${host}" is a loopback name, so this looks like the app calling one of its own local services rather than a third-party dependency. It reached the front door because NO_PROXY does not exclude it, and the front door is sealed, so it was denied.`,
};

const WALL_RESOLUTIONS: Record<WallHit['reason'], (host: string, provider?: string) => string> = {
  'unknown-host': (host) =>
    `Decide what this host should be: \`mocktown services set --id ${host} --provider record\` to capture it, \`generated:${host}\` to mock it, or \`passthrough\` to allow it out explicitly.`,
  deny: (host) => `Change the registry entry for ${host} if this request should be served.`,
  'provider-down': (_host) =>
    `Find out why the provider did not start — \`mocktown providers list\` reports the load error — then \`mocktown serve start\` again. For a generated mock, a module that fails to import is the usual cause.`,
  'own-service': (host) =>
    `If this is the app's own service, add "${host}" to \`noProxy\` in mocktown.json and start the run again — it will then bypass the front door entirely. If it really is a dependency that happens to live on loopback, register it: \`mocktown services set --id ${host} --provider generated:${host}\`.`,
};
