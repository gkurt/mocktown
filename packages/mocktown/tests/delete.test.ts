/**
 * The two delete paths — corpus rows, and a whole project.
 *
 * These are the only operations in the product that destroy something a re-run cannot
 * rebuild, so what is tested here is mostly the *edges*: the shared blob that must survive,
 * the child rows that have to go first, the issue whose evidence just disappeared, and every
 * guard that stands between a mistyped command and a data directory.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';

const root = join(import.meta.dir, '.tmp-delete');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject, loadGlobalConfig, saveGlobalConfig, ensureRegistered } = await import('#src/config/project.ts');
const { projectDataDir, projectPaths } = await import('#src/config/paths.ts');
const { schema } = await import('#src/db/client.ts');
const { Recorder, startSession } = await import('#src/capture/recorder.ts');
const { deleteRecordings } = await import('#src/mocks/corpus.ts');
const { router } = await import('#src/daemon/router.ts');
const { call } = await import('@orpc/server');

const workspace = join(root, 'app');
let runtime: InstanceType<typeof ProjectRuntime>;
let session: string;

/** One HTTP exchange, with control over the bodies so blob spilling can be exercised. */
function exchange(opts: { url: string; method?: string; requestBody?: string; responseBody?: string; status?: number }) {
  return {
    id: `ex-${Math.random().toString(36).slice(2)}`,
    method: opts.method ?? 'GET',
    url: opts.url,
    statusCode: opts.status ?? 200,
    requestHeaders: { 'content-type': 'application/json' },
    responseHeaders: { 'content-type': 'application/json' },
    requestBody: opts.requestBody ?? '{}',
    responseBody: opts.responseBody ?? '{"ok":true}',
    requestEncoding: 'text' as const,
    responseEncoding: 'text' as const,
    kind: 'http' as const,
    durationMs: 4,
    mode: 'record',
  };
}

/** Bigger than the recorder's 64KiB inline limit, so the body lands in `blobs/`. */
const bigBody = (marker: string) => JSON.stringify({ marker, filler: 'x'.repeat(70 * 1024) });

/** Records, then reads the rows back — `RecordedRow` is a summary and carries no blob hashes. */
function record(...exchanges: ReturnType<typeof exchange>[]) {
  const recorder = new Recorder(runtime.db, runtime.name, runtime.currentScrubber, session);
  const ids = exchanges.map((one) => recorder.record(one)!.id);
  return ids.map((rowId) => runtime.db.select().from(schema.recordings).where(eq(schema.recordings.id, rowId)).get()!);
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'mocktown.json'), JSON.stringify({ project: 'delete-test', services: {} }));
  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  runtime.db.delete(schema.socketFrames).run();
  runtime.db.delete(schema.recordings).run();
  runtime.db.delete(schema.issues).run();
  runtime.db.delete(schema.blobs).run();
  session = startSession(runtime.db, 'record', { label: 'fixture' });
});

