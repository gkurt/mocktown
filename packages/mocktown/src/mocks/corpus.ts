/**
 * The corpus: the recordings turned into the document a generating agent reads, and the
 * one path that takes rows back out again.
 *
 * 01-product.md names the export as a differentiator — "recordings as an agent-legible
 * corpus, not just replay fixtures". The difference in practice is that this export is
 * organised by *route*, carries a handful of representative examples rather than every row,
 * and states the couplings an agent would otherwise have to infer by reading hundreds of
 * exchanges.
 *
 * `deleteRecordings` lives here rather than in a module of its own because everything that
 * makes a delete correct — how a body spills to `blobs/`, what a route key is, which rows a
 * service owns — is already this module's subject. Two modules would be two places to keep
 * that agreement.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { and, eq, inArray, or } from 'drizzle-orm';
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
export function recordingsForService(db: Db, service: string, session?: string, limit = 100, pathTemplate?: string) {
  // Narrowing has to happen in the query. Filtering the first `limit` rows afterwards asks
  // for one route and gets whichever of it happens to fall inside an arbitrary prefix.
  const conditions = [
    eq(schema.recordings.service, service),
    ...(session ? [eq(schema.recordings.sessionId, session)] : []),
    ...(pathTemplate ? [eq(schema.recordings.pathTemplate, pathTemplate)] : []),
  ];
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

/** What a delete matched and what went with it. Reported whether or not anything ran. */
export interface CorpusDeletion {
  dryRun: boolean;
  deleted: number;
  frames: number;
  blobs: number;
  services: string[];
  emptiedServices: string[];
  notes: string[];
  /** Recording and session ids that no longer exist, for callers repairing references. */
  goneIds: string[];
}

export interface DeleteScope {
  id?: string;
  session?: string;
  service?: string;
  method?: string;
  pathTemplate?: string;
}

/**
 * Delete part of the corpus — 03-capture.md's delete path.
 *
 * Three things make this more than a `DELETE FROM`:
 *
 *   - **Frames are children.** `foreign_keys` is on, so a WebSocket row cannot go before
 *     its frames do.
 *   - **Blobs are shared.** A spilled body is content-addressed, so two recordings with
 *     identical bodies point at one file. Unlinking by the deleted row's hash would take
 *     the body out from under whatever else still references it, and `inflateRecording`
 *     would then read a null body for a row that looks intact. So a blob is unlinked only
 *     once nothing points at it.
 *   - **A service can be emptied.** Deleting the last recording for a service leaves any
 *     mock generated from it with nothing behind it, and leaves `mocks verify` with nothing
 *     to replay — it passes by having no work rather than by the mock being right. That is
 *     reported, because silence here would read as success.
 *
 * `dryRun` runs every count and writes nothing, which is the only honest way to answer
 * "how much would this take" before it is gone.
 */
