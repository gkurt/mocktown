/**
 * The provider interface — 06-emulation.md's seam, and the reason Mocktown is not
 * coupled to any one mocking backend.
 *
 * Amended by spike 03: **a provider is a supervisor for a set of services, not one
 * object per service.** One `emulate` process serves Stripe on 4400 and GitHub on 4401,
 * so `start()` returns a service -> baseUrl map rather than a single URL, and port
 * allocation has to reserve a contiguous run.
 */
import type { EndpointRecipe, KnobManifest } from '#src/mocks/types.ts';

export interface ProviderCtx {
  project: string;
  /** Repo root, for resolving seed paths relative to committed config. */
  workspace: string | null;
  sessionId: string;
  sessionSeed: string;
}

export interface ResetScope {
  service?: string;
  profile?: string;
}

export interface StateSnapshot {
  collections: { name: string; count: number; entries: { key: string; profile: string; seeded: boolean; value: unknown }[] }[];
  /** Set when introspection is best-effort — for emulate, gaps here are acceptable. */
  note: string | null;
}

export interface Provider {
  /** Stable name used by `mocktown providers restart <name>`. */
  name: string;
  kind: 'emulator' | 'generated' | 'passthrough';
  /** Hostnames or logical service ids this backend serves. */
  services: string[];
  running: boolean;
  /** Non-fatal facts a user must see — e.g. emulate binding every interface (spike 03). */
  warnings: string[];

  start(ctx: ProviderCtx): Promise<Map<string, string>>;
  stop(): Promise<void>;
  /** Back to seed, per profile or wholesale (12-scenario-controls.md). */
  reset(scope: ResetScope): Promise<void>;

  baseUrls(): Map<string, string>;
  knobs?(service: string): KnobManifest | undefined;
  state?(service: string, opts: { profile?: string; collection?: string }): StateSnapshot;
  /** How clients get pointed at each service (05-redirection.md). */
  ekbEntries(): { service: string; recipe: EndpointRecipe }[];
}