describe('deleting recordings', () => {
  test('an unfiltered delete is refused rather than treated as "everything"', () => {
    record(exchange({ url: 'https://api.test/orders' }));
    expect(() => deleteRecordings(runtime.name, runtime.db, {})).toThrow(/at least one filter/);
    expect(runtime.db.select().from(schema.recordings).all()).toHaveLength(1);
  });

  test('a route delete takes that route and leaves its neighbours', () => {
    record(
      exchange({ url: 'https://api.test/orders/1' }),
      exchange({ url: 'https://api.test/orders/2' }),
      exchange({ url: 'https://api.test/customers/9' }),
    );

    // The normalized template, which is the column the route table groups by — a delete
    // driven from that table has to filter on the same thing it displayed.
    const result = runtime.deleteCorpus({ service: 'api.test', method: 'GET', pathTemplate: '/orders/{orderId}' });
    expect(result.deleted).toBe(2);
    // The route went, the service did not: `emptiedServices` is the signal a mock has lost
    // its evidence entirely, and it must not fire for a partial delete.
    expect(result.emptiedServices).toEqual([]);
    expect(
      runtime.db
        .select()
        .from(schema.recordings)
        .all()
        .map((row) => row.pathTemplate),
    ).toEqual(['/customers/{customerId}']);
  });

  test('emptying a service is reported, because that is when a mock stops being backed', () => {
    record(exchange({ url: 'https://api.test/orders' }), exchange({ url: 'https://other.test/ping' }));

    const result = runtime.deleteCorpus({ service: 'api.test' });
    expect(result.emptiedServices).toEqual(['api.test']);
    expect(result.notes.join(' ')).toContain('mocktown mocks verify');
  });

  test('a session delete takes the run and keeps the session row', () => {
    record(exchange({ url: 'https://api.test/a' }), exchange({ url: 'https://api.test/b' }));

    const result = runtime.deleteCorpus({ session });
    expect(result.deleted).toBe(2);
    // A journal entry and an issue both point at a session id; deleting the row to save one
    // row would turn those into dangling references.
    expect(
      runtime.db
        .select()
        .from(schema.sessions)
        .all()
        .map((row) => row.id),
    ).toContain(session);
  });

  test("a socket's frames go with it, and not before it", () => {
    const recorder = new Recorder(runtime.db, runtime.name, runtime.currentScrubber, session);
    recorder.recordSocket({
      id: 'sock-1',
      url: 'wss://api.test/stream',
      requestHeaders: {},
      responseHeaders: {},
      statusCode: 101,
      frames: [
        { direction: 'sent', encoding: 'text', body: 'hello', atMs: 0 },
        { direction: 'received', encoding: 'text', body: 'hi', atMs: 5 },
      ],
      truncated: false,
      close: { code: 1000, reason: '', by: 'client' },
      durationMs: 10,
      mode: 'record',
    });
    expect(runtime.db.select().from(schema.socketFrames).all()).toHaveLength(2);

    // `foreign_keys` is on, so a recording cannot be deleted while its frames reference it.
    // This passing at all is the assertion: the delete orders the two statements correctly.
    const result = runtime.deleteCorpus({ service: 'api.test' });
    expect(result.frames).toBe(2);
    expect(runtime.db.select().from(schema.socketFrames).all()).toHaveLength(0);
  });

  test('a spilled body shared with a surviving recording is not unlinked', () => {
    // Identical bodies are one content-addressed file, so unlinking by the deleted row's
    // hash would take the body out from under the row that still points at it — and
    // `inflateRecording` would then read null for a row that looks intact.
    const shared = bigBody('shared');
    const [kept, doomed] = record(
      exchange({ url: 'https://keep.test/big', responseBody: shared }),
      exchange({ url: 'https://drop.test/big', responseBody: shared }),
    );
    const hash = doomed!.responseBlob!;
    expect(kept!.responseBlob).toBe(hash);
    expect(existsSync(join(projectPaths(runtime.name).blobs, hash))).toBe(true);

    const result = runtime.deleteCorpus({ service: 'drop.test' });
    expect(result.blobs).toBe(0);
    expect(existsSync(join(projectPaths(runtime.name).blobs, hash))).toBe(true);
    expect(runtime.db.select().from(schema.blobs).all()).toHaveLength(1);
  });

  test('a spilled body nothing else references is unlinked, with its row', () => {
    const [only] = record(exchange({ url: 'https://drop.test/big', responseBody: bigBody('lonely') }));
    const hash = only!.responseBlob!;

    const result = runtime.deleteCorpus({ service: 'drop.test' });
    expect(result.blobs).toBe(1);
    expect(existsSync(join(projectPaths(runtime.name).blobs, hash))).toBe(false);
    expect(runtime.db.select().from(schema.blobs).all()).toHaveLength(0);
  });

  test('a dry run counts what a real run would take, including the shared blob it would keep', () => {
    const shared = bigBody('shared');
    record(
      exchange({ url: 'https://keep.test/big', responseBody: shared }),
      exchange({ url: 'https://drop.test/big', responseBody: shared }),
      exchange({ url: 'https://drop.test/small' }),
    );

    const dry = runtime.deleteCorpus({ service: 'drop.test' }, true);
    expect(dry.dryRun).toBe(true);
    expect(dry.deleted).toBe(2);
    // The blob survives a real delete, so the dry run must not promise to unlink it.
    expect(dry.blobs).toBe(0);
    expect(dry.emptiedServices).toEqual(['drop.test']);
    expect(runtime.db.select().from(schema.recordings).all()).toHaveLength(3);

    // The two runs agree, which is the only thing that makes the dry run worth having.
    const real = runtime.deleteCorpus({ service: 'drop.test' });
    expect({ deleted: real.deleted, blobs: real.blobs, emptied: real.emptiedServices }).toEqual({
      deleted: dry.deleted,
      blobs: dry.blobs,
      emptied: dry.emptiedServices,
    });
  });

  test('nothing matching is a report, not a failure', () => {
    const result = runtime.deleteCorpus({ service: 'never-recorded.test' });
    expect(result.deleted).toBe(0);
    expect(result.notes).toEqual(['Nothing matched.']);
  });
});

