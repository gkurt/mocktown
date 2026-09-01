/**
 * The generated-mock host: one `Bun.serve` listener serving every generated service,
 * routed by the Host header the front door preserves.
 *
 * The front door forwards a mocked hostname here with
 * `replaceHost { updateHostHeader: false }`, so a mock for `api.stripe.com` sees
 * `Host: api.stripe.com` and not the loopback address it happens to listen on. That is
 * what lets one listener serve N services without inventing a routing header.
 *
 * Anything this host cannot serve becomes an issue rather than a 404 into the void —
 * that is the loop 07-issues-agent-loop.md describes, and the reason the host holds a
 * reference to the issue engine at all.
 */
import { eq } from 'drizzle-orm';
import type { Db } from '#src/db/client.ts';
import { schema } from '#src/db/client.ts';
import { diagnose, matchRoute, matchSocket } from '#src/mocks/match.ts';
import { Prng, streamKey } from '#src/mocks/prng.ts';
import { SqliteStateStore } from '#src/mocks/state.ts';
import type { MockCtx, MockModule, MockRequest, MockResponse, MockSocket, MockSocketCtx, MockSocketRequest } from '#src/mocks/types.ts';
import { DEFAULT_RULES } from '#src/scrub/rules.ts';
import { id } from '#src/util/id.ts';

export interface MockHostDeps {
  db: Db;
  sessionId: string;
  sessionSeed: string;
  /** Effective knob values per service, profile overrides already applied by the caller. */
  knobsFor: (service: string, profile: string) => Record<string, unknown>;
  /** Called for every request the host could not serve. */
  onUnmatched: (event: {
    service: string;
    method: string;
    path: string;
    request: unknown;
    diagnosis: unknown;
    kind: 'unmatched-request' | 'near-miss' | 'unknown-service';
    suggestedResolution: string;
  }) => void;
}

/**
 * What a live socket carries between the upgrade and its handlers. `live` is the socket
 * itself, which does not exist yet when `server.upgrade()` is called — Bun hands it to the
 * `open` callback — so `ctx.send` reads it from here rather than from a closure.
 */
interface SocketBinding {
  service: string;
  socket: MockSocket;
  request: MockSocketRequest;
  ctx: MockSocketCtx;
  connection: Record<string, unknown>;
  live: Bun.ServerWebSocket<SocketBinding> | null;
}

export class MockHost {
  private server?: Bun.Server<SocketBinding>;
  private modules = new Map<string, MockModule>();
  port = 0;

  private readonly deps: MockHostDeps;

  constructor(deps: MockHostDeps) {
    this.deps = deps;
  }

  setModules(modules: MockModule[]): void {
    this.modules = new Map(modules.map((m) => [m.service, m]));
  }

  get services(): string[] {
    return [...this.modules.keys()];
  }

  async start(port = 0): Promise<number> {
    if (this.server) return this.port;
    this.server = Bun.serve<SocketBinding>({
      port,
      hostname: '127.0.0.1', // 10-security.md: mocks never leave loopback
      fetch: (request, server) => this.handle(request, server),
      // WebSocket handlers are a property of the server, not of a response, so the whole
      // socket API is threaded through `ws.data` set at upgrade time.
      websocket: {
        open: (ws) => void this.runSocketHandler(ws, (socket) => socket.onOpen?.(ws.data.request, ws.data.ctx)),
        message: (ws, message) =>
          void this.runSocketHandler(ws, (socket) =>
            socket.onMessage?.(
              typeof message === 'string' ? { data: message, isBinary: false } : { data: message, isBinary: true },
              ws.data.request,
              ws.data.ctx,
            ),
          ),
        close: (ws, code, reason) =>
          void this.runSocketHandler(ws, (socket) => socket.onClose?.({ code, reason }, ws.data.request, ws.data.ctx)),
      },
    });
    this.port = this.server.port ?? port;
    return this.port;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = undefined;
  }

