/**
 * WebSocket and gRPC — 03-capture.md's deferred list, picked up in phase 4 with one of the
 * two actually servable.
 *
 * The WebSocket half is tested end to end on the serving side: a generated mock declares a
 * channel, a real client connects to the real mock host over a real socket, and the
 * conversation has to work — including the part that is easy to get wrong, where a channel
 * the mock does not declare must fail loudly at the handshake instead of connecting and
 * going quiet.
 *
 * The gRPC half is tested for its refusal. `Bun.serve` answers an HTTP/2 prior-knowledge
 * connection with a protocol error, so a generated mock cannot serve gRPC at all; what this
 * proves is that the boundary says so, with the reason and the alternatives, rather than
 * failing as a mysterious 404 that an agent would try to fix by editing the mock.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workspacePaths } from '#src/config/paths.ts';

const root = join(import.meta.dir, '.tmp-sockets');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { Recorder, startSession } = await import('#src/capture/recorder.ts');
const { Scrubber } = await import('#src/scrub/scrubber.ts');
const { DEFAULT_RULES } = await import('#src/scrub/rules.ts');
const { exportCorpus, routeTable } = await import('#src/mocks/corpus.ts');
const { schema } = await import('#src/db/client.ts');
const { eq } = await import('drizzle-orm');

const workspace = join(root, 'app');
const SERVICE = 'chat.localhost';

let runtime: InstanceType<typeof ProjectRuntime>;
let baseUrl: string;

/** A mock with one channel and no routes at all — sockets are not an add-on to HTTP. */
function writeMock(): void {
  const dir = join(workspacePaths(workspace).mocksDir, SERVICE);
  mkdirSync(dir, { recursive: true });
  const types = join(import.meta.dir, '..', 'src', 'mocks', 'types.ts');

  writeFileSync(
    join(dir, 'index.ts'),
    `
import { defineMock } from ${JSON.stringify(types)};

export default defineMock({
  service: ${JSON.stringify(SERVICE)},
  routes: [],
  sockets: [
    {
      path: "/v1/rooms/{roomId}",
      describe: "A room's message stream",
      onOpen: (req, ctx) => {
        ctx.connection.room = req.params.roomId;
        ctx.send(JSON.stringify({ type: "welcome", room: req.params.roomId }));
      },
      onMessage: (message, _req, ctx) => {
        const text = typeof message.data === "string" ? message.data : "(binary)";
        if (text === "history") {
          ctx.send(JSON.stringify({ type: "history", messages: ctx.state.list("messages").map((e) => e.value) }));
          return;
        }
        if (text === "bye") {
          ctx.close(4000, "asked to leave");
          return;
        }
        const id = ctx.state.nextId("messages", "msg");
        ctx.state.set("messages", id, { id, room: ctx.connection.room, text });
        ctx.send(JSON.stringify({ type: "echo", id, text }));
      },
    },
  ],
  ekb: [{ rung: 1, envVar: "CHAT_WS_URL", note: "The client reads its socket URL from this variable." }],
});
`,
  );
}

beforeAll(async () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(
    join(workspace, 'mocktown.json'),
    JSON.stringify({ project: 'sockets-test', services: { [SERVICE]: { provider: `generated:${SERVICE}` } } }, null, 2),
  );
  writeMock();

  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
  await runtime.startServe({ sealed: true });
  baseUrl = runtime.baseUrlFor(SERVICE)!;
});

afterAll(async () => {
  await runtime?.shutdown();
  rmSync(root, { recursive: true, force: true });
});

