/**
 * Corpus export: the recordings turned into the document a generating agent reads.
 *
 * 01-product.md names this as a differentiator — "recordings as an agent-legible corpus,
 * not just replay fixtures". The difference in practice is that this export is organised
 * by *route*, carries a handful of representative examples rather than every row, and
 * states the couplings an agent would otherwise have to infer by reading hundreds of
 * exchanges.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { routeKey } from '#src/capture/normalize.ts';
import { projectPaths } from '#src/config/paths.ts';
import type { Recording } from '#src/contract/schemas.ts';
import type { Db } from '#src/db/client.ts';
import { schema } from '#src/db/client.ts';

export interface RouteExample {
  recordingId: string;
  path: string;
  query: Record<string, string>;
  statusCode: number;
  requestBody: string | null;
  responseBody: string | null;
  requestHeaders: Record<string, string | string[]>;
  responseHeaders: Record<string, string | string[]>;
}

export interface RouteSummary {
  method: string;
  pathTemplate: string;
  observations: number;
  examples: RouteExample[];
  statefulHints: string[];
}

/**
 * A WebSocket channel as a generating agent reads it: the path, and one whole conversation
 * with its frames in order. One example rather than every socket ever seen — what a mock
 * needs is the channel's protocol, and a second transcript of the same handshake teaches
 * nothing.
 */
export interface SocketSummary {
  pathTemplate: string;
  observations: number;
  frames: { direction: 'sent' | 'received'; encoding: 'text' | 'base64'; body: string; atMs: number }[];
  truncatedFrames: boolean;
  close: { code: number; reason: string; by: 'client' | 'upstream' } | null;
}

export interface CorpusExport {
  service: string;
  generatedAt: string;
  routes: RouteSummary[];
  sockets: SocketSummary[];
  /** gRPC methods seen. Recorded, but a generated mock cannot serve them — see host.ts. */
  grpcMethods: { path: string; observations: number }[];
  secretKinds: string[];
}

/**
 * Which routes create something another route then reads. This is the difference between
 * a stub and an emulator: `POST /orders` followed by `GET /orders/{orderId}` has to
 * return the order that was just created (06-emulation.md).
 */
function statefulHints(routes: Map<string, { method: string; pathTemplate: string }>): Map<string, string[]> {
  const hints = new Map<string, string[]>();
  const byTemplate = [...routes.values()];

  for (const route of byTemplate) {
    const notes: string[] = [];

    if (route.method === 'POST' && !route.pathTemplate.endsWith('}')) {
      // A collection POST plus an item GET underneath it is the create/read coupling.
      const reader = byTemplate.find(
        (r) =>
          r.method === 'GET' &&
          r.pathTemplate.startsWith(`${route.pathTemplate}/{`) &&
          r.pathTemplate.split('/').length === route.pathTemplate.split('/').length + 1,
      );
      if (reader) {
        notes.push(
          `Create/read coupling: an entity created by \`POST ${route.pathTemplate}\` must be ` +
            `retrievable at \`GET ${reader.pathTemplate}\`. Store it in \`ctx.state\` keyed by the id you return.`,
        );
      }
      const lister = byTemplate.find((r) => r.method === 'GET' && r.pathTemplate === route.pathTemplate);
      if (lister) {
        notes.push(`Entities created by \`POST ${route.pathTemplate}\` must also appear in \`GET ${route.pathTemplate}\`.`);
      }
    }

    if ((route.method === 'DELETE' || route.method === 'PATCH' || route.method === 'PUT') && route.pathTemplate.endsWith('}')) {
      const reader = byTemplate.find((r) => r.method === 'GET' && r.pathTemplate === route.pathTemplate);
      if (reader) {
        notes.push(
          `\`${route.method} ${route.pathTemplate}\` must be observable through ` +
            `\`GET ${route.pathTemplate}\` afterwards — the update or deletion has to stick.`,
        );
      }
    }

    if (notes.length) hints.set(routeKey(route.method, '', route.pathTemplate), notes);
  }

  return hints;
}

export function exportCorpus(db: Db, service: string, limitPerRoute = 5): CorpusExport {
  const allRows = db.select().from(schema.recordings).where(eq(schema.recordings.service, service)).all();
  const rows = allRows.filter((row) => row.kind === 'http');

  const routes = new Map<string, { method: string; pathTemplate: string; rows: typeof rows }>();
  for (const row of rows) {
    const key = routeKey(row.method, '', row.pathTemplate);
    const entry = routes.get(key) ?? { method: row.method, pathTemplate: row.pathTemplate, rows: [] as typeof rows };
    entry.rows.push(row);
    routes.set(key, entry);
  }

  const hints = statefulHints(new Map([...routes].map(([k, v]) => [k, { method: v.method, pathTemplate: v.pathTemplate }])));
  const secretKinds = new Set<string>();
  for (const row of allRows) for (const entry of row.scrubSummary) secretKinds.add(entry.kind);

  return {
    service,
    generatedAt: new Date().toISOString(),
    sockets: socketChannels(db, allRows),
    grpcMethods: grpcMethods(allRows),
    routes: [...routes]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => ({
        method: entry.method,
        pathTemplate: entry.pathTemplate,
        observations: entry.rows.length,
        // Prefer variety over recency: distinct status codes teach the mock more than
        // five copies of the same happy path.
        examples: pickExamples(entry.rows, limitPerRoute).map((row) => ({
          recordingId: row.id,
          path: row.path,
          query: row.query,
          statusCode: row.statusCode,
          requestBody: row.requestBody,
          responseBody: row.responseBody,
          requestHeaders: row.requestHeaders,
          responseHeaders: row.responseHeaders,
        })),
        statefulHints: hints.get(key) ?? [],
      })),
    secretKinds: [...secretKinds].sort(),
  };
}