  private async handle(request: Request, server: Bun.Server<SocketBinding>): Promise<Response | undefined> {
    const url = new URL(request.url);
    // The Host header is the service identity; the URL's host is our loopback address.
    const service = (request.headers.get('host') ?? url.host).split(':')[0]!;
    const module = this.modules.get(service);
    const rawBody = request.method === 'GET' || request.method === 'HEAD' ? '' : await request.text();

    if (!module) {
      // The front door routed here, so the registry says this service is mocked, but no
      // module answers for it. Loud, and filed, rather than a silent 404.
      this.deps.onUnmatched({
        service,
        method: request.method,
        path: url.pathname,
        request: describeRequest(request, url, rawBody),
        diagnosis: { reason: `no generated mock module is loaded for "${service}"` },
        kind: 'unknown-service',
        suggestedResolution: `Run \`mocktown mocks scaffold --service ${service}\` and have an agent fill in the module from the corpus.`,
      });
      return json(501, {
        error: 'mocktown_no_mock',
        message: `No generated mock is loaded for ${service}.`,
        hint: 'Run `mocktown issues list` — this request was filed with everything needed to build the mock.',
      });
    }

    if (request.headers.get('upgrade')?.toLowerCase() === 'websocket') return this.upgrade(request, server, service, module, url);
    if (isGrpcRequest(request)) return this.denyGrpc(request, service, url, rawBody);

    const profile = this.profileFor(request);
    const match = matchRoute(module.routes, request.method, url.pathname);

    if (!match) {
      const near = diagnose(module.routes, request.method, url.pathname);
      this.deps.onUnmatched({
        service,
        method: request.method,
        path: url.pathname,
        request: describeRequest(request, url, rawBody),
        diagnosis: { closest: near.closest, reasons: near.reasons, profile },
        kind: near.kind,
        suggestedResolution: near.suggestedResolution,
      });
      return json(501, {
        error: 'mocktown_unmatched',
        message: `${request.method} ${url.pathname} matched no route in the ${service} mock.`,
        closest: near.closest,
        reasons: near.reasons,
      });
    }

    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });

    const mockRequest: MockRequest = {
      method: request.method,
      path: url.pathname,
      params: match.params,
      query,
      headers,
      body: parseBody(rawBody, headers['content-type'] ?? ''),
      rawBody,
      auth: headers.authorization ?? null,
    };

    const ctx = this.contextFor(service, profile, match.route.path, mockRequest);

    try {
      const response = await match.route.handler(mockRequest, ctx);
      return toResponse(response);
    } catch (error) {
      // A throwing handler is a defect in the generated mock, and the agent that wrote it
      // is the one who should see it — so it is filed, not swallowed.
      const message = error instanceof Error ? error.message : String(error);
      this.deps.onUnmatched({
        service,
        method: request.method,
        path: url.pathname,
        request: describeRequest(request, url, rawBody),
        diagnosis: { closest: { method: match.route.method, path: match.route.path }, reasons: [`handler threw: ${message}`], profile },
        kind: 'near-miss',
        suggestedResolution: `Fix the \`${match.route.method.toUpperCase()} ${match.route.path}\` handler in the ${service} mock; it threw on a request the route claimed.`,
      });
      return json(500, { error: 'mocktown_mock_threw', message });
    }
  }

  /**
   * A WebSocket upgrade. A channel the mock does not declare is rejected and filed, the
   * same as an unmatched request: a socket that connects and then says nothing is the
   * hardest kind of mock bug to diagnose, so the failure is made loud at the handshake.
   */
  private upgrade(
    request: Request,
    server: Bun.Server<SocketBinding>,
    service: string,
    module: MockModule,
    url: URL,
  ): Response | undefined {
    const match = matchSocket(module.sockets ?? [], url.pathname);
    if (!match) {
      this.deps.onUnmatched({
        service,
        method: 'GET',
        path: url.pathname,
        request: describeRequest(request, url, ''),
        diagnosis: {
          reason: `the ${service} mock declares no WebSocket channel matching ${url.pathname}`,
          declared: (module.sockets ?? []).map((socket) => socket.path),
        },
        kind: (module.sockets ?? []).length === 0 ? 'unmatched-request' : 'near-miss',
        suggestedResolution:
          `Add a \`sockets\` entry for \`${url.pathname}\` to the ${service} mock. The recorded frames for this channel are ` +
          `in the corpus: \`mocktown recordings list --service ${service}\` shows the socket rows, and each one carries ` +
          'its frames in order with the direction the client saw.',
      });
      return json(501, {
        error: 'mocktown_no_socket',
        message: `The ${service} mock declares no WebSocket channel for ${url.pathname}.`,
        declared: (module.sockets ?? []).map((socket) => socket.path),
      });
    }

    const profile = this.profileFor(request);
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key] = value;
    });
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const socketRequest: MockSocketRequest = {
      path: url.pathname,
      params: match.params,
      query,
      headers,
      protocols: (headers['sec-websocket-protocol'] ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
      auth: headers.authorization ?? null,
    };

    const connection: Record<string, unknown> = {};
    // The socket's PRNG stream is keyed by the connection's own identity rather than by a
    // request body, so two clients on the same channel get different streams and each one
    // is reproducible from the session seed (12-scenario-controls.md).
    const base = this.contextFor(service, profile, match.socket.path, {
      method: 'GET',
      path: url.pathname,
      params: match.params,
      query,
      headers,
      body: null,
      rawBody: '',
      auth: socketRequest.auth,
    });

    const binding: SocketBinding = {
      service,
      socket: match.socket,
      request: socketRequest,
      connection,
      live: null,
      ctx: {
        ...base,
        connection,
        send: (data) => binding.live?.send(data),
        close: (code, reason) => binding.live?.close(code, reason),
      },
    };

    const upgraded = server.upgrade(request, {
      data: binding,
      ...(match.socket.protocol ? { headers: { 'sec-websocket-protocol': match.socket.protocol } } : {}),
    });
    if (!upgraded) return json(400, { error: 'mocktown_upgrade_failed', message: 'the WebSocket upgrade was refused by the server' });
    // Bun takes over the connection when `upgrade` succeeds; returning a response here
    // would be an error rather than an alternative.
    return undefined;
  }

  /**
   * Run one socket handler, filing anything it throws. A throwing socket handler is a
   * defect in the generated mock, and it must not take the whole daemon down with it —
   * `Bun.serve`'s websocket callbacks have no error boundary of their own.
   */
  private async runSocketHandler(ws: Bun.ServerWebSocket<SocketBinding>, run: (socket: MockSocket) => void | Promise<void>): Promise<void> {
    ws.data.live = ws;
    try {
      await run(ws.data.socket);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.onUnmatched({
        service: ws.data.service,
        method: 'GET',
        path: ws.data.request.path,
        request: { path: ws.data.request.path, headers: ws.data.request.headers },
        diagnosis: { closest: { method: 'WS', path: ws.data.socket.path }, reasons: [`socket handler threw: ${message}`] },
        kind: 'near-miss',
        suggestedResolution: `Fix the \`sockets\` handler for \`${ws.data.socket.path}\` in the ${ws.data.service} mock; it threw on a live connection.`,
      });
      ws.close(1011, "mocktown: the mock's socket handler threw");
    }
  }

  /**
   * gRPC is recorded but not served, and the reason is a hard one rather than a missing
   * feature: gRPC requires HTTP/2 with trailers, and `Bun.serve` does not accept HTTP/2
   * connections at all — a prior-knowledge h2 client gets a protocol error, verified in
   * phase 4. Denying with the reason attached beats a 501 an agent would try to fix by
   * editing the mock, which cannot work.
   */
  private denyGrpc(request: Request, service: string, url: URL, rawBody: string): Response {
    this.deps.onUnmatched({
      service,
      method: request.method,
      path: url.pathname,
      request: describeRequest(request, url, rawBody),
      diagnosis: {
        reason:
          'This is a gRPC call. Mocktown records gRPC as opaque HTTP/2 so the corpus sees it, but a generated mock ' +
          'cannot serve it: gRPC needs HTTP/2 with trailers and the generated-mock host runs on Bun.serve, which does ' +
          'not accept HTTP/2 connections. This is a known gap, not a mistake in this mock.',
        method: url.pathname,
      },
      kind: 'unmatched-request',
      suggestedResolution:
        `gRPC mocking is not available. Either point ${service} at \`record\` so its calls reach the real service and are ` +
        'captured, or run a real gRPC test double for it and register that host as `passthrough`. Editing the generated ' +
        'mock cannot resolve this issue.',
    });
    // The reason travels in the response, not only in the issue: whoever reads this body —
    // a developer in a log, an agent inspecting a failure — must not have to open the queue
    // to learn that the obvious fix, editing the mock, cannot work.
    return json(501, {
      error: 'mocktown_grpc_unsupported',
      message: `gRPC calls to ${service} cannot be served by a generated mock: gRPC needs HTTP/2 with trailers, and the mock host runs on Bun.serve, which does not accept HTTP/2 connections.`,
      hint:
        `Point ${service} at \`record\` so its calls reach the real service and land in the corpus, or run a real gRPC ` +
        'test double and register that host as `passthrough`. Editing the generated mock cannot resolve this.',
      method: url.pathname,
    });
  }

  /**
   * The front door maps incoming auth to a profile; unauthenticated requests get the
   * `anonymous` profile (12-scenario-controls.md).
   */
  private profileFor(request: Request): string {
    const auth = request.headers.get('authorization');
    if (!auth) return 'anonymous';
    const token = auth.replace(/^(Bearer|token|Basic)\s+/i, '').trim();
    const row = this.deps.db.select().from(schema.profileSessions).where(eq(schema.profileSessions.token, token)).get();
    return row?.profile ?? 'anonymous';
  }

  private contextFor(service: string, profile: string, endpoint: string, request: MockRequest): MockCtx {
    const db = this.deps.db;
    // The stream key excludes anything volatile, so the same GET for the same profile in
    // the same session always lands on the same value regardless of request ordering.
    const requestIdentity = `${request.method} ${request.path} ${JSON.stringify(request.query)}`;
    const prng = new Prng(
      streamKey({
        sessionSeed: this.deps.sessionSeed,
        service,
        endpoint,
        profile,
        requestIdentity,
      }),
    );

    return {
      service,
      profile,
      prng,
      knobs: this.deps.knobsFor(service, profile),
      state: new SqliteStateStore(db, service, profile),
      fakeSecret: (kind, ordinal = 1) => {
        const rule = DEFAULT_RULES.find((r) => r.kind === kind);
        return rule?.fake ? rule.fake(ordinal) : `mocktown-${kind}-${ordinal}`;
      },
      signIn: (credentials) => {
        const roster = db.select().from(schema.profiles).all();
        const matched = roster.find(
          (p) =>
            Object.entries(p.credentials).length > 0 && Object.entries(p.credentials).every(([key, value]) => credentials[key] === value),
        );
        if (!matched) return null;
        const token = `mtk_${id('s').slice(2)}`;
        db.insert(schema.profileSessions).values({ token, profile: matched.name, sessionId: this.deps.sessionId }).run();
        return { profile: matched.name, token };
      },
    };
  }
}

/** gRPC is an ordinary POST wearing a content type; nothing else about it is ordinary. */
function isGrpcRequest(request: Request): boolean {
  return (request.headers.get('content-type') ?? '').startsWith('application/grpc');
}

function describeRequest(request: Request, url: URL, body: string) {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  return {
    method: request.method,
    url: url.toString(),
    path: url.pathname,
    query: Object.fromEntries(url.searchParams),
    headers,
    body,
  };
}

function parseBody(raw: string, contentType: string): unknown {
  if (!raw) return null;
  if (contentType.includes('json')) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  if (contentType.includes('x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(raw));
  return raw;
}

function toResponse(response: MockResponse): Response {
  const headers = new Headers(response.headers ?? {});
  if (response.raw !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'text/plain; charset=utf-8');
    return new Response(response.raw, { status: response.status, headers });
  }
  if (response.body === undefined) return new Response(null, { status: response.status, headers });
  headers.set('content-type', headers.get('content-type') ?? 'application/json');
  return new Response(JSON.stringify(response.body), { status: response.status, headers });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
