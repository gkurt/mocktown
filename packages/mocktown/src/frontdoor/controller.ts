/**
 * The daemon's half of the front door: spawn the Node sidecar, drive the Mockttp
 * instance inside it over the admin-server protocol, and turn what flows through into
 * events the recorder and issue engine consume.
 *
 * Two rules from phase 0 are structural here rather than remembered:
 *
 *   - **Every rule sets `.always()`.** Mockttp rules stop matching once consumed, and a
 *     forwarding rule that silently expires sends subsequent traffic to the *real*
 *     upstream — the worst failure mode this product has (spike 05).
 *   - **The fallthrough denies and logs; it never passes through.** An escape has to be
 *     loud (03-capture.md).
 *
 * Two more are structural because the remote client made us learn them the hard way; see
 * `subscribe` and `applyRouting`.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Mockttp, RequestRuleData, WebSocketRuleData } from 'mockttp';
import * as mockttp from 'mockttp';
import { completionCheckers, matchers, requestSteps, webSocketSteps } from 'mockttp';
import { isLoopbackName } from '#src/capture/launch.ts';
import { type Route, type RoutingTable, tableSignature } from '#src/frontdoor/routing.ts';
import { findFreePort } from '#src/util/ports.ts';

const sidecarPath = join(dirname(fileURLToPath(import.meta.url)), 'sidecar.ts');

/** Mockttp's own fallback priority, so an unmatched-request rule loses to every route. */
const FALLBACK_PRIORITY = 0;

/** How a body reached us. `base64` means it was not valid UTF-8 and must not be stringified. */
export type BodyEncoding = 'text' | 'base64';

/** One captured exchange, raw. It goes straight to the recorder, which scrubs it. */
export interface CapturedExchange {
  id: string;
  method: string;
  url: string;
  statusCode: number;
  requestHeaders: Record<string, string | string[]>;
  responseHeaders: Record<string, string | string[]>;
  requestBody: string;
  responseBody: string;
  /**
   * Per side: a JSON request with a PNG response is ordinary, and base64-ing the readable
   * half would cost the corpus its legibility for nothing (03-capture.md).
   */
  requestEncoding: BodyEncoding;
  responseEncoding: BodyEncoding;
  /** `grpc` is an opaque h2 exchange: recorded, deliberately not interpreted. */
  kind: 'http' | 'grpc';
  durationMs: number | null;
  /** Which front-door mode served it, so the recorder knows whether to persist. */
  mode: string;
}

/** One WebSocket message, from the *client's* point of view. */
export interface CapturedFrame {
  direction: 'sent' | 'received';
  body: string;
  encoding: BodyEncoding;
  /** Milliseconds since the socket opened, so a mock can reproduce the cadence. */
  atMs: number;
}

/**
 * A whole WebSocket conversation, delivered when it closes.
 *
 * A socket is one exchange in the corpus, not one per frame: "what does this channel carry"
 * is the question a generating agent asks, and a per-frame corpus answers a different one.
 * The cost is that a socket that never closes is never recorded, which is why `truncated`
 * exists and why the frame cap is generous rather than tight.
 */
export interface CapturedSocket {
  id: string;
  url: string;
  requestHeaders: Record<string, string | string[]>;
  responseHeaders: Record<string, string | string[]>;
  /** 101 when the upgrade was accepted; whatever was returned when it was not. */
  statusCode: number;
  frames: CapturedFrame[];
  truncated: boolean;
  close: { code: number; reason: string; by: 'client' | 'upstream' } | null;
  durationMs: number | null;
  mode: string;
}