export function deleteRecordings(project: string, db: Db, scope: DeleteScope, dryRun = false): CorpusDeletion {
  const conditions = [
    ...(scope.id ? [eq(schema.recordings.id, scope.id)] : []),
    ...(scope.session ? [eq(schema.recordings.sessionId, scope.session)] : []),
    ...(scope.service ? [eq(schema.recordings.service, scope.service)] : []),
    ...(scope.method ? [eq(schema.recordings.method, scope.method.toUpperCase())] : []),
    ...(scope.pathTemplate ? [eq(schema.recordings.pathTemplate, scope.pathTemplate)] : []),
  ];
  // The caller is responsible for requiring a filter; this guard is here so a future caller
  // that forgets cannot empty the corpus through this function.
  if (conditions.length === 0) throw new Error('deleteRecordings needs at least one filter — an unfiltered delete is not supported');

  const matched = db
    .select()
    .from(schema.recordings)
    .where(and(...conditions))
    .all();

  const services = [...new Set(matched.map((row) => row.service))].sort();
  const notes: string[] = [];
  if (matched.length === 0) {
    return { dryRun, deleted: 0, frames: 0, blobs: 0, services, emptiedServices: [], notes: ['Nothing matched.'], goneIds: [] };
  }

  const ids = matched.map((row) => row.id);
  const frames = db.select().from(schema.socketFrames).where(inArray(schema.socketFrames.recordingId, ids)).all().length;

  // What stops existing, for callers repairing references to it. Derived from the matched
  // set rather than observed after the fact, so a dry run answers the same question — an
  // issue about to lose a link is exactly what someone runs a dry run to find out.
  //
  // An emptied session's own row is kept regardless. It is what a journal entry and an
  // issue's `sessionId` point at, and dropping it would turn those into dangling references
  // to reclaim one row; what it stops being is a session anyone can list recordings from,
  // which is the part a link to it needs to know.
  const emptiedSessions = [...new Set(matched.map((row) => row.sessionId))].filter((sessionId) =>
    db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.sessionId, sessionId))
      .all()
      .every((row) => ids.includes(row.id)),
  );
  const goneIds = [...ids, ...emptiedSessions];

  // Which services would be left with nothing: counted before the delete, so the dry run
  // and the real run report the same thing.
  const survivorsByService = new Map<string, number>();
  for (const service of services) {
    const total = db.select().from(schema.recordings).where(eq(schema.recordings.service, service)).all().length;
    survivorsByService.set(service, total - matched.filter((row) => row.service === service).length);
  }
  const emptiedServices = services.filter((service) => survivorsByService.get(service) === 0);

  const candidateBlobs = new Set(matched.flatMap((row) => [row.requestBlob, row.responseBlob]).filter((hash): hash is string => !!hash));

  if (dryRun) {
    // A dry run cannot ask "would this blob still be referenced" without the rows gone, so
    // it counts what is reachable only from the matched rows. Anything shared with a
    // survivor is excluded here exactly as it would be excluded from a real run.
    const orphans = [...candidateBlobs].filter((hash) => {
      const referencing = db
        .select()
        .from(schema.recordings)
        .where(or(eq(schema.recordings.requestBlob, hash), eq(schema.recordings.responseBlob, hash)))
        .all();
      return referencing.every((row) => ids.includes(row.id));
    });
    return {
      dryRun,
      deleted: matched.length,
      frames,
      blobs: orphans.length,
      services,
      emptiedServices,
      notes: [...notes, 'Dry run: nothing was deleted.'],
      goneIds,
    };
  }

  // One transaction: a corpus with frames whose recording is gone, or rows whose blobs were
  // already unlinked, is a worse state than either the before or the after.
  db.transaction((tx) => {
    tx.delete(schema.socketFrames).where(inArray(schema.socketFrames.recordingId, ids)).run();
    tx.delete(schema.recordings).where(inArray(schema.recordings.id, ids)).run();
  });

  const blobDir = projectPaths(project).blobs;
  let unlinked = 0;
  for (const hash of candidateBlobs) {
    const stillUsed = db
      .select()
      .from(schema.recordings)
      .where(or(eq(schema.recordings.requestBlob, hash), eq(schema.recordings.responseBlob, hash)))
      .get();
    if (stillUsed) continue;
    rmSync(join(blobDir, hash), { force: true });
    db.delete(schema.blobs).where(eq(schema.blobs.hash, hash)).run();
    unlinked += 1;
  }

  if (emptiedServices.length) {
    notes.push(
      `No recordings remain for ${emptiedServices.join(', ')}. Any generated mock for those services is now unbacked, and ` +
        '`mocktown mocks verify` has nothing left to replay against it.',
    );
  }
  notes.push('Generated mocks, the service registry and the seal stamp are unchanged: a delete narrows the evidence, not the setup.');

  return {
    dryRun,
    deleted: matched.length,
    frames,
    blobs: unlinked,
    services,
    emptiedServices,
    notes,
    goneIds,
  };
}
