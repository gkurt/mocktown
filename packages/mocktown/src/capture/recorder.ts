/**
 * The recorder — 03-capture.md's write path, and the place 10-security.md's central
 * promise is kept: **the scrubber runs before anything touches disk, and the raw
 * exchange is never persisted.**
 *
 * The order is deliberate. Scrub first (so no real credential can reach a blob file or a
 * row), then normalize (so the stored row is already the agent-legible shape), then
 * persist. Every step after the scrub sees placeholders only.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { normalizeUrl, stripVolatile } from '#src/capture/normalize.ts';
import { projectPaths } from '#src/config/paths.ts';
import type { Db } from '#src/db/client.ts';
import { schema } from '#src/db/client.ts';
import type { CapturedExchange, CapturedSocket } from '#src/frontdoor/controller.ts';
import type { Scrubber } from '#src/scrub/scrubber.ts';
import { hash, id } from '#src/util/id.ts';

/** Bodies larger than this become content-addressed blobs rather than table columns. */
const INLINE_BODY_LIMIT = 64 * 1024;

export interface RecordedRow {
  id: string;
  service: string;
  method: string;
  pathTemplate: string;
  statusCode: number;
}

export class Recorder {
  private readonly db: Db;
  private readonly project: string;
  private readonly scrubber: Scrubber;
  private readonly sessionId: string;
  /** Called once, the first time a host is seen without a registry entry. */
  private readonly onDiscovered: (service: string) => void;

  constructor(db: Db, project: string, scrubber: Scrubber, sessionId: string, onDiscovered: (service: string) => void = () => {}) {
    this.db = db;
    this.project = project;
    this.scrubber = scrubber;
    this.sessionId = sessionId;
    this.onDiscovered = onDiscovered;
  }

  /** Persist one exchange. */
  record(exchange: CapturedExchange, source: 'front-door' | 'har' = 'front-door'): RecordedRow | null {
    // Scrub first — this is the only ordering that makes "before disk" true. A base64 body
    // is handed to the scrubber as an empty string and restored afterwards: running the
    // pattern rules over base64 would find nothing and could corrupt the encoding.
    const scrubbed = this.scrubber.scrub({
      id: exchange.id,
      method: exchange.method,
      url: exchange.url,
      statusCode: exchange.statusCode,
      requestHeaders: exchange.requestHeaders,
      responseHeaders: exchange.responseHeaders,
      requestBody: exchange.requestEncoding === 'base64' ? '' : exchange.requestBody,
      responseBody: exchange.responseEncoding === 'base64' ? '' : exchange.responseBody,
    });
    if (exchange.requestEncoding === 'base64') scrubbed.requestBody = exchange.requestBody;
    if (exchange.responseEncoding === 'base64') scrubbed.responseBody = exchange.responseBody;

    const { service, path, pathTemplate, query } = normalizeUrl(scrubbed.url);
    const rowId = id('rec');

    const request = this.spill(scrubbed.requestBody, String(scrubbed.requestHeaders['content-type'] ?? ''));
    const response = this.spill(scrubbed.responseBody, String(scrubbed.responseHeaders['content-type'] ?? ''));

    this.db
      .insert(schema.recordings)
      .values({
        id: rowId,
        sessionId: this.sessionId,
        service,
        method: exchange.method.toUpperCase(),
        path,
        pathTemplate,
        query,
        statusCode: exchange.statusCode,
        requestHeaders: stripVolatile(scrubbed.requestHeaders, 'request'),
        responseHeaders: stripVolatile(scrubbed.responseHeaders, 'response'),
        requestBody: request.inline,
        responseBody: response.inline,
        requestBlob: request.blob,
        responseBlob: response.blob,
        durationMs: exchange.durationMs,
        kind: exchange.kind,
        requestEncoding: exchange.requestEncoding,
        responseEncoding: exchange.responseEncoding,
        // Kinds and counts only — never values (10-security.md).
        scrubSummary: this.summaryWithBinaryNote([exchange.requestEncoding, exchange.responseEncoding]),
        source,
      })
      .run();

    this.touchService(service);
    return { id: rowId, service, method: exchange.method.toUpperCase(), pathTemplate, statusCode: exchange.statusCode };
  }

