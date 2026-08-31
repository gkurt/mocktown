/**
 * The generated-mock provider: one supervisor for every long-tail service the project's
 * committed `mocks/` directory declares (06-emulation.md, "this is the moat").
 *
 * Unlike the emulate provider, this one has no child process — generated mocks are plain
 * Bun modules, so the whole set is served from a single in-daemon listener. That is also
 * why reset here is a drop + re-seed of SQLite rather than a process restart, and cheap
 * enough to run between test cases (12-scenario-controls.md).
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { MockHost, type MockHostDeps } from "../mocks/host.ts";
import { loadMocks, type LoadedMock } from "../mocks/loader.ts";
import { SqliteStateStore } from "../mocks/state.ts";
import { Prng, streamKey } from "../mocks/prng.ts";
import type { KnobManifest, StateStore } from "../mocks/types.ts";
import type { EndpointRecipe } from "../mocks/types.ts";
import type { Provider, ProviderCtx, ResetScope, StateSnapshot } from "./types.ts";

export interface GeneratedProviderOptions {
  db: Db;
  mocksDir: string;
  knobsFor: MockHostDeps["knobsFor"];
  onUnmatched: MockHostDeps["onUnmatched"];
}

export class GeneratedProvider implements Provider {
  readonly name = "generated";
  readonly kind = "generated" as const;
  private host?: MockHost;
  private loaded: LoadedMock[] = [];
  private ctx?: ProviderCtx;
  warnings: string[] = [];

  constructor(private readonly options: GeneratedProviderOptions) {}

  get services(): string[] {
    return this.loaded.map((m) => m.module.service);
  }

  get running(): boolean {
    return !!this.host;
  }

  /** Where each service's mock listens. One port serves all of them, routed by Host. */
  baseUrls(): Map<string, string> {
    if (!this.host) return new Map();
    return new Map(this.services.map((service) => [service, `http://127.0.0.1:${this.host!.port}`]));
  }

  /** Mock modules loaded, and the ones that failed to load — never silently dropped. */
  loadFailures: { service: string; file: string; reason: string }[] = [];

  async start(ctx: ProviderCtx): Promise<Map<string, string>> {
    this.ctx = ctx;
    const { mocks, failures } = await loadMocks(this.options.mocksDir);
    this.loaded = mocks;
    this.loadFailures = failures;
    this.warnings = failures.map((f) => `mock "${f.service}" failed to load: ${f.reason}`);

    this.host ??= new MockHost({
      db: this.options.db,
      sessionId: ctx.sessionId,
      sessionSeed: ctx.sessionSeed,
      knobsFor: this.options.knobsFor,
      onUnmatched: this.options.onUnmatched,
    });
    this.host.setModules(mocks.map((m) => m.module));
    await this.host.start();

    this.seedMissing(ctx);
    return this.baseUrls();
  }

  /**
   * The seed IS the reset target (12-scenario-controls.md), so it is applied once per
   * (service, profile) and left alone afterwards — re-running it on every start would
   * wipe state the app built up during a session.
   */
  private seedMissing(ctx: ProviderCtx): void {
    const profiles = this.options.db.select().from(schema.profiles).all();
    for (const { module } of this.loaded) {
      if (!module.seed) continue;
      for (const profile of profiles) {
        const alreadySeeded = this.options.db
          .select()
          .from(schema.mockState)
          .where(and(
            eq(schema.mockState.service, module.service),
            eq(schema.mockState.profile, profile.name),
            eq(schema.mockState.seeded, true),
          ))
          .get();
        if (alreadySeeded) continue;
        this.seedOne(ctx, module.service, profile.name);
      }
    }
  }

  private seedOne(ctx: ProviderCtx, service: string, profile: string): void {
    const module = this.loaded.find((m) => m.module.service === service)?.module;
    if (!module?.seed) return;
    const state = new SqliteStateStore(this.options.db, service, profile);
    const prng = new Prng(streamKey({
      sessionSeed: ctx.sessionSeed, service, endpoint: "__seed__", profile, requestIdentity: "seed",
    }));
    // Seeded rows are marked, so `state reset` can tell fixture data from what the app made.
    const marking: StateStore = {
      get: state.get.bind(state),
      set: (collection, key, value, options) => state.set(collection, key, value, { seeded: true, ...options }),
      delete: state.delete.bind(state),
      list: state.list.bind(state),
      count: state.count.bind(state),
      nextId: state.nextId.bind(state),
    };
    module.seed({ state: marking, profile, prng });
  }

  async reset(scope: ResetScope): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) throw new Error("generated provider was never started");
    const services = scope.service ? [scope.service] : this.services;
    const profiles = scope.profile
      ? [scope.profile]
      : this.options.db.select().from(schema.profiles).all().map((p) => p.name);

    for (const service of services) {
      for (const profile of profiles) {
        this.options.db.delete(schema.mockState).where(and(
          eq(schema.mockState.service, service),
          eq(schema.mockState.profile, profile),
        )).run();
        this.seedOne(ctx, service, profile);
      }
    }
  }

  knobs(service: string): KnobManifest | undefined {
    return this.loaded.find((m) => m.module.service === service)?.module.knobs;
  }

  /** Free for generated mocks: their state is our SQLite (06-emulation.md). */
  state(service: string, opts: { profile?: string; collection?: string }): StateSnapshot {
    const rows = this.options.db
      .select()
      .from(schema.mockState)
      .where(and(
        eq(schema.mockState.service, service),
        ...(opts.profile ? [eq(schema.mockState.profile, opts.profile)] : []),
        ...(opts.collection ? [eq(schema.mockState.collection, opts.collection)] : []),
      ))
      .all();

    const byCollection = new Map<string, { key: string; profile: string; seeded: boolean; value: unknown }[]>();
    for (const row of rows) {
      const list = byCollection.get(row.collection) ?? [];
      list.push({ key: row.key, profile: row.profile, seeded: row.seeded, value: row.value });
      byCollection.set(row.collection, list);
    }

    return {
      collections: [...byCollection].map(([name, entries]) => ({ name, count: entries.length, entries })),
      note: null,
    };
  }

  ekbEntries(): { service: string; recipe: EndpointRecipe }[] {
    return this.loaded.flatMap(({ module }) =>
      (module.ekb ?? []).map((recipe) => ({ service: module.service, recipe })));
  }

  /** The file each service's module was loaded from — issues link to it directly. */
  moduleFile(service: string): string | null {
    return this.loaded.find((m) => m.module.service === service)?.file ?? null;
  }

  async stop(): Promise<void> {
    await this.host?.stop();
    this.host = undefined;
  }
}
