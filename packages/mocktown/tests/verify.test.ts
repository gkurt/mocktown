/**
 * What the replay harness compares, and what it must not do on the way.
 *
 * The shape rules have their own coverage through the agent loop; this file is about the
 * request itself, where a redirect used to cost both correctness and the egress guarantee.
 */
import { afterAll, expect, test } from 'bun:test';
import { rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-verify');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

import type { Recording } from '#src/contract/schemas.ts';
import { verifyRecordings } from '#src/mocks/verify.ts';
import { Scrubber } from '#src/scrub/scrubber.ts';

function recording(overrides: Partial<Recording>): Recording {
  return {
    id: 'rec_1',
    sessionId: 'ses_1',
    service: 'api.example.test',
    method: 'GET',
    path: '/',
    pathTemplate: '/',
    query: {},
    statusCode: 200,
    requestHeaders: {},
    responseHeaders: {},
    requestBody: null,
    responseBody: null,
    requestBlob: null,
    responseBlob: null,
    durationMs: 1,
    kind: 'http',
    requestEncoding: 'text',
    responseEncoding: 'text',
    socketClose: null,
    scrubSummary: [],
    source: 'front-door',
    recordedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

test('a redirect is verified, not followed', async () => {
  // Following it cost two things at once. A mock that correctly answered 302 was reported
  // as returning whatever the chain ended on, so no redirect was ever verifiable — and
  // `Location` on a recorded redirect names a real host, so the harness left the front door
  // and fetched the live site, which is the one thing that must never happen silently.
  let followed = false;
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === '/auth/callback') {
        return new Response(null, { status: 302, headers: { location: `${url.origin}/landed` } });
      }
      followed = true;
      return new Response('<!doctype html><title>the page we should never reach</title>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    },
  });

  try {
    const result = await verifyRecordings(
      [recording({ method: 'POST', path: '/auth/callback', pathTemplate: '/auth/callback', statusCode: 302 })],
      { baseUrl: `http://127.0.0.1:${server.port}`, service: 'api.example.test' },
      new Scrubber(),
    );

    expect(result.failures).toEqual([]);
    expect(result.passed).toBe(1);
    expect(followed).toBe(false);
  } finally {
    server.stop(true);
  }
});

test('a status class that genuinely differs is still a failure', async () => {
  // The guard above must not turn into "3xx always passes".
  const server = Bun.serve({ port: 0, fetch: () => new Response('{}', { status: 500 }) });
  try {
    const result = await verifyRecordings(
      [recording({ path: '/v1/things', pathTemplate: '/v1/things', statusCode: 200 })],
      { baseUrl: `http://127.0.0.1:${server.port}`, service: 'api.example.test' },
      new Scrubber(),
    );
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.reason).toContain('status class differs');
  } finally {
    server.stop(true);
  }
});

test('nextId is monotonic within a pass, not only across writes', async () => {
  // Deriving it from `count` alone meant three calls before the first `set` all returned
  // `org_000001`, so a seed that built its rows before storing them silently kept one.
  const { openProjectDb } = await import('#src/db/client.ts');
  const { SqliteStateStore } = await import('#src/mocks/state.ts');

  const db = openProjectDb('nextid-test');
  const state = new SqliteStateStore(db, 'api.example.test', 'default');

  const ids = [state.nextId('orgs', 'org'), state.nextId('orgs', 'org'), state.nextId('orgs', 'org')];
  expect(new Set(ids).size).toBe(3);
  for (const id of ids) state.set('orgs', id, { id });
  expect(state.count('orgs')).toBe(3);

  // And a store built over existing rows never reissues one of them.
  const later = new SqliteStateStore(db, 'api.example.test', 'default');
  expect(ids).not.toContain(later.nextId('orgs', 'org'));
});

test('a socket recording is skipped, not replayed as a request', async () => {
  // Replaying it sent the recorded upgrade headers, so the mock upgraded for real and the
  // replay client sat on a 101 until its ten-second abort — a minute of dead time for six
  // of them, and a verdict none of them could ever have earned.
  let requests = 0;
  const server = Bun.serve({
    port: 0,
    fetch() {
      requests++;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  try {
    const result = await verifyRecordings(
      [
        recording({ path: '/v1/things', pathTemplate: '/v1/things' }),
        recording({
          id: 'rec_socket',
          kind: 'websocket',
          path: '/socket.io/',
          pathTemplate: '/socket.io/',
          statusCode: 101,
          requestHeaders: { upgrade: 'websocket', connection: 'Upgrade' },
        }),
      ],
      { baseUrl: `http://127.0.0.1:${server.port}`, service: 'api.example.test' },
      new Scrubber(),
    );

    expect(requests).toBe(1);
    expect(result.passed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failures).toEqual([]);
    // `total` still counts everything the corpus held, so the skipped ones stay visible.
    expect(result.total).toBe(2);
  } finally {
    server.stop(true);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));