  /**
   * Persist one WebSocket conversation: a `websocket` recording plus its frames
   * (03-capture.md's deferred list, picked up in phase 4). One row per socket rather than
   * per frame — "what does this channel carry" is the question a generating agent asks.
   */
  recordSocket(socket: CapturedSocket): RecordedRow | null {
    const scrubbed = this.scrubber.scrub({
      id: socket.id,
      method: 'GET',
      url: socket.url.replace(/^ws/, 'http'),
      statusCode: socket.statusCode,
      requestHeaders: socket.requestHeaders,
      responseHeaders: socket.responseHeaders,
      requestBody: '',
      responseBody: '',
    });

    const { service, path, pathTemplate, query } = normalizeUrl(scrubbed.url);
    const rowId = id('rec');

    this.db
      .insert(schema.recordings)
      .values({
        id: rowId,
        sessionId: this.sessionId,
        service,
        // The upgrade is a GET; keeping the verb makes a socket row sort and read with the
        // rest of the corpus instead of needing its own vocabulary.
        method: 'GET',
        path,
        pathTemplate,
        query,
        statusCode: socket.statusCode,
        requestHeaders: stripVolatile(scrubbed.requestHeaders, 'request'),
        responseHeaders: stripVolatile(scrubbed.responseHeaders, 'response'),
        requestBody: null,
        responseBody: null,
        requestBlob: null,
        responseBlob: null,
        durationMs: socket.durationMs,
        kind: 'websocket',
        socketClose: socket.close,
        scrubSummary: this.summaryWithBinaryNote(socket.frames.map((frame) => frame.encoding)),
      })
      .run();

    for (const [ordinal, frame] of socket.frames.entries()) {
      this.db
        .insert(schema.socketFrames)
        .values({
          id: id('frm'),
          recordingId: rowId,
          ordinal,
          direction: frame.direction,
          encoding: frame.encoding,
          // Text frames go through the same scrubber as a body; binary ones cannot.
          body: frame.encoding === 'text' ? this.scrubber.scrubBody(frame.body, guessFrameType(frame.body)) : frame.body,
          atMs: frame.atMs,
        })
        .run();
    }

    this.touchService(service);
    return { id: rowId, service, method: 'GET', pathTemplate, statusCode: socket.statusCode };
  }

  /**
   * The scrub summary, plus an explicit marker when part of this row could not be scrubbed
   * at all. Binary is a real hole in 10-security.md's promise — pattern rules cannot see
   * inside protobuf — and a corpus that stayed silent about it would be claiming a
   * guarantee it did not deliver. `mocktown scrub audit` reads this.
   */
  private summaryWithBinaryNote(encodings: ('text' | 'base64')[]): { kind: string; count: number }[] {
    const binary = encodings.filter((encoding) => encoding === 'base64').length;
    return binary === 0 ? this.scrubber.summary() : [...this.scrubber.summary(), { kind: 'unscrubbable-binary', count: binary }];
  }

  /** Large bodies land in `blobs/` under their own hash; the row keeps the pointer. */
  private spill(body: string, contentType: string): { inline: string | null; blob: string | null } {
    if (!body) return { inline: null, blob: null };
    if (body.length <= INLINE_BODY_LIMIT) return { inline: body, blob: null };

    const digest = hash(body);
    const dir = projectPaths(this.project).blobs;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, digest), body);
    this.db
      .insert(schema.blobs)
      .values({ hash: digest, size: body.length, contentType: contentType || null })
      .onConflictDoNothing()
      .run();
    return { inline: null, blob: digest };
  }

  /**
   * Traffic is evidence that a service exists. A host seen in `record` mode without a
   * registry entry is added as *discovered* — visible in `mocktown status`, never
   * silently promoted to passthrough (06-emulation.md forbids silent passthroughs).
   */
  private touchService(service: string): void {
    const now = new Date().toISOString();
    const existing = this.db.select().from(schema.services).where(eq(schema.services.id, service)).get();
    if (existing) {
      this.db.update(schema.services).set({ lastSeenAt: now }).where(eq(schema.services.id, service)).run();
      return;
    }
    this.db
      .insert(schema.services)
      .values({ id: service, provider: 'record', discovered: true, lastSeenAt: now })
      .onConflictDoNothing()
      .run();
    // Announced exactly here, on the insert, so the count in the queue is the number of
    // times the host was newly discovered rather than the number of times it was polled.
    this.onDiscovered(service);
  }
}

/** A WS frame carries no content type; JSON is overwhelmingly what real channels send. */
function guessFrameType(body: string): string {
  const trimmed = body.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'application/json' : 'text/plain';
}

/** Start a session: the unit recordings, issues and journal entries are tagged by. */
export function startSession(db: Db, mode: 'record' | 'serve' | 'import' | 'verify', opts: { seed?: string; label?: string } = {}): string {
  const sessionId = id('ses');
  // A fixed default seed so runs are reproducible out of the box; override to explore
  // (12-scenario-controls.md).
  const seed = opts.seed ?? 'mocktown-default-seed';
  db.insert(schema.sessions)
    .values({ id: sessionId, mode, seed, label: opts.label ?? null })
    .run();
  db.insert(schema.journal)
    .values({ id: id('jrn'), sessionId, kind: 'session-start', payload: { mode, seed } })
    .run();
  return sessionId;
}

export function endSession(db: Db, sessionId: string): void {
  db.update(schema.sessions).set({ endedAt: new Date().toISOString() }).where(eq(schema.sessions.id, sessionId)).run();
}
