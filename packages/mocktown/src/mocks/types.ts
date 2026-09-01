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
 * The upgrade request a socket handler is given. There is no body — a WebSocket handshake
 * is a GET — so everything a mock can branch on is here.
 */
export interface MockSocketRequest {
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  /** Subprotocols the client offered, in its order of preference. */
  protocols: string[];
  auth: string | null;
}

/** One frame, as the mock sees it. `data` is a string for text frames, bytes for binary. */
export interface MockSocketMessage {
  data: string | Uint8Array;
  isBinary: boolean;
}

/**
 * What a socket handler can do: the whole of `MockCtx` plus the connection itself. Sockets
 * are the one place a mock is not request/response, so `send` is the only way to say
 * anything and there is no return value to speak of.
 */
export interface MockSocketCtx extends MockCtx {
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  /** Per-connection scratch space. Reset when the socket closes, unlike `ctx.state`. */
  readonly connection: Record<string, unknown>;
}

/**
 * A mocked WebSocket channel (03-capture.md's deferred list, picked up in phase 4).
 *
 * Matched by path template exactly like a route, so `/v1/streams/{streamId}` works and the
 * corpus's own path templating lines up with what a mock declares. A service with no
 * matching channel rejects the upgrade and files an issue — the same loud failure an
 * unmatched HTTP request gets, rather than a socket that connects and then says nothing,
 * which is the hardest kind of mock bug to diagnose.
 */
export interface MockSocket {
  /** Route template in corpus form: `/v1/streams/{streamId}`. */
  path: string;
  /** One line saying what this channel carries — it shows up in issues and the GUI. */
  describe?: string;
  /** Subprotocol to accept, when the recorded traffic negotiated one. */
  protocol?: string;
  onOpen?: (req: MockSocketRequest, ctx: MockSocketCtx) => void | Promise<void>;
  onMessage?: (message: MockSocketMessage, req: MockSocketRequest, ctx: MockSocketCtx) => void | Promise<void>;
  onClose?: (event: { code: number; reason: string }, req: MockSocketRequest, ctx: MockSocketCtx) => void | Promise<void>;
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
  /** WebSocket channels this mock serves. Optional: most services have none. */
  sockets?: MockSocket[];
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