describe('an issue that cited a deleted recording', () => {
  test('loses the dead link, keeps the request, and is named in the result', () => {
    const [row] = record(exchange({ url: 'https://api.test/orders' }));
    const issueId = runtime.issues.file({
      type: 'unmatched-request',
      service: 'api.test',
      method: 'GET',
      pathTemplate: '/orders',
      request: { method: 'GET', path: '/orders' },
      links: [`mocktown recordings get --id ${row!.id}`, 'mocktown services list'],
    });

    const result = runtime.deleteCorpus({ service: 'api.test' });
    expect(result.issues).toEqual([issueId]);

    const issue = runtime.issues.get(issueId)!;
    // 07-issues-agent-loop.md's bar is that the issue is resolvable from itself and what it
    // links. A link that resolves to nothing is worse than no link — the agent follows it
    // and cannot tell missing evidence from a wrong command — but the inline request is what
    // keeps the issue actionable, so it stays.
    expect(issue.links).toEqual(['mocktown services list']);
    expect(issue.request).toEqual({ method: 'GET', path: '/orders' });

    // The file an MCP-less agent reads is rewritten, not left citing the deleted row.
    const file = join(workspace, '.mocktown', 'issues', `${issueId}.json`);
    expect(JSON.parse(readFileSync(file, 'utf8')).links).toEqual(['mocktown services list']);
  });

  test('a dry run names the issues it would touch and repairs none of them', () => {
    const [row] = record(exchange({ url: 'https://api.test/orders' }));
    const link = `mocktown recordings get --id ${row!.id}`;
    const issueId = runtime.issues.file({ type: 'unmatched-request', service: 'api.test', pathTemplate: '/orders', links: [link] });

    expect(runtime.deleteCorpus({ service: 'api.test' }, true).issues).toEqual([issueId]);
    expect(runtime.issues.get(issueId)!.links).toEqual([link]);
  });

  test('an issue citing nothing that went is left alone', () => {
    record(exchange({ url: 'https://api.test/orders' }), exchange({ url: 'https://other.test/ping' }));
    const issueId = runtime.issues.file({
      type: 'unmatched-request',
      service: 'other.test',
      pathTemplate: '/ping',
      links: ['mocktown corpus export --service other.test'],
    });

    expect(runtime.deleteCorpus({ service: 'api.test' }).issues).toEqual([]);
    expect(runtime.issues.get(issueId)!.links).toHaveLength(1);
  });
});

describe('the API refuses a delete with no subject', () => {
  const remove = (input: Record<string, unknown>) =>
    call(router.recordings.delete, { project: 'delete-test', ...input } as never, { context: {} });

  test('`--method` alone is not a subject', async () => {
    record(exchange({ url: 'https://api.test/orders' }));
    // "every GET this project ever recorded" reads like a filter and behaves like a wipe.
    await expect(remove({ method: 'GET' })).rejects.toThrow(/needs a subject/);
    expect(runtime.db.select().from(schema.recordings).all()).toHaveLength(1);
  });

  test('a service is', async () => {
    record(exchange({ url: 'https://api.test/orders' }));
    expect((await remove({ service: 'api.test' })).deleted).toBe(1);
  });
});

describe('project names are one path segment', () => {
  test('a name that would escape the data directory is refused before any path is built', () => {
    // Read and write there was already wrong; with a delete path it is a traversal with an
    // `rm -rf` on the end of it.
    for (const name of ['../escape', 'a/b', '..', '.', '', '/abs']) {
      expect(() => projectDataDir(name), name).toThrow(/single path segment/);
    }
    expect(projectDataDir('ordinary-name')).toContain('ordinary-name');
  });
});