export interface FrontDoorEvents {
  onExchange?: (exchange: CapturedExchange) => void;
  /** A closed WebSocket conversation (03-capture.md's deferred list, phase 4). */
  onSocket?: (socket: CapturedSocket) => void;
  /** A socket opening or closing, for the live feed — the corpus row only lands at close. */
  onSocketLifecycle?: (event: { url: string; phase: 'open' | 'close'; frames: number; mode: string }) => void;
  /** A request that hit a `deny` route or the fallthrough — the issue engine's input. */
  onWallHit?: (hit: WallHit) => void;
  /** TLS interception refused by the client: a `pinned-client` issue (03-capture.md). */
  onPinnedClient?: (event: { hostname: string | undefined; reason: string }) => void;
}

/**
 * `deny` and `provider-down` are both walls, but they are different mistakes: one is the
 * registry saying no, the other is a provider that was supposed to be serving and is not.
 * Reporting them as one makes the issue's diagnosis wrong for whichever case it isn't.
 */
export interface WallHit {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: string;
  reason: 'deny' | 'unknown-host' | 'provider-down' | 'own-service';
  /** For `provider-down`: the provider the registry expected to be serving this host. */
  provider?: string;
}

export interface FrontDoorOptions {
  ca: { cert: string; key: string };
  port?: number;
  /** Node binary to run the sidecar with; `node` from the daemon's PATH when unset. */
  nodePath?: string;
}

interface HalfRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[]>;
  body: string;
  encoding: BodyEncoding;
  startedAt: number;
}

interface HalfResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: string;
  encoding: BodyEncoding;
}

/** The two halves of one exchange, joined whichever order they arrive in. */
interface Exchange {
  request?: HalfRequest;
  response?: HalfResponse;
  seenAt: number;
}

/** How long a half-exchange waits for its other half before being swept. */
const HALF_EXCHANGE_TTL_MS = 120_000;

/**
 * Frames kept per socket. A chat or telemetry channel can run for hours; past this the
 * corpus has learned everything a mock needs about the channel's shape, and the row says
 * it was truncated rather than pretending it saw the whole conversation.
 */
const MAX_SOCKET_FRAMES = 500;

/** One WebSocket connection, accumulated until it closes. */
interface OpenSocket {
  url: string;
  requestHeaders: Record<string, string | string[]>;
  responseHeaders: Record<string, string | string[]>;
  statusCode: number;
  frames: CapturedFrame[];
  truncated: boolean;
  startedAt: number;
  mode: string;
}

export class FrontDoor {
  private sidecar?: ChildProcess;
  private proxy?: Mockttp;
  private appliedSignature?: string;
  private routes = new Map<string, Route>();
  private exchanges = new Map<string, Exchange>();
  private sockets = new Map<string, OpenSocket>();
  private lastSweep = 0;
  readonly log: string[] = [];
  port = 0;
  adminPort = 0;

  private readonly options: FrontDoorOptions;
  private readonly events: FrontDoorEvents;

  constructor(options: FrontDoorOptions, events: FrontDoorEvents = {}) {
    this.options = options;
    this.events = events;
  }

