/**
 * One SQLite file per project (02-architecture.md), holding everything machine-local:
 * the recordings corpus, issues, the endpoint knowledge base, seal stamps, scenario
 * state and the backing state of generated mocks.
 *
 * Drizzle gives us a free state viewer through Drizzle Studio (09-gui-plugins.md), so
 * table and column names are chosen to read well in it rather than to be terse.
 */
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** The service registry, as the daemon sees it: config plus observed runtime facts. */
export const services = sqliteTable('services', {
  id: text('id').primaryKey(), // hostname or logical service id
  provider: text('provider').notNull(), // ProviderRef, see config/schema.ts
  seed: text('seed'),
  /** Set when the registry entry came from observed traffic rather than mocktown.json. */
  discovered: integer('discovered', { mode: 'boolean' }).notNull().default(false),
  lastSeenAt: text('last_seen_at'),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * One continuous run of the mock environment (12-scenario-controls.md). Owns the
 * session seed every PRNG stream derives from, so a session is reproducible.
 */
export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  mode: text('mode', { enum: ['record', 'serve', 'import', 'verify'] }).notNull(),
  seed: text('seed').notNull(),
  label: text('label'),
  startedAt: text('started_at').notNull().default(now),
  endedAt: text('ended_at'),
});

/**
 * The corpus. Normalization happens at write time (03-capture.md) so the rows are
 * immediately agent-legible, and bodies arrive already scrubbed — the raw exchange is
 * never persisted (10-security.md).
 */
export const recordings = sqliteTable(
  'recordings',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id),
    service: text('service').notNull(),
    method: text('method').notNull(),
    path: text('path').notNull(),
    /** Path with ids replaced, e.g. `/orders/{id}` — the grouping key agents reason about. */
    pathTemplate: text('path_template').notNull(),
    query: text('query', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    statusCode: integer('status_code').notNull(),
    requestHeaders: text('request_headers', { mode: 'json' }).$type<Record<string, string | string[]>>().notNull(),
    responseHeaders: text('response_headers', { mode: 'json' }).$type<Record<string, string | string[]>>().notNull(),
    /** Inline body, or null when it was large enough to land in `blobs/` instead. */
    requestBody: text('request_body'),
    responseBody: text('response_body'),
    requestBlob: text('request_blob'),
    responseBlob: text('response_blob'),
    durationMs: integer('duration_ms'),
    /**
     * What protocol this row is. `http` is the overwhelming majority; `websocket` rows own
     * a set of `socket_frames`, and `grpc` rows are opaque h2 with base64 bodies
     * (03-capture.md's deferred list, picked up in phase 4).
     */
    kind: text('kind', { enum: ['http', 'websocket', 'grpc'] })
      .notNull()
      .default('http'),
    /**
     * `base64` when that side's body is not valid UTF-8. A gRPC frame is length-prefixed
     * protobuf: storing it as a string corrupts it silently, and a corrupted corpus is
     * worse than none. Per side, because a JSON request with a PNG response is ordinary and
     * base64-ing the readable half would cost the corpus its legibility for nothing.
     */
    requestEncoding: text('request_encoding', { enum: ['text', 'base64'] })
      .notNull()
      .default('text'),
    responseEncoding: text('response_encoding', { enum: ['text', 'base64'] })
      .notNull()
      .default('text'),
    /** WebSocket only: how the connection ended, and which side ended it. */
    socketClose: text('socket_close', { mode: 'json' }).$type<{ code: number; reason: string; by: 'client' | 'upstream' } | null>(),
    /** What the scrubber found: kinds and counts only, never values. */
    scrubSummary: text('scrub_summary', { mode: 'json' }).$type<{ kind: string; count: number }[]>().notNull().default([]),
    source: text('source', { enum: ['front-door', 'har'] })
      .notNull()
      .default('front-door'),
    recordedAt: text('recorded_at').notNull().default(now),
  },
  (t) => [
    index('recordings_service_idx').on(t.service),
    index('recordings_route_idx').on(t.service, t.method, t.pathTemplate),
    index('recordings_session_idx').on(t.sessionId),
  ],
);

