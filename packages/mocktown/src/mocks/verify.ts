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
import type { Scrubber } from '#src/scrub/scrubber.ts';

export interface VerifyFailure {
  recordingId: string;
  method: string;
  path: string;
  reason: string;
  expectedStatus: number | null;
  actualStatus: number | null;
  diff: string[];
}

export interface VerifyResult {
  service: string;
  total: number;
  passed: number;
  failed: number;
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
}

export async function verifyRecordings(recordings: Recording[], target: ReplayTarget, scrubber: Scrubber): Promise<VerifyResult> {
  const failures: VerifyFailure[] = [];
  let passed = 0;

  for (const recording of recordings) {
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
      });
    } catch (error) {
      failures.push({
        recordingId: recording.id,
        method: recording.method,
        path: recording.path,
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
        reason: `status class differs (recorded ${recording.statusCode}, mock returned ${response.status})`,
        expectedStatus: recording.statusCode,
        actualStatus: response.status,
        diff: [text.slice(0, 200)],
      });
      continue;
    }

    const recordedBody = recording.responseBody;
    const isJson = String(recording.responseHeaders['content-type'] ?? '').includes('json');
    if (recordedBody && isJson) {
      let expected: unknown, actual: unknown;
      try {
        expected = JSON.parse(recordedBody);
      } catch {
        expected = null;
      }
      try {
        actual = JSON.parse(text);
      } catch {
        actual = null;
      }

      if (expected !== null && actual === null) {
        failures.push({
          recordingId: recording.id,
          method: recording.method,
          path: recording.path,
          reason: 'recorded response was JSON, the mock returned something that does not parse as JSON',
          expectedStatus: recording.statusCode,
          actualStatus: response.status,
          diff: [text.slice(0, 200)],
        });
        continue;
      }

      const diff = expected === null ? [] : shapeDiff(expected, actual);
      if (diff.length > 0) {
        failures.push({
          recordingId: recording.id,
          method: recording.method,
          path: recording.path,
          reason: 'response shape does not cover what the recording contained',
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
    failures,
  };
}
