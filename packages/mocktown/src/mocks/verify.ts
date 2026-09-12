/**
 * The replay-verify harness — 06-emulation.md's "test run that replays recorded sessions
 * against the fresh mock and diffs", and the gate that closes an issue
 * (07-issues-agent-loop.md: "only a passing replay closes the issue").
 *
 * **What is compared, and why not more.** 06-emulation.md is explicit that verbatim
 * replay is not the bar — "emulator, not stub". A mock that returns a different order id
 * than the recording is correct; one that returns a body with no `id` field at all is
 * not. So verification compares the status and the response *shape* — key paths and value
 * types — never the values themselves. Comparing values would fail every stateful mock
 * that is behaving exactly as designed, and the noise would train people to ignore the
 * harness.
 *
 * **The schema's status keys are the contract.** A checked-in schema is keyed by route
 * *and status*, and the whole point of one is that correcting it overrules a recording.
 * That was only half true: the body was checked against the author's schema, but the status
 * was still checked against whatever the corpus happened to catch. A route the schema declares can return 200 or 500 would fail replay whenever
 * the mock answered with the other one — so a service that was erroring during capture
 * held its mock to the outage forever.
 *
 * A route with a schema is therefore judged against it — the draft in `schema.ts` with the
 * corrections in `schema.overrides.ts` applied, which is what `loadSchemas` hands over: a
 * status the schema declares is a
 * valid status, and the body is checked against *that* status's schema rather than the
 * recording's. Answering with a declared status the recording did not have is not a
 * failure, but it is not silent either — it is counted and listed, because "every route
 * now 401s" and "this route no longer 500s" look identical from the pass count alone.
 * A status the schema does *not* declare is a failure, and a sharper one than before,
 * since the message can name what the route is supposed to return.
 *
 * Requests are replayed with fake credentials re-injected by the scrubber, so a mock sees
 * a correctly-shaped secret and no real one exists anywhere (10-security.md).
 */
import type { Recording } from '#src/contract/schemas.ts';
import { REPLAY_HEADER } from '#src/mocks/host.ts';
import { OVERRIDES_FILE, type SchemaMap } from '#src/mocks/overrides.ts';
import { parseJsonBody, schemaDiff, schemaKey } from '#src/mocks/schema.ts';
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

/**
 * An exchange the mock answered with a status its schema declares, but not the one the
 * recording caught. Its body was still checked — against the schema for the status that
 * came back — so this is a pass, reported rather than deducted in silence.
 */
export interface RestatedExchange {
  recordingId: string;
  method: string;
  pathTemplate: string;
  recordedStatus: number;
  actualStatus: number;
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
  /** Passes where the mock answered with a declared status other than the recorded one. */
  restated: RestatedExchange[];
  failures: VerifyFailure[];
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
}

export async function verifyRecordings(recordings: Recording[], target: ReplayTarget, scrubber: Scrubber): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];
  const restated: RestatedExchange[] = [];
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

    const query = new URLSearchParams(recording.query).toString();
    const url = `${target.baseUrl}${recording.path}${query ? `?${query}` : ''}`;

    // Placeholders become well-formed fakes: the mock sees a Stripe-key-shaped string
    // where a Stripe key belongs, without one ever having been stored.
    // Tells the host this is a contract check, so built-in latency and error injection stay
    // out of it — a dial someone left turned is not a reason for a mock to fail replay.
    const headers: Record<string, string> = { host: target.service, [REPLAY_HEADER]: '1' };
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

    const key = schemaKey(recording.method, recording.pathTemplate);
    const declared = target.schemas?.[key];
    const fail = (reason: string, diff: string[]) => {
      failures.push({
        recordingId: recording.id,
        method: recording.method,
        path: recording.path,
        pathTemplate: recording.pathTemplate,
        reason,
        expectedStatus: recording.statusCode,
        actualStatus: response.status,
        diff,
      });
    };

    if (declared) {
      // The route has a checked-in contract, so that contract decides which statuses are
      // legal — not whichever one the corpus happened to catch on the day.
      if (!(response.status in declared)) {
        const legal = Object.keys(declared).sort().join(', ');
        fail(
          `returned ${response.status}, which ${key} does not declare. Its schema declares ${legal}. ` +
            `Add ${response.status} in ${OVERRIDES_FILE} if the route really can answer that way, or fix the mock.`,
          [text.slice(0, 200)],
        );
        continue;
      }
      if (response.status !== recording.statusCode) {
        restated.push({
          recordingId: recording.id,
          method: recording.method,
          pathTemplate: recording.pathTemplate,
          recordedStatus: recording.statusCode,
          actualStatus: response.status,
        });
      }
    } else if (Math.floor(response.status / 100) !== Math.floor(recording.statusCode / 100)) {
      // No schema for this route, so the recording is the only contract there is. Status
      // class rather than the exact code: 201 where the recording had 200 is fine.
      fail(`status class differs (recorded ${recording.statusCode}, mock returned ${response.status})`, [text.slice(0, 200)]);
      continue;
    }

    // Whether a body is JSON is decided by parsing it, not by its `content-type`: an API
    // that serves JSON as `text/plain` used to skip body comparison altogether.
    const actual = parseJsonBody(text);
    const schema = declared?.[response.status];

    if (schema) {
      // The author's schema wins wherever there is one. It was drafted from every
      // recording of this route rather than this one, and — more to the point — the author
      // has had a chance to correct it, which no single recorded body can be. Keyed on the
      // status the mock actually returned, so a route that answered 200 where the corpus
      // caught a 500 is held to the 200 shape rather than to the error envelope.
      schemaChecked++;
      if (actual === undefined) {
        fail(`${key} declares a JSON body for ${response.status}; the mock returned something that does not parse as JSON`, [
          text.slice(0, 200),
        ]);
        continue;
      }
      const diff = schemaDiff(schema, actual);
      if (diff.length > 0) {
        fail(`response does not satisfy the schema for ${key} ${response.status}`, diff.slice(0, 20));
        continue;
      }
    } else {
      // No schema for this status, so the recorded body is the only contract there is —
      // and it is only comparable when the mock answered the same way, which is guaranteed
      // here because a restatement can only happen on a route that has a schema.
      const expected = parseJsonBody(recording.responseBody);
      if (expected !== undefined) {
        if (actual === undefined) {
          fail('recorded response was JSON, the mock returned something that does not parse as JSON', [text.slice(0, 200)]);
          continue;
        }
        const diff = shapeDiff(expected, actual);
        if (diff.length > 0) {
          fail('response shape does not cover what the recording contained', diff.slice(0, 20));
          continue;
        }
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
    restated,
    failures,
  };
}