/**
 * One WebSocket message. Frames live in their own table rather than as a JSON blob on the
 * recording because a long-lived socket can carry thousands of them, and the corpus is
 * meant to be queryable — "what does this service push on this channel" is the question a
 * generating agent asks (03-capture.md).
 */
export const socketFrames = sqliteTable(
  'socket_frames',
  {
    id: text('id').primaryKey(),
    recordingId: text('recording_id')
      .notNull()
      .references(() => recordings.id),
    /** Order within the connection. The wire has no other stable identity for a frame. */
    ordinal: integer('ordinal').notNull(),
    /** Direction as the *client* sees it: `sent` is client -> service. */
    direction: text('direction', { enum: ['sent', 'received'] }).notNull(),
    encoding: text('encoding', { enum: ['text', 'base64'] })
      .notNull()
      .default('text'),
    /** Scrubbed before it lands here, like every other body (10-security.md). */
    body: text('body').notNull(),
    /** Milliseconds since the socket opened, so a mock can reproduce the cadence. */
    atMs: integer('at_ms').notNull(),
  },
  (t) => [index('socket_frames_recording_idx').on(t.recordingId, t.ordinal)],
);

/**
 * A drift-watch run (07-issues-agent-loop.md's "the mock rotted" problem). Each run is a
 * re-record against the *real* services followed by a replay against the providers, so the
 * row records what it cost as well as what it found.
 */
