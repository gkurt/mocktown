/**
 * The replay-verify harness — 06-emulation.md's "test run that replays recorded sessions
 * against the fresh mock and diffs", and the gate that closes an issue
 * (07-issues-agent-loop.md: "only a passing replay closes the issue").
 *
 * **What is compared, and why not more.** 06-emulation.md is explicit that verbatim
 * replay is not the bar — "emulator, not stub". A mock that returns a different order id
 * than the recording is correct; one that returns a body with no `id` field at all is
 * not. So verification compares the status class and the response *shape* — key paths and
 * value types — never the values themselves. Comparing values would fail every stateful
 * mock that is behaving exactly as designed, and the noise would train people to ignore
 * the harness.
 *
 * Requests are replayed with fake credentials re-injected by the scrubber, so a mock sees
 * a correctly-shaped secret and no real one exists anywhere (10-security.md).
 */
import type { Recording } from '#src/contract/schemas.ts';
import { parseJsonBody, type SchemaMap, schemaDiff, schemaKey } from '#src/mocks/schema.ts';
import type { Scrubber } from '#src/scrub/scrubber.ts';

export interface VerifyFailure {
  recordingId: string;
  method: string;
  path: string;
  /** The route this exchange belongs to. A concrete path identifies one request; only the
   * template identifies the others that would exercise the same fix. */
  pathTemplate: string;
  reason: string;
  expectedStatus: number | null;
  actualStatus: number | null;
  diff: string[];
}

/** A recorded exchange the project declared is not evidence, and the reason it gave. */
export interface IgnoredExchange {
  recordingId: string;
  method: string;
  pathTemplate: string;
  status: number;
  why: string;
}

export interface NotEvidenceRule {
  service: string;
  path: string;
  method?: string | undefined;
  status?: number | undefined;
  why: string;
}

export interface VerifyResult {
  service: string;
  total: number;
  passed: number;
  failed: number;
  /** Recordings replay cannot exercise — a socket session is not a request and a response. */
  skipped: number;
  /** Exchanges checked against the checked-in schema rather than against one recorded body. */
  schemaChecked: number;
  /**
   * Exchanges left out by a `verify.notEvidence` rule. Reported rather than deducted in
   * silence: an exemption nobody sees is worse than the failure it hides.
   */
  ignored: IgnoredExchange[];
  failures: VerifyFailure[];
}

/** The first rule that claims this recording, or none. */
function notEvidenceFor(recording: Recording, service: string, rules: NotEvidenceRule[] | undefined): NotEvidenceRule | undefined {
  return rules?.find(
    (rule) =>
      rule.service === service &&
      rule.path === recording.pathTemplate &&
      (rule.method === undefined || rule.method.toUpperCase() === recording.method.toUpperCase()) &&
      (rule.status === undefined || rule.status === recording.statusCode),
  );
}

/** `{"a":{"b":[1]}}` -> `a.b[]:number` — the shape, with values deliberately discarded. */
export function shapeOf(value: unknown, path = ''): string[] {
  if (value === null) return [`${path}:null`];
  if (Array.isArray(value)) {
    // One entry per array, not per element: a list of 3 and a list of 300 are the same
    // shape, and a mock is free to return either.
    if (value.length === 0) return [`${path}[]:empty`];
    return shapeOf(value[0], `${path}[]`);
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([key, child]) => shapeOf(child, path ? `${path}.${key}` : key))
      .sort();
  }
  return [`${path}:${typeof value}`];
}

/**
 * What the recording had that the mock did not produce. Extra fields in the mock's
 * response are not failures — a mock may legitimately return more than the corpus
 * happened to capture; missing ones break the client.
 *
 * This is the fallback, used only where no schema is checked in. It compares against a
 * *single* recorded body, so it cannot express a union, cannot tell a record from a
 * data-keyed map, and cannot be overruled when the recording is wrong. `mocktown mocks
 * schema` writes the file that replaces it.
 */
export function shapeDiff(expected: unknown, actual: unknown): string[] {
  const expectedShape = new Set(shapeOf(expected));
  const actualShape = new Set(shapeOf(actual));
  const missing: string[] = [];
  for (const entry of expectedShape) {
    if (actualShape.has(entry)) continue;
    // An empty array where the recording had items is a shape match, not a miss: the
    // difference is data volume, which is a knob or a seed question, not a defect.
    const [pathPart] = entry.split(':');
    if (entry.endsWith(':empty') || actualShape.has(`${pathPart}:empty`)) continue;
    missing.push(`missing or wrong type: ${entry}`);
  }
  return missing;
}

export interface ReplayTarget {
  /** Where the mock is listening, e.g. `http://127.0.0.1:4610`. */
  baseUrl: string;
  /** The hostname the mock answers for; sent as the Host header. */
  service: string;
  /**
   * The service's checked-in response schemas, when it has any. A route and status found
   * here is checked against the author's schema; everything else falls back to comparing
   * shapes with the one body the corpus happened to record.
   */
  schemas?: SchemaMap | null;
  /** Recordings this project has declared replay must not hold the mock to. */
  notEvidence?: NotEvidenceRule[] | undefined;
}

