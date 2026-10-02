/**
 * Closing an issue with no recording of its route falls back to sending the issue's own
 * request to the mock. The mock here is a bare server: 501 is the host's "no route" answer.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { smokeRequest } from '#src/mocks/verify.ts';
import type { Scrubber } from '#src/scrub/scrubber.ts';

let server: ReturnType<typeof Bun.serve>;
let seen: { host: string | null; method: string } | undefined;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request) => {
      seen = { host: request.headers.get('host'), method: request.method };
      return new URL(request.url).pathname === '/served'
        ? Response.json({ ok: true })
        : Response.json({ error: 'no route' }, { status: 501 });
    },
  });
});
afterAll(() => server.stop(true));

const scrubber = { reinject: (value: string) => value } as unknown as Scrubber;
const target = () => ({ baseUrl: `http://127.0.0.1:${server.port}`, service: 'api.example.test' });

test('a read the mock serves is answered, and goes out under the service name', async () => {
  const result = await smokeRequest({ method: 'GET', url: 'https://api.example.test/served?a=1', headers: {} }, target(), scrubber);
  expect(result).toEqual({ outcome: 'answered', status: 200 });
  expect(seen?.method).toBe('GET');
});

test('a route the mock still 501s is unserved', async () => {
  const result = await smokeRequest({ method: 'GET', url: 'https://api.example.test/missing' }, target(), scrubber);
  expect(result).toMatchObject({ outcome: 'unserved', status: 501 });
});

test('a mutating request is never sent', async () => {
  seen = undefined;
  const result = await smokeRequest({ method: 'POST', url: 'https://api.example.test/served' }, target(), scrubber);
  expect(result.outcome).toBe('skipped');
  expect(seen).toBeUndefined();
});

test('an issue with no request is skipped, not failed', async () => {
  expect((await smokeRequest(null, target(), scrubber)).outcome).toBe('skipped');
});

test('an unreachable mock is unserved', async () => {
  const result = await smokeRequest(
    { method: 'GET', url: 'https://api.example.test/served' },
    { baseUrl: 'http://127.0.0.1:1', service: 'x' },
    scrubber,
  );
  expect(result).toMatchObject({ outcome: 'unserved', status: null });
});