export const driftRuns = sqliteTable('drift_runs', {
  id: text('id').primaryKey(),
  /** The recording session the re-record produced — the fresh evidence this run judged. */
  sessionId: text('session_id'),
  trigger: text('trigger', { enum: ['manual', 'scheduled'] })
    .notNull()
    .default('manual'),
  services: text('services', { mode: 'json' }).$type<string[]>().notNull().default([]),
  flows: text('flows', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Routes compared, and how many diverged. */
  checked: integer('checked').notNull().default(0),
  drifted: integer('drifted').notNull().default(0),
  issues: text('issues', { mode: 'json' }).$type<string[]>().notNull().default([]),
  /** Why a run proved nothing — no flows, no corpus, a flow that failed to run. */
  reasons: text('reasons', { mode: 'json' }).$type<string[]>().notNull().default([]),
  startedAt: text('started_at').notNull().default(now),
  finishedAt: text('finished_at'),
});

/** The issue taxonomy from 07-issues-agent-loop.md. */
export const issues = sqliteTable(
  'issues',
  {
    id: text('id').primaryKey(),
    type: text('type', {
      enum: [
        'unknown-service',
        'unmatched-request',
        'near-miss',
        'state-violation',
        'redirect-gap',
        'pinned-client',
        'provider-drift',
        'undeclared-service',
      ],
    }).notNull(),
    status: text('status', { enum: ['open', 'resolved', 'verifying', 'reopened'] })
      .notNull()
      .default('open'),
    service: text('service').notNull(),
    method: text('method'),
    path: text('path'),
    pathTemplate: text('path_template'),
    /** Groups one run's issues so an agent fixes a coherent set (07's batching). */
    batchId: text('batch_id'),
    sessionId: text('session_id'),
    /** The full scrubbed request, so an issue is self-contained. */
    request: text('request', { mode: 'json' }).$type<unknown>(),
    /** Nearest existing behavior and *why* it didn't match (WireMock-style near-miss). */
    diagnosis: text('diagnosis', { mode: 'json' }).$type<unknown>(),
    suggestedResolution: text('suggested_resolution'),
    /** Corpus rows and files an agent should read; an issue links its own evidence. */
    links: text('links', { mode: 'json' }).$type<string[]>().notNull().default([]),
    occurrences: integer('occurrences').notNull().default(1),
    resolutionNote: text('resolution_note'),
    createdAt: text('created_at').notNull().default(now),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    index('issues_status_idx').on(t.status),
    // One issue per distinct failure, incremented rather than duplicated.
    uniqueIndex('issues_dedupe_idx').on(t.type, t.service, t.method, t.pathTemplate),
  ],
);

/** The endpoint knowledge base (05-redirection.md) — an accreting project asset. */
export const ekb = sqliteTable(
  'ekb',
  {
    id: text('id').primaryKey(),
    service: text('service').notNull(),
    /** 1 = env var, 2 = SDK constructor option, 3 = code patch (05's preference order). */
    rung: integer('rung').notNull(),
    envVar: text('env_var'),
    language: text('language'),
    snippet: text('snippet'),
    note: text('note'),
    /** `builtin` | `emulate-skill` | `generated:<service>` | `user`. */
    source: text('source').notNull().default('builtin'),
    createdAt: text('created_at').notNull().default(now),
  },
  (t) => [index('ekb_service_idx').on(t.service)],
);

/** Seal stamps (05-redirection.md): a seal is only as good as the flows exercised. */
export const sealStamps = sqliteTable('seal_stamps', {
  id: text('id').primaryKey(),
  commit: text('commit'),
  configHash: text('config_hash').notNull(),
  sealed: integer('sealed', { mode: 'boolean' }).notNull(),
  flows: text('flows', { mode: 'json' }).$type<string[]>().notNull().default([]),
  wallHits: integer('wall_hits').notNull().default(0),
  createdAt: text('created_at').notNull().default(now),
});

/** Knob values are project state, not config (12-scenario-controls.md). */
export const knobValues = sqliteTable(
  'knob_values',
  {
    service: text('service').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [primaryKey({ columns: [t.service, t.key] })],
);

/**
 * Every knob change is a journaled state event, so reproducing a run means replaying
 * its knob events too (12-scenario-controls.md).
 */
export const journal = sqliteTable(
  'journal',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    kind: text('kind', { enum: ['knob-set', 'state-reset', 'profile-session', 'session-start'] }).notNull(),
    service: text('service'),
    payload: text('payload', { mode: 'json' }).$type<unknown>().notNull(),
    at: text('at').notNull().default(now),
  },
  (t) => [index('journal_session_idx').on(t.sessionId)],
);

/** Auth profiles: named personas with credentials and a distinct world of data. */
export const profiles = sqliteTable('profiles', {
  name: text('name').primaryKey(),
  /** REQUIRED, and must say how this persona differs from the others. */
  description: text('description').notNull(),
  credentials: text('credentials', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  context: text('context', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
  knobOverrides: text('knob_overrides', { mode: 'json' }).$type<Record<string, Record<string, unknown>>>().notNull().default({}),
  /** How this persona signs in per provider kind — a consent POST is not a credential
   *  exchange, and the roster has to say so (spike 03, 12-scenario-controls.md). */
  signIn: text('sign_in', { enum: ['credentials', 'consent-picker', 'token-only'] })
    .notNull()
    .default('credentials'),
  createdAt: text('created_at').notNull().default(now),
});

/** Tokens minted by `POST /profiles/<name>/session` for API-level testing. */
export const profileSessions = sqliteTable('profile_sessions', {
  token: text('token').primaryKey(),
  profile: text('profile')
    .notNull()
    .references(() => profiles.name),
  sessionId: text('session_id').notNull(),
  createdAt: text('created_at').notNull().default(now),
});

/**
 * Generated-mock state, namespaced by (service, profile) so `state reset` is a cheap
 * delete + re-seed per scope (12-scenario-controls.md).
 */
export const mockState = sqliteTable(
  'mock_state',
  {
    service: text('service').notNull(),
    profile: text('profile').notNull().default('default'),
    collection: text('collection').notNull(),
    key: text('key').notNull(),
    value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
    seeded: integer('seeded', { mode: 'boolean' }).notNull().default(false),
    updatedAt: text('updated_at').notNull().default(now),
  },
  (t) => [
    primaryKey({ columns: [t.service, t.profile, t.collection, t.key] }),
    index('mock_state_scope_idx').on(t.service, t.profile, t.collection),
  ],
);

/** Metadata for content-addressed bodies living under the project's `blobs/`. */
export const blobs = sqliteTable('blobs', {
  hash: text('hash').primaryKey(),
  size: integer('size').notNull(),
  contentType: text('content_type'),
  createdAt: text('created_at').notNull().default(now),
});