/** One conversation, collected. The mock host is a real server, so this is a real client. */
function talk(
  path: string,
  says: string[],
): Promise<{ received: string[]; close: { code: number; reason: string } | null; status?: number }> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}${path}`, { headers: { host: SERVICE } });
    const received: string[] = [];
    const queue = [...says];

    const timer = setTimeout(() => reject(new Error(`no close after ${received.length} frame(s): ${received.join(' | ')}`)), 5000);

    socket.addEventListener('message', (event) => {
      received.push(String(event.data));
      const next = queue.shift();
      if (next !== undefined) socket.send(next);
      else socket.close(1000, 'done');
    });
    socket.addEventListener('open', () => {
      if (!says.length) socket.close(1000, 'done');
    });
    socket.addEventListener('close', (event) => {
      clearTimeout(timer);
      resolve({ received, close: { code: event.code, reason: event.reason } });
    });
    socket.addEventListener('error', () => {
      clearTimeout(timer);
      resolve({ received, close: null });
    });
  });
}

describe('serving a WebSocket channel', () => {
  test('a declared channel talks, keeps per-connection state, and shares the store', async () => {
    const first = await talk('/v1/rooms/general', ['hello', 'history']);
    const messages = first.received.map((frame) => JSON.parse(frame));

    expect(messages[0]).toEqual({ type: 'welcome', room: 'general' });
    expect(messages[1].type).toBe('echo');
    expect(messages[1].text).toBe('hello');
    // `ctx.state` is the mock's store, so a message sent on one connection is there for the
    // next — that is the difference between a socket stub and an emulated channel.
    expect(messages[2]).toEqual({ type: 'history', messages: [{ id: messages[1].id, room: 'general', text: 'hello' }] });

    const second = await talk('/v1/rooms/general', ['history']);
    expect(JSON.parse(second.received[1]!).messages).toHaveLength(1);
  });

  test('a handler can close the socket with its own code', async () => {
    const result = await talk('/v1/rooms/general', ['bye']);
    expect(result.close?.code).toBe(4000);
    expect(result.close?.reason).toBe('asked to leave');
  });

  test('an undeclared channel is refused at the handshake, and filed', async () => {
    const response = await fetch(`${baseUrl}/v1/streams/9`, {
      headers: { host: SERVICE, upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'x' },
    });
    expect(response.status).toBe(501);
    const body = (await response.json()) as any;
    expect(body.error).toBe('mocktown_no_socket');
    expect(body.declared).toEqual(['/v1/rooms/{roomId}']);

    const issue = runtime.issues.list({ service: SERVICE }).at(0);
    expect(issue?.type).toBe('unmatched-request');
    expect(issue?.suggestedResolution).toContain('sockets');
  });
});

describe('gRPC', () => {
  test('is refused with the reason, not with a 404', async () => {
    const response = await fetch(`${baseUrl}/helloworld.Greeter/SayHello`, {
      method: 'POST',
      headers: { host: SERVICE, 'content-type': 'application/grpc' },
      body: new Uint8Array([0, 0, 0, 0, 0]),
    });

    expect(response.status).toBe(501);
    const body = (await response.json()) as any;
    expect(body.error).toBe('mocktown_grpc_unsupported');
    // The reason has to name the blocker and the way out, because the obvious next move —
    // editing the generated mock — cannot work.
    expect(body.message + body.hint).toContain('HTTP/2');
    expect(body.hint).toContain('record');
  });
});

describe('recording a socket', () => {
  test('frames keep their order and their direction, and the corpus exports the transcript', () => {
    const session = startSession(runtime.db, 'record', { seed: 'sockets' });
    const recorder = new Recorder(runtime.db, runtime.name, new Scrubber(DEFAULT_RULES), session);

    const row = recorder.recordSocket({
      id: 'sock_1',
      url: `ws://${SERVICE}/v1/rooms/rm_8f14e45f`,
      requestHeaders: { host: SERVICE, authorization: 'Bearer sk_live_deadbeefcafef00d1234567890abcd' },
      responseHeaders: { upgrade: 'websocket' },
      statusCode: 101,
      frames: [
        { direction: 'sent', body: 'hello', encoding: 'text', atMs: 0 },
        { direction: 'received', body: '{"type":"echo"}', encoding: 'text', atMs: 12 },
        { direction: 'received', body: Buffer.from([0xff, 0xfe, 0x00]).toString('base64'), encoding: 'base64', atMs: 20 },
      ],
      truncated: false,
      close: { code: 1000, reason: 'done', by: 'client' },
      durationMs: 25,
      mode: 'record',
    });

    const stored = runtime.db.select().from(schema.recordings).where(eq(schema.recordings.id, row!.id)).get()!;
    expect(stored.kind).toBe('websocket');
    // Scrubbed before disk, sockets included: the upgrade carries the same credentials the
    // HTTP requests do.
    expect(JSON.stringify(stored.requestHeaders)).not.toContain('sk_live_deadbeef');
    // A frame the pattern rules cannot see inside is marked, rather than quietly trusted.
    expect(stored.scrubSummary.some((entry) => entry.kind === 'unscrubbable-binary')).toBe(true);

    const exported = exportCorpus(runtime.db, SERVICE);
    expect(exported.sockets).toHaveLength(1);
    expect(exported.sockets[0]!.pathTemplate).toBe('/v1/rooms/{roomId}');
    expect(exported.sockets[0]!.frames.map((frame) => frame.direction)).toEqual(['sent', 'received', 'received']);
    expect(exported.sockets[0]!.close).toEqual({ code: 1000, reason: 'done', by: 'client' });
    // The route table keys on kind, so a channel cannot hide behind a GET on the same path.
    const socketRows = routeTable(runtime.db, SERVICE).filter((entry) => entry.kind === 'websocket');
    expect(socketRows).toHaveLength(1);
  });
});