describe('removing a project', () => {
  const remove = (input: Record<string, unknown>) =>
    call(router.project.remove, { project: 'delete-test', ...input } as never, { context: {} });

  /** A registered project with a data directory on disk, and nothing running. */
  function plant(name: string, opts: { workspace?: string } = {}) {
    const config = loadGlobalConfig();
    config.projects[name] = { dataDir: projectDataDir(name), workspace: opts.workspace ?? null };
    saveGlobalConfig(config);
    mkdirSync(projectDataDir(name), { recursive: true });
    writeFileSync(join(projectDataDir(name), 'mocktown.sqlite'), 'not really a database');
    return projectDataDir(name);
  }

  test('unregistering leaves the data, and says where it is', async () => {
    const dir = plant('stale');
    const result = await remove({ name: 'stale' });

    expect(result.unregistered).toBe(true);
    expect(result.dataRemoved).toBe(false);
    expect(existsSync(dir)).toBe(true);
    expect(result.notes.join(' ')).toContain('Data left in place');
    expect(loadGlobalConfig().projects).not.toHaveProperty('stale');
  });

  test('a project that was never registered is reported, not treated as an error', async () => {
    const result = await remove({ name: 'imaginary' });
    expect(result.unregistered).toBe(false);
    expect(result.notes.join(' ')).toContain('held no registry entry');
  });

  test('deleting data without repeating the name is refused, and explains what is at stake', async () => {
    const dir = plant('precious');
    await expect(remove({ name: 'precious', data: true })).rejects.toThrow(/irreversible/);
    await expect(remove({ name: 'precious', data: true, confirm: 'yes' })).rejects.toThrow(/--confirm precious/);
    // Refused means refused: neither the registry nor the directory moved.
    expect(existsSync(dir)).toBe(true);
    expect(loadGlobalConfig().projects).toHaveProperty('precious');
  });

  test('the typed name deletes the directory and the registry entry together', async () => {
    const dir = plant('doomed');
    const result = await remove({ name: 'doomed', data: true, confirm: 'doomed' });

    expect(result.dataRemoved).toBe(true);
    expect(result.dataDir).toBe(dir);
    expect(existsSync(dir)).toBe(false);
    expect(loadGlobalConfig().projects).not.toHaveProperty('doomed');
  });

  test('a sandbox that is still up blocks the delete instead of being orphaned', async () => {
    const dir = plant('boxed');
    writeFileSync(join(dir, 'sandbox.json'), '{"network":"mocktown-boxed"}');

    await expect(remove({ name: 'boxed', data: true, confirm: 'boxed' })).rejects.toThrow(/sandbox down/);
    expect(existsSync(dir)).toBe(true);
  });

  test('the project this call resolved to cannot remove itself', async () => {
    // Every command re-registers the project it resolves to (08-projects-config.md), so this
    // would be undone by the next one — and `--data` would delete a directory the same
    // command recreates.
    await expect(remove({ name: 'delete-test' })).rejects.toThrow(/re-register/);
  });

  test('removing the global default moves it somewhere that still exists', async () => {
    plant('was-default');
    const config = loadGlobalConfig();
    config.defaultProject = 'was-default';
    saveGlobalConfig(config);

    const result = await remove({ name: 'was-default' });
    // A default is a name, not a reference: left pointing at a removed project it would
    // resolve every later command to something that is not there.
    expect(loadGlobalConfig().defaultProject).toBe('main');
    expect(result.notes.join(' ')).toContain('now "main"');
  });

  test('a repo whose mocktown.json still names the project is called out', async () => {
    const repo = join(root, 'other-app');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'mocktown.json'), JSON.stringify({ project: 'comes-back', services: {} }));
    plant('comes-back', { workspace: repo });

    const result = await remove({ name: 'comes-back' });
    // Auto-registration working as designed. Silence here would make the project's
    // reappearance look like the removal having failed.
    expect(result.notes.join(' ')).toContain('will register it again');
  });

  test('a live runtime is stopped and its database released before the files go', async () => {
    // The runtime cache holds an open SQLite handle for any project a command has touched.
    // Unlinking under it succeeds on macOS and Linux while this process keeps writing to
    // files that no longer have names, and is refused outright on Windows.
    const repo = join(root, 'live-app');
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(repo, 'mocktown.json'), JSON.stringify({ project: 'live', services: {} }));
    ensureRegistered(resolveProject({ cwd: repo }));

    const { runtimeFor, liveRuntime } = await import('#src/daemon/runtime.ts');
    runtimeFor('live', repo);
    expect(liveRuntime('live')).toBeDefined();

    await remove({ name: 'live', data: true, confirm: 'live' });
    expect(liveRuntime('live')).toBeUndefined();
    expect(existsSync(projectDataDir('live'))).toBe(false);
  });
});
