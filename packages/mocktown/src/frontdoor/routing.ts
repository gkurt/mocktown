/**
 * The routing table the front door applies — 03-capture.md's mode table, resolved from
 * the service registry plus whatever providers are currently running.
 */
export type FrontDoorMode = 'record' | 'mock' | 'passthrough' | 'deny';

export interface Route {
  /** Hostname the client asked for. */
  host: string;
  mode: FrontDoorMode;
  /** For `mock`: the `host:port` a provider is actually listening on. */
  target?: string;
  /**
   * For `mock`: the provider's own protocol. A client calling `https://api.stripe.com`
   * must still reach an emulator that speaks plain HTTP, so the scheme is rewritten
   * alongside the host rather than inherited from the incoming request.
   */
  targetProtocol?: 'http' | 'https';
  /** For `mock`: which provider owns it, for issue attribution. */
  provider?: string;
}

export interface RoutingTable {
  routes: Route[];
  /**
   * What happens to a hostname with no route. `record` during a recording run,
   * `deny` in sealed mode — never `passthrough`, because a silent escape is the worst
   * failure this product has (spike 05).
   */
  fallthrough: 'record' | 'deny';
}

/** What the front door knows about a service beyond the provider the registry names. */
export interface RouteContext {
  /** Serve mode. A provider that is actually up outranks a pin nobody committed. */
  serving?: boolean;
  /** Sealed serve: no request may reach a real upstream, whatever the registry says. */
  sealed?: boolean;
  /** The registry row came from observed traffic, not from `mocktown.json`. */
  discovered?: boolean;
  /** Provider instance serving this host right now, for issue attribution. */
  servedBy?: string;
}

function mockRoute(host: string, baseUrl: string, provider: string): Route {
  const url = new URL(baseUrl);
  return {
    host,
    mode: 'mock',
    target: url.host,
    targetProtocol: url.protocol === 'https:' ? 'https' : 'http',
    provider,
  };
}

/**
 * Resolve one service registry entry into a front-door mode.
 *
 * @param providerBaseUrls service -> the base URL a running provider is listening on.
 */
export function routeForProvider(host: string, provider: string, providerBaseUrls: Map<string, string>, context: RouteContext = {}): Route {
  const baseUrl = providerBaseUrls.get(host);

  // The recorder pins every host it observes to `record`, so a service discovered during
  // a recording run carries that pin into serve mode — where honouring it would forward a
  // served request to the real upstream. A running provider outranks a pin nobody wrote
  // down, and a discovered pin under seal is denied rather than allowed to escape.
  if (context.serving && context.discovered && provider === 'record') {
    if (baseUrl) return mockRoute(host, baseUrl, context.servedBy ?? provider);
    if (context.sealed) return { host, mode: 'deny' };
  }

  if (provider === 'passthrough') return { host, mode: 'passthrough' };
  if (provider === 'record') return { host, mode: 'record' };
  if (provider === 'deny') return { host, mode: 'deny' };

  // A configured provider that isn't running must not fall back to the real upstream.
  // Denying is loud and files an issue; passing through would leak to production.
  if (!baseUrl) return { host, mode: 'deny', provider };

  return mockRoute(host, baseUrl, provider);
}

/**
 * Services whose route still reaches a real third-party upstream. A committed `record` or
 * `passthrough` is a decision we keep, but a served run must say out loud which hosts it
 * is not mocking — silence is what made this class of escape hard to notice.
 */
export function escapingHosts(table: RoutingTable): string[] {
  return table.routes.filter((route) => route.mode === 'record' || route.mode === 'passthrough').map((route) => route.host);
}

/** Stable signature, so the controller only re-applies rules when routing actually changed. */
export function tableSignature(table: RoutingTable): string {
  const routes = [...table.routes]
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((r) => `${r.host}:${r.mode}:${r.targetProtocol ?? ''}:${r.target ?? ''}`);
  return `${table.fallthrough}|${routes.join(',')}`;
}