/**
 * The capture half, through the real front door: a real WebSocket client, a real proxy and a
 * real upstream. The property that matters is the one that is easy to get backwards —
 * Mockttp reports frame direction from the *proxy's* point of view, and the corpus is
 * written from the *client's*, so a mock built from a transcript replies where the upstream
 * replied.
 */
describe('capturing a socket through the front door', () => {
  const CAPTURED = 'stream.localhost';
  let capture: InstanceType<typeof ProjectRuntime>;
  let upstream: Bun.Server<never>;
  let proxyPort: string;

  beforeAll(async () => {
    const dir = join(root, 'captured');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'mocktown.json'), JSON.stringify({ project: 'sockets-capture' }));

    upstream = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request, server) => (server.upgrade(request) ? undefined : new Response('not a socket', { status: 400 })),
      websocket: {
        open: (ws) => {
          ws.send(JSON.stringify({ type: 'welcome' }));
        },
        message: (ws, message) => {
          ws.send(`echo:${message}`);
        },
      },
    });

    capture = new ProjectRuntime(resolveProject({ cwd: dir }));
    capture.ensureDirs();
    const started = await capture.startRecord({ label: 'sockets' });
    proxyPort = new URL(started.proxyUrl).port;
  });

  afterAll(async () => {
    await capture?.shutdown();
    upstream?.stop(true);
  });

  test("frames land in the corpus with the client's own directions", async () => {
    const received: string[] = [];
    await new Promise<void>((resolve) => {
      // Straight at the front door with the upstream in the Host header: that is what an
      // app's proxy-configured socket client sends.
      const socket = new WebSocket(`ws://127.0.0.1:${proxyPort}/v1/streams/st_8f14e45f`, {
        headers: { host: `${CAPTURED}:${upstream.port}` },
      });
      const timer = setTimeout(resolve, 6000);
      socket.addEventListener('message', (event) => {
        received.push(String(event.data));
        if (received.length === 1) socket.send('ping');
        else socket.close(1000, 'done');
      });
      socket.addEventListener('close', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    expect(received[0]).toBe('{"type":"welcome"}');
    expect(received[1]).toBe('echo:ping');

    // The row lands at close, so give the sidecar's close event a moment to arrive.
    for (let i = 0; i < 40 && capture.db.select().from(schema.recordings).all().length === 0; i++) {
      await new Promise((r) => setTimeout(r, 50));
    }

    const rows = capture.db.select().from(schema.recordings).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'websocket',
      service: CAPTURED,
      method: 'GET',
      pathTemplate: '/v1/streams/{streamId}',
      statusCode: 101,
    });

    const frames = capture.db
      .select()
      .from(schema.socketFrames)
      .all()
      .sort((a, b) => a.ordinal - b.ordinal);
    // `received` is what the upstream sent to the client; `sent` is the client's own frame.
    expect(frames.map((frame) => `${frame.direction} ${frame.body}`)).toEqual([
      'received {"type":"welcome"}',
      'sent ping',
      'received echo:ping',
    ]);
    expect(rows[0]!.socketClose?.code).toBe(1000);
  }, 20_000);
});