  get isRunning(): boolean {
    return !!this.proxy && !!this.sidecar && this.sidecar.exitCode === null;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.adminPort = await findFreePort(4700);
    this.port = this.options.port ?? (await findFreePort(4400));

    const nodePath = this.options.nodePath ?? 'node';
    const sidecar = spawn(nodePath, [sidecarPath, String(this.adminPort)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.sidecar = sidecar;

    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`front door sidecar did not start within 20s\n${this.log.join('')}`)), 20_000);
        const onData = (buf: Buffer) => {
          const text = buf.toString();
          this.log.push(text);
          if (text.includes('"ready":true')) {
            clearTimeout(timer);
            resolve();
          }
        };
        sidecar.stdout?.on('data', onData);
        sidecar.stderr?.on('data', onData);
        sidecar.once('exit', (code) => {
          clearTimeout(timer);
          reject(new Error(`front door sidecar exited with code ${code}\n${this.log.join('')}`));
        });
        // A spawn failure is an `error` event, not an exit, and an unhandled one takes the
        // daemon down with it — which is how a Bun-only machine used to surface: the CLI saw
        // a closed socket and nothing else. The commonest cause gets named.
        sidecar.once('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          reject(error.code === 'ENOENT' ? new Error(missingNodeMessage(nodePath)) : error);
        });
      });
    } catch (error) {
      // Otherwise `isRunning` keeps pointing at a child that never ran and the next start
      // is refused, so a fixed PATH would still need a daemon restart.
      this.sidecar = undefined;
      throw error;
    }

    this.proxy = mockttp.getRemote({
      adminServerUrl: `http://127.0.0.1:${this.adminPort}`,
      https: { cert: this.options.ca.cert, key: this.options.ca.key },
      // `getRemote` defaults this to `true` ("for other clients, it doesn't hurt"), which
      // is written for a Mockttp that is the *target* of browser requests. The front door
      // is a transparent proxy, so it hurts: the `cors` middleware sits in front of the
      // rules and answers every OPTIONS preflight itself with `Access-Control-Allow-Origin:
      // *`. The request never reaches the upstream, so it never reaches the corpus either —
      // and a browser sending credentials rejects the wildcard outright, which is how this
      // surfaces: every credentialed cross-origin call fails while GETs look fine.
      // A preflight is a real exchange a mock has to reproduce; it must be recorded.
      cors: false,
    });
    await this.proxy.start(this.port);
    await this.subscribe();
  }

  /**
   * Subscribe exactly once, for the life of the proxy.
   *
   * `request` and `response` do **not** arrive in that order. When Mockttp answers a
   * request itself — a `deny` rule — both events cross the admin-server websocket at
   * once and the response routinely wins. Pairing them by arrival order silently drops
   * every locally-answered exchange, which is precisely the wall-hit traffic the issue
   * engine exists to see. So the two halves are joined by id, whichever lands first.
   */
  private async subscribe(): Promise<void> {
    const proxy = this.proxy!;

    await proxy.on('request', async (request) => {
      const { body, encoding } = await readBody(request.body);
      this.join(request.id, {
        request: {
          method: request.method,
          url: request.url,
          headers: request.headers as Record<string, string | string[]>,
          body,
          encoding,
          startedAt: Date.now(),
        },
      });
    });

    await proxy.on('response', async (response) => {
      const { body, encoding } = await readBody(response.body);
      this.join(response.id, {
        response: {
          statusCode: response.statusCode,
          headers: response.headers as Record<string, string | string[]>,
          body,
          encoding,
        },
      });
    });

    // An aborted request never gets a response half; drop it rather than let it linger.
    // A socket that dies without a close frame arrives here too, and is worth keeping —
    // an unclean disconnect is exactly the behaviour a mock has to be able to reproduce.
    await proxy.on('abort', (request) => {
      this.exchanges.delete(request.id);
      this.closeSocket(request.id, null);
    });

    // ── WebSockets ────────────────────────────────────────────────────────────
    // Five events per connection, joined by `streamId` the same way request and response
    // are joined by id: nothing here may assume an ordering the protocol does not promise.
    await proxy.on('websocket-request', (request) => {
      this.sockets.set(request.id, {
        url: request.url,
        requestHeaders: request.headers as Record<string, string | string[]>,
        responseHeaders: {},
        statusCode: 0,
        frames: [],
        truncated: false,
        startedAt: Date.now(),
        mode: this.modeFor(request.url),
      });
      this.events.onSocketLifecycle?.({ url: request.url, phase: 'open', frames: 0, mode: this.modeFor(request.url) });
    });

    await proxy.on('websocket-accepted', (response) => {
      const socket = this.sockets.get(response.id);
      if (!socket) return;
      socket.statusCode = response.statusCode;
      socket.responseHeaders = response.headers as Record<string, string | string[]>;
    });

    // Mockttp's `direction` is written from the proxy's point of view; the corpus is
    // written from the client's, because that is whose behaviour a mock has to reproduce.
    // `received` (Mockttp got it from the client) is therefore `sent` here.
    await proxy.on('websocket-message-received', (message) => this.frame(message.streamId, 'sent', message));
    await proxy.on('websocket-message-sent', (message) => this.frame(message.streamId, 'received', message));

    await proxy.on('websocket-close', (event) => {
      this.closeSocket(event.streamId, {
        code: event.closeCode ?? 1005,
        reason: event.closeReason,
        by: 'upstream',
      });
    });

    // A client that refuses our certificate is pinned; documented out of scope, but it
    // must be surfaced rather than looking like a network failure (03-capture.md).
    await proxy.on('tls-client-error', (event) => {
      this.events.onPinnedClient?.({ hostname: event.tlsMetadata?.sniHostname, reason: event.failureCause });
    });
  }

  private join(id: string, half: Partial<Exchange>): void {
    const entry = this.exchanges.get(id) ?? { seenAt: Date.now() };
    Object.assign(entry, half);
    if (!entry.request || !entry.response) {
      this.exchanges.set(id, entry);
      this.sweep();
      return;
    }

    this.exchanges.delete(id);
    const { request, response } = entry;
    const mode = this.modeFor(request.url);

    if (mode === 'deny') {
      const route = this.routes.get(hostOf(request.url));
      this.events.onWallHit?.({
        method: request.method,
        url: request.url,
        headers: request.headers,
        body: request.body,
        // A route carrying a provider is one whose provider never came up — the registry
        // said `generated:x`, routing had nowhere to send it, and denying was the safe
        // answer. A route with no provider is a registry `deny`; no route at all is a
        // host nobody has decided about yet — unless it is this machine talking to
        // itself, which is the app's own service arriving here because the blanket
        // `localhost` bypass was dropped. Same denial, different mistake, so it must not
        // be reported as an undeclared third-party dependency.
        reason: !route ? (isLoopbackName(hostOf(request.url)) ? 'own-service' : 'unknown-host') : route.provider ? 'provider-down' : 'deny',
        provider: route?.provider,
      });
      return;
    }

    this.events.onExchange?.({
      id,
      method: request.method,
      url: request.url,
      statusCode: response.statusCode,
      requestHeaders: request.headers,
      responseHeaders: response.headers,
      requestBody: request.body,
      responseBody: response.body,
      requestEncoding: request.encoding,
      responseEncoding: response.encoding,
      kind: isGrpc(request.headers) ? 'grpc' : 'http',
      durationMs: Date.now() - request.startedAt,
      mode,
    });
  }

  private frame(streamId: string, direction: 'sent' | 'received', message: { content: Uint8Array; isBinary: boolean }): void {
    const socket = this.sockets.get(streamId);
    if (!socket) return;
    if (socket.frames.length >= MAX_SOCKET_FRAMES) {
      socket.truncated = true;
      return;
    }
    const { body, encoding } = encodeBytes(Buffer.from(message.content), message.isBinary);
    socket.frames.push({ direction, body, encoding, atMs: Date.now() - socket.startedAt });
  }

  private closeSocket(streamId: string, close: CapturedSocket['close']): void {
    const socket = this.sockets.get(streamId);
    if (!socket) return;
    this.sockets.delete(streamId);
    this.events.onSocketLifecycle?.({ url: socket.url, phase: 'close', frames: socket.frames.length, mode: socket.mode });
    this.events.onSocket?.({
      id: streamId,
      url: socket.url,
      requestHeaders: socket.requestHeaders,
      responseHeaders: socket.responseHeaders,
      // A socket that was rejected never got an upgrade; 101 would be a lie.
      statusCode: socket.statusCode || 0,
      frames: socket.frames,
      truncated: socket.truncated,
      close,
      durationMs: Date.now() - socket.startedAt,
      mode: socket.mode,
    });
  }

  /** A half that never found its partner — a dropped connection — must not accumulate. */
  private sweep(): void {
    const now = Date.now();
    if (now - this.lastSweep < HALF_EXCHANGE_TTL_MS) return;
    this.lastSweep = now;
    for (const [id, entry] of this.exchanges) {
      if (now - entry.seenAt > HALF_EXCHANGE_TTL_MS) this.exchanges.delete(id);
    }
  }

  private modeFor(url: string): string {
    return this.routes.get(hostOf(url))?.mode ?? this.fallthroughMode;
  }

  private fallthroughMode: 'record' | 'deny' = 'deny';

  /**
   * Re-apply the whole rule set. Mockttp has no incremental rule editing, and rebuilding
   * is cheap, so the table is the unit of change — which also means routing can never
   * drift halfway between two configurations.
   *
   * The rules are built as data and installed with `setRequestRules` rather than through
   * the `forAnyRequest()...` builder, because the builder's only way to clear the old set
   * is `reset()` — and `reset()` also tears down the server-side event subscriptions
   * while leaving the client-side callbacks registered. Re-subscribing after it revives
   * every callback ever registered, so each `applyRouting` would deliver one more copy of
   * every event: duplicate recordings, duplicate issues. Replacing rules leaves the
   * subscriptions from `start()` alone.
   */
  async applyRouting(table: RoutingTable): Promise<void> {
    if (!this.proxy) throw new Error('front door is not running');
    const signature = tableSignature(table);
    if (signature === this.appliedSignature) return;

    this.fallthroughMode = table.fallthrough;
    this.routes = new Map(table.routes.map((r) => [r.host, r]));

    const requestRules: RequestRuleData[] = table.routes.map((route) => ({
      matchers: [new matchers.WildcardMatcher(), new matchers.HostnameMatcher(route.host)],
      steps: [requestStepFor(route)],
      completionChecker: new completionCheckers.Always(),
    }));

    // WebSockets are recorded, not mocked, until phase 4 (03-capture.md). Denied hosts
    // deny here too, so a WS upgrade can't become an escape hatch past the wall.
    const webSocketRules: WebSocketRuleData[] = table.routes.map((route) => ({
      matchers: [new matchers.WildcardMatcher(), new matchers.HostnameMatcher(route.host)],
      steps: [webSocketStepFor(route)],
      completionChecker: new completionCheckers.Always(),
    }));

    if (table.fallthrough === 'record') {
      requestRules.push({
        priority: FALLBACK_PRIORITY,
        matchers: [new matchers.WildcardMatcher()],
        steps: [new requestSteps.PassThroughStep()],
        completionChecker: new completionCheckers.Always(),
      });
      webSocketRules.push({
        priority: FALLBACK_PRIORITY,
        matchers: [new matchers.WildcardMatcher()],
        steps: [new webSocketSteps.PassThroughWebSocketStep()],
        completionChecker: new completionCheckers.Always(),
      });
    } else {
      requestRules.push({
        priority: FALLBACK_PRIORITY,
        matchers: [new matchers.WildcardMatcher()],
        steps: [jsonStep(502, denyBody(null, 'No provider is registered for this host and the front door is sealed.'))],
        completionChecker: new completionCheckers.Always(),
      });
      webSocketRules.push({
        priority: FALLBACK_PRIORITY,
        matchers: [new matchers.WildcardMatcher()],
        steps: [new webSocketSteps.RejectWebSocketStep(502, 'Denied by mocktown')],
        completionChecker: new completionCheckers.Always(),
      });
    }

    await this.proxy.setRequestRules(...requestRules);
    await this.proxy.setWebSocketRules(...webSocketRules);
    this.appliedSignature = signature;
  }

  async stop(): Promise<void> {
    try {
      await this.proxy?.stop();
    } catch {
      /* the sidecar is about to go anyway */
    }
    this.proxy = undefined;
    this.appliedSignature = undefined;
    this.exchanges.clear();
    this.sockets.clear();

    const child = this.sidecar;
    this.sidecar = undefined;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => {
        clearTimeout(force);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}

function missingNodeMessage(nodePath: string): string {
  return (
    `front door sidecar: cannot run \`${nodePath}\` — not found. The front door is Mockttp in a real Node ` +
    'process (02-architecture.md), so the daemon needs a Node binary: install one on the PATH the daemon was started ' +
    'with, or set MOCKTOWN_NODE to its path, then `mocktown daemon stop` so the next command restarts the daemon with it.'
  );
}

function requestStepFor(route: Route) {
  switch (route.mode) {
    case 'record':
    case 'passthrough':
      return new requestSteps.PassThroughStep();
    case 'mock':
      return new requestSteps.PassThroughStep({
        transformRequest: {
          // The scheme is rewritten too: a client calling `https://api.stripe.com` must
          // reach an emulator that speaks plain HTTP. Inheriting the incoming protocol
          // would send TLS at a cleartext listener and fail as a 502.
          setProtocol: route.targetProtocol ?? 'http',
          // Keep the original Host header: a generated mock for api.stripe.com should
          // see `Host: api.stripe.com`, not the loopback address it listens on.
          replaceHost: { targetHost: route.target!, updateHostHeader: false },
        },
      });
    case 'deny':
      return jsonStep(502, denyBody(route.host, "This service is set to deny in the project's service registry."));
  }
}

function webSocketStepFor(route: Route) {
  switch (route.mode) {
    case 'deny':
      return new webSocketSteps.RejectWebSocketStep(502, 'Denied by mocktown');
    case 'mock':
      return new webSocketSteps.PassThroughWebSocketStep({
        transformRequest: {
          setProtocol: route.targetProtocol === 'https' ? 'wss' : 'ws',
          replaceHost: { targetHost: route.target!, updateHostHeader: false },
        },
      });
    default:
      return new webSocketSteps.PassThroughWebSocketStep();
  }
}

function jsonStep(status: number, body: unknown) {
  return new requestSteps.FixedResponseStep(status, undefined, JSON.stringify(body), {
    'content-type': 'application/json',
  });
}

/**
 * A body as text when it *is* text, and base64 when it is not.
 *
 * `getText()` alone is not enough: it decodes bytes as UTF-8 unconditionally, so a
 * protobuf frame or a PNG comes back as replacement characters and the corpus stores a
 * corrupted body that looks like a real one. Deciding by round-trip rather than by
 * content-type is deliberate — a mislabelled `application/json` that is actually gzip is
 * exactly the case a header check would get wrong.
 */
async function readBody(body: { getDecodedBuffer(): Promise<Buffer | undefined> }): Promise<{ body: string; encoding: BodyEncoding }> {
  const buffer = await body.getDecodedBuffer().catch(() => undefined);
  if (!buffer || buffer.length === 0) return { body: '', encoding: 'text' };
  return encodeBytes(buffer, false);
}

function encodeBytes(buffer: Buffer, forceBinary: boolean): { body: string; encoding: BodyEncoding } {
  if (!forceBinary) {
    const text = buffer.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(buffer)) return { body: text, encoding: 'text' };
  }
  return { body: buffer.toString('base64'), encoding: 'base64' };
}

/** gRPC is an ordinary h2 POST wearing a content type; nothing else about it is ordinary. */
function isGrpc(headers: Record<string, string | string[]>): boolean {
  const contentType = headers['content-type'];
  return String(Array.isArray(contentType) ? contentType[0] : (contentType ?? '')).startsWith('application/grpc');
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * A denial is agent-facing output: it says what happened, which project wall it hit, and
 * what to do next. An opaque 502 would just look like a flaky network.
 */
function denyBody(host: string | null, why: string) {
  return {
    error: 'mocktown_denied',
    message: why,
    host,
    hint: 'Run `mocktown issues list` — this request was filed as an issue with the request that triggered it.',
  };
}
