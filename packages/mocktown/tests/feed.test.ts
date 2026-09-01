/**
 * The live feed and the drift schedule — the two phase-4 mechanics that are all about
 * *not* surprising anyone.
 *
 * The feed's contract is a bounded window with a monotonic cursor, and the properties worth
 * pinning are the ones a client depends on: a cursor never re-delivers, a full ring reports
 * the gap instead of hiding it, and a long poll wakes on the next event rather than sitting
 * out its timeout.
 *
 * The drift tests are safety tests. A drift run calls real third-party APIs, so what has to
 * be provable is that nothing runs it unless a project asked, and that a run which cannot
 * judge what it claimed to says so instead of reporting success.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-feed');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { FeedBus, MAX_FEED_WAIT_MS, summarize } = await import('#src/daemon/events.ts');
const { DriftScheduler } = await import('#src/drift/scheduler.ts');
const { checkDrift } = await import('#src/drift/watch.ts');
const { runtimeFor } = await import('#src/daemon/runtime.ts');
const { ensureRegistered, resolveProject } = await import('#src/config/project.ts');
const { schema } = await import('#src/db/client.ts');

const workspace = join(root, 'app');

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

const exchange = (path: string) => ({
  kind: 'exchange' as const,
  service: 'api.example.com',
  method: 'GET',
  path,
  statusCode: 200,
  mode: 'mock',
  durationMs: 1,
  summary: `mock GET api.example.com${path} -> 200`,
  ref: null,
});

describe('the feed', () => {
  test('a cursor never hands the same event back twice', () => {
    const feed = new FeedBus();
    feed.publish(exchange('/a'));
    feed.publish(exchange('/b'));

    const first = feed.since(0, 100);
    expect(first.map((event) => event.path)).toEqual(['/a', '/b']);
    const cursor = first.at(-1)!.seq;

    expect(feed.since(cursor, 100)).toEqual([]);
    feed.publish(exchange('/c'));
    expect(feed.since(cursor, 100).map((event) => event.path)).toEqual(['/c']);
  });

  test('a full ring drops the oldest and admits it', () => {
    const feed = new FeedBus();
    for (let i = 0; i < 700; i++) feed.publish(exchange(`/${i}`));

    // 500 kept of 700 published: the window moved, and `oldestSeq` is where a client that
    // asked from the start would find a hole.
    const window = feed.since(0, 500);
    expect(window.length).toBe(500);
    expect(feed.oldestSeq).toBe(201);
    expect(window[0]!.path).toBe('/200');
    expect(feed.cursor).toBe(700);
  });

  test('a long poll wakes on the next event', async () => {
    const feed = new FeedBus();
    feed.publish(exchange('/first'));
    const cursor = feed.cursor;

    const started = Date.now();
    const waiting = feed.wait(cursor, MAX_FEED_WAIT_MS);
    setTimeout(() => feed.publish(exchange('/second')), 40);
    await waiting;

    expect(Date.now() - started).toBeLessThan(MAX_FEED_WAIT_MS / 2);
    expect(feed.since(cursor, 10).map((event) => event.path)).toEqual(['/second']);
  });

  test('a poll behind the cursor returns at once, without waiting', async () => {
    const feed = new FeedBus();
    feed.publish(exchange('/already-here'));
    const started = Date.now();
    await feed.wait(0, MAX_FEED_WAIT_MS);
    expect(Date.now() - started).toBeLessThan(100);
  });

  test('summaries say what happened, including how often', () => {
    expect(summarize.wallHit('POST', 'api.stripe.com', '/v1/charges', 'deny')).toBe('DENIED POST api.stripe.com/v1/charges (deny)');
    expect(summarize.issue('unmatched-request', 'api.stripe.com', 'open', 1)).toBe('issue unmatched-request filed on api.stripe.com');
    expect(summarize.issue('unmatched-request', 'api.stripe.com', 'open', 4)).toContain('seen 4 times');
    expect(summarize.issue('near-miss', 'api.stripe.com', 'resolved', 1)).toBe('issue near-miss on api.stripe.com -> resolved');
  });
});

describe('drift watch', () => {
  const project = (name: string, drift: Record<string, unknown>) => {
    const dir = join(workspace, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mocktown.json'), JSON.stringify({ project: name, drift }));
    const resolved = resolveProject({ cwd: dir });
    ensureRegistered(resolved);
    return runtimeFor(resolved.name, dir);
  };

  test('a project that did not opt in is never touched', async () => {
    project('drift-off', { enabled: false, flows: ['bun test'] });
    const scheduler = new DriftScheduler({ projects: () => ['drift-off'] });
    const result = await scheduler.tick();
    // Not even a skip: a project with the schedule off is not a deferred run, it is a
    // project that never asked for one.
    expect(result).toEqual({ ran: [], skipped: [] });
  });

  test('an active session defers the tick rather than taking the front door', async () => {
    const runtime = project('drift-busy', { enabled: true, flows: ['true'] });
    await runtime.startRecord({ label: 'human-at-work' });
    try {
      const scheduler = new DriftScheduler({ projects: () => ['drift-busy'] });
      const result = await scheduler.tick();
      expect(result.ran).toEqual([]);
      expect(result.skipped[0]).toContain('record mode is active');
    } finally {
      await runtime.stopRecord();
      await runtime.shutdown();
    }
  });

  test('a run with no flows proves nothing, and reports that instead of passing', async () => {
    const runtime = project('drift-noflows', { enabled: true });
    const result = await checkDrift(runtime, { trigger: 'manual' });
    expect(result.ok).toBe(false);
    expect(result.checked).toBe(0);
    expect(result.reasons[0]).toContain('No flows are configured');
    // Persisted even though it did nothing: "the last run found nothing wrong" and "the last
    // run could not run" must not look the same from the outside.
    const persisted = runtime.db.select().from(schema.driftRuns).all();
    expect(persisted).toHaveLength(1);
    expect(persisted[0]!.reasons.length).toBeGreaterThan(0);
  });

  test('a run with flows but no mocked service says which half is missing', async () => {
    const runtime = project('drift-nomocks', { enabled: true, flows: ['true'] });
    const result = await checkDrift(runtime, { trigger: 'manual' });
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain('no mock that could have rotted');
  });
});