export async function verifyRecordings(recordings: Recording[], target: ReplayTarget, scrubber: Scrubber): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];
  const ignored: IgnoredExchange[] = [];
  let passed = 0;
  let skipped = 0;
  let schemaChecked = 0;

  for (const recording of recordings) {
    // A socket recording is a handshake plus a conversation, and this harness compares one
    // response to one request. Sending it anyway did real damage rather than nothing: the
    // recorded headers still say `Upgrade: websocket`, so the mock upgraded the connection
    // for real, `fetch` sat on a 101 it had no way to read, and the exchange burned the
    // full ten-second abort before being counted as a failure it could never have passed.
    // Six of them in one corpus was a minute of dead time and a verify that timed out.
    if (recording.kind !== 'http') {
      skipped++;
      continue;
    }

    // Checked before the request is built, not after the comparison: if the recording is
    // not evidence then neither is the error body hanging off it, so there is nothing here
    // worth replaying and no partial judgement worth forming.
    const exempt = notEvidenceFor(recording, target.service, target.notEvidence);
    if (exempt) {
      ignored.push({
        recordingId: recording.id,
        method: recording.method,
        pathTemplate: recording.pathTemplate,
        status: recording.statusCode,
        why: exempt.why,
      });
      continue;
    }

    const query = new URLSearchParams(recording.query).toString();
    const url = `${target.baseUrl}${recording.path}${query ? `?${query}` : ''}`;

    // Placeholders become well-formed fakes: the mock sees a Stripe-key-shaped string
    // where a Stripe key belongs, without one ever having been stored.
    const headers: Record<string, string> = { host: target.service };
    for (const [name, value] of Object.entries(recording.requestHeaders)) {
      const lower = name.toLowerCase();
      // Hop-by-hop and framing headers are the replay client's business, not ours.
      if (['host', 'content-length', 'connection', 'transfer-encoding', 'accept-encoding'].includes(lower)) continue;
      headers[name] = scrubber.reinject(Array.isArray(value) ? value[0]! : value);
    }
    const body = recording.requestBody ? scrubber.reinject(recording.requestBody) : undefined;

    let response: Response;
    try {
      response = await fetch(url, {
        method: recording.method,
        headers,
        body: recording.method === 'GET' || recording.method === 'HEAD' ? undefined : body,
        signal: AbortSignal.timeout(10_000),
        // A redirect is a response to verify, not a step to follow. Following it made a 3xx
        // unverifiable — the comparison saw wherever the chain ended, so a mock that
        // correctly answered 302 was reported as returning 200 — and did something worse
        // than that: `Location` on a recorded redirect names a real hostname, so the
        // harness left the front door and fetched the live site, which is the one thing
        // 02-architecture.md says must never happen silently.
        redirect: 'manual',
      });
    } catch (error) {
      failures.push({
        recordingId: recording.id,
        method: recording.method,
        path: recording.path,
        pathTemplate: recording.pathTemplate,
        reason: `request failed: ${error instanceof Error ? error.message : String(error)}`,
        expectedStatus: recording.statusCode,
        actualStatus: null,
        diff: [],
      });
      continue;
    }

    const text = await response.text();

    // Status class, not the exact code: a mock returning 201 where the recording had 200
    // is fine; one returning 500 where the recording had 200 is not.
    if (Math.floor(response.status / 100) !== Math.floor(recording.statusCode / 100)) {
      failures.push({
        recordingId: recording.id,
        method: recording.method,
        path: recording.path,
        pathTemplate: recording.pathTemplate,
        reason: `status class differs (recorded ${recording.statusCode}, mock returned ${response.status})`,
        expectedStatus: recording.statusCode,
        actualStatus: response.status,
        diff: [text.slice(0, 200)],
      });
      continue;
    }

    // Whether the recording is JSON is decided by parsing it, not by its `content-type`:
    // an API that serves JSON as `text/plain` used to skip body comparison altogether.
    const expected = parseJsonBody(recording.responseBody);
    if (expected !== undefined) {
      const actual = parseJsonBody(text);
      if (actual === undefined) {
        failures.push({
          recordingId: recording.id,
          method: recording.method,
          path: recording.path,
          pathTemplate: recording.pathTemplate,
          reason: 'recorded response was JSON, the mock returned something that does not parse as JSON',
          expectedStatus: recording.statusCode,
          actualStatus: response.status,
          diff: [text.slice(0, 200)],
        });
        continue;
      }

      // The author's schema wins wherever there is one. It was drafted from every
      // recording of this route rather than this one, and — more to the point — the author
      // has had a chance to correct it, which no single recorded body can be.
      const schema = target.schemas?.[schemaKey(recording.method, recording.pathTemplate)]?.[recording.statusCode];
      const diff = schema ? schemaDiff(schema, actual) : shapeDiff(expected, actual);
      if (schema) schemaChecked++;

      if (diff.length > 0) {
        failures.push({
          recordingId: recording.id,
          method: recording.method,
          path: recording.path,
          pathTemplate: recording.pathTemplate,
          reason: schema
            ? `response does not satisfy the schema for ${schemaKey(recording.method, recording.pathTemplate)} ${recording.statusCode}`
            : 'response shape does not cover what the recording contained',
          expectedStatus: recording.statusCode,
          actualStatus: response.status,
          diff: diff.slice(0, 20),
        });
        continue;
      }
    }

    passed++;
  }

  return {
    service: target.service,
    total: recordings.length,
    passed,
    failed: failures.length,
    skipped,
    schemaChecked,
    ignored,
    failures,
  };
}
