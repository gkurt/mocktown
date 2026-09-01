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
import { diagnose, matchRoute } from '#src/mocks/match.ts';
import { Prng, streamKey } from '#src/mocks/prng.ts';
import { SqliteStateStore } from '#src/mocks/state.ts';
import type { MockCtx, MockModule, MockRequest, MockResponse } from '#src/mocks/types.ts';
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

export class MockHost {
  private server?: ReturnType<typeof Bun.serve>;
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
    this.server = Bun.serve({
      port,
      hostname: '127.0.0.1', // 10-security.md: mocks never leave loopback
      fetch: (request) => this.handle(request),
    });
    this.port = this.server.port ?? port;
    return this.port;
  }

  async stop(): Promise<void> {
    await this.server?.stop(true);
    this.server = undefined;
  }

  private async handle(request: Request): Promise<Response> {
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