/**
 * One transcript per channel — the longest one, because a socket that carried two frames
 * before the client hung up says less about the protocol than one that ran to completion.
 */
function socketChannels(db: Db, rows: (typeof schema.recordings.$inferSelect)[]): SocketSummary[] {
  const byPath = new Map<string, (typeof rows)[number][]>();
  for (const row of rows) {
    if (row.kind !== 'websocket') continue;
    byPath.set(row.pathTemplate, [...(byPath.get(row.pathTemplate) ?? []), row]);
  }

  return [...byPath]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([pathTemplate, sockets]) => {
      const counts = new Map(
        sockets.map((row) => [row.id, db.select().from(schema.socketFrames).where(eq(schema.socketFrames.recordingId, row.id)).all()]),
      );
      const longest = sockets.reduce(
        (best, row) => ((counts.get(row.id)?.length ?? 0) > (counts.get(best.id)?.length ?? 0) ? row : best),
        sockets[0]!,
      );
      const frames = (counts.get(longest.id) ?? []).sort((a, b) => a.ordinal - b.ordinal);
      return {
        pathTemplate,
        observations: sockets.length,
        frames: frames.map((frame) => ({
          direction: frame.direction,
          encoding: frame.encoding,
          body: frame.body,
          atMs: frame.atMs,
        })),
        // The controller caps frames per socket; a mock built from a capped transcript
        // should know the conversation went on rather than assume it ended there.
        truncatedFrames: frames.length >= 500,
        close: longest.socketClose ?? null,
      };
    });
}

function grpcMethods(rows: (typeof schema.recordings.$inferSelect)[]): { path: string; observations: number }[] {
  const counts = new Map<string, number>();
  for (const row of rows) if (row.kind === 'grpc') counts.set(row.path, (counts.get(row.path) ?? 0) + 1);
  return [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([path, observations]) => ({ path, observations }));
}

function pickExamples<T extends { statusCode: number }>(rows: T[], limit: number): T[] {
  const byStatus = new Map<number, T[]>();
  for (const row of rows) byStatus.set(row.statusCode, [...(byStatus.get(row.statusCode) ?? []), row]);

  const picked: T[] = [];
  // One of each status first, then fill up from the largest groups.
  for (const [, group] of byStatus) if (picked.length < limit && group[0]) picked.push(group[0]);
  for (const [, group] of byStatus) {
    for (const row of group.slice(1)) {
      if (picked.length >= limit) return picked;
      picked.push(row);
    }
  }
  return picked;
}

/** The distinct routes a mock has to cover — `mocktown recordings routes`. */
export function routeTable(db: Db, service?: string) {
  const rows = service
    ? db.select().from(schema.recordings).where(eq(schema.recordings.service, service)).all()
    : db.select().from(schema.recordings).all();

  const table = new Map<
    string,
    {
      service: string;
      method: string;
      pathTemplate: string;
      kind: 'http' | 'websocket' | 'grpc';
      count: number;
      statuses: Set<number>;
      lastSeenAt: string | null;
    }
  >();
  for (const row of rows) {
    // A WebSocket upgrade and a GET on the same path are different endpoints, so the kind
    // is part of the key — collapsing them would hide a channel behind a route.
    const key = `${row.kind}:${routeKey(row.method, row.service, row.pathTemplate)}`;
    const entry = table.get(key) ?? {
      service: row.service,
      method: row.method,
      pathTemplate: row.pathTemplate,
      kind: row.kind,
      count: 0,
      statuses: new Set<number>(),
      lastSeenAt: null,
    };
    entry.count++;
    entry.statuses.add(row.statusCode);
    if (!entry.lastSeenAt || row.recordedAt > entry.lastSeenAt) entry.lastSeenAt = row.recordedAt;
    table.set(key, entry);
  }

  return [...table.values()]
    .map((entry) => ({ ...entry, statuses: [...entry.statuses].sort((a, b) => a - b) }))
    .sort((a, b) => a.service.localeCompare(b.service) || a.pathTemplate.localeCompare(b.pathTemplate) || a.method.localeCompare(b.method));
}

/** Recordings for one service, oldest first — the replay order the verify harness uses. */
export function recordingsForService(db: Db, service: string, session?: string, limit = 100) {
  const conditions = [eq(schema.recordings.service, service), ...(session ? [eq(schema.recordings.sessionId, session)] : [])];
  return db
    .select()
    .from(schema.recordings)
    .where(and(...conditions))
    .limit(limit)
    .all();
}

/**
 * A stored row with any spilled body read back from `blobs/`. Large bodies are
 * content-addressed rather than inlined (03-capture.md), so anything that wants the whole
 * exchange — the API, the verify harness, a drift diff — has to come through here.
 */
export function inflateRecording(project: string, row: typeof schema.recordings.$inferSelect): Recording {
  const blobDir = projectPaths(project).blobs;
  const readBlob = (hash: string | null) => {
    if (!hash) return null;
    const path = join(blobDir, hash);
    return existsSync(path) ? readFileSync(path, 'utf8') : null;
  };
  return {
    ...row,
    requestBody: row.requestBody ?? readBlob(row.requestBlob),
    responseBody: row.responseBody ?? readBlob(row.responseBlob),
  };
}
