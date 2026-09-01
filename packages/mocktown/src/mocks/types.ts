/**
 * The generated-mock module API — the artifact a coding agent writes and patches
 * (06-emulation.md, "this is the moat").
 *
 * A generated mock is a **plain Bun/TypeScript module** in the project workspace, not a
 * config file and not a template expansion. Mocktown's contribution is the harness
 * around it: the corpus in agent-legible form, a generation brief with house rules, a
 * replay-verify pass, and the issue loop for everything that slips through.
 *
 * The fidelity bar is *emulator, not stub*: `POST /orders` followed by
 * `GET /orders/{orderId}` must return the created order. That is why every handler gets
 * a `state` store rather than a canned response list.
 */
import * as z from 'zod/v4';
import type { Prng } from '#src/mocks/prng.ts';

// Re-exported so a generated mock has exactly one dependency. Knob schemas need Zod, and
// requiring every mocked app to add it — at a version matching ours — is friction with no
// upside, since the daemon validates knob values against these schemas itself.
export { z };

export interface MockRequest {
  method: string;
  /** Path as received, e.g. `/v1/orders/8812`. */
  path: string;
  /** Parameters extracted from the route template: `{ orderId: "8812" }`. */
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Parsed JSON body when the content type says so, otherwise the raw text. */
  body: unknown;
  rawBody: string;
  /** Credentials arrive as scrubber placeholders in replay; shape, never a real secret. */
  auth: string | null;
}

/** A namespaced key/value store per (service, profile). Reset is drop + re-seed. */
export interface StateStore {
  get<T = unknown>(collection: string, key: string): T | undefined;
  set(collection: string, key: string, value: unknown, options?: { seeded?: boolean }): void;
  delete(collection: string, key: string): boolean;
  list<T = unknown>(collection: string): { key: string; value: T }[];
  count(collection: string): number;
  /** Monotonic per-collection id, so created entities are addressable and stable. */
  nextId(collection: string, prefix?: string): string;
}

export interface MockCtx {
  service: string;
  /** The persona this request authenticated as; `anonymous` when unauthenticated. */
  profile: string;
  /** Seeded stream for this endpoint+profile+request. Never use `Math.random()`. */
  prng: Prng;
  /** Effective knob values, with profile overrides already applied. */
  knobs: Record<string, unknown>;
  state: StateStore;
  /** Same-shape fake credentials, for mocks that must echo one back. */
  fakeSecret(kind: string, ordinal?: number): string;
  /**
   * Sign-in is real for generated mocks (12-scenario-controls.md): a login route checks
   * the submitted credentials against the profile roster and gets back a token tagged to
   * that persona, which the front door then maps to `ctx.profile` on later requests.
   * Returns null when no profile owns those credentials.
   */
  signIn(credentials: Record<string, string>): { profile: string; token: string } | null;
}

export interface MockResponse {
  status: number;
  headers?: Record<string, string>;
  /** Serialized as JSON unless `raw` is set. */
  body?: unknown;
  raw?: string;
}

export interface MockRoute {
  method: string;
  /** Route template in corpus form: `/v1/orders/{orderId}`. */
  path: string;
  /** One line saying what this route does — it shows up in issues and the GUI. */
  describe?: string;
  handler: (req: MockRequest, ctx: MockCtx) => MockResponse | Promise<MockResponse>;
}

/**
 * A knob is an agent-declared configuration parameter. Declaration is a Zod schema, so
 * the GUI renders its form with no per-mock UI work (12-scenario-controls.md).
 */
export interface KnobDefinition {
  schema: z.ZodType;
  default: unknown;
  /** One line. This is what a human reads while deciding whether to turn it. */
  description: string;
}

export type KnobManifest = Record<string, KnobDefinition>;

export interface SeedCtx {
  state: StateStore;
  profile: string;
  prng: Prng;
}

/** Every generated mock must add its own EKB entry (05-redirection.md). */
export interface EndpointRecipe {
  rung: 1 | 2 | 3;
  envVar?: string;
  language?: string;
  snippet?: string;
  note?: string;
}

export interface MockModule {
  /** The hostname this mock serves, e.g. `internal-billing.acme`. */
  service: string;
  routes: MockRoute[];
  knobs?: KnobManifest;
  /**
   * Seed data per profile. Every project starts with at least `default` (typical data,
   * informed by recorded traffic) and `empty-org` (zero everything, synthesized) —
   * empty states are the scenario teams most often cannot test.
   */
  seed?: (ctx: SeedCtx) => void | Promise<void>;
  ekb?: EndpointRecipe[];
}

/** Identity helper: gives generated modules a typed shape without a class or decorator. */
export function defineMock(mock: MockModule): MockModule {
  return mock;
}
