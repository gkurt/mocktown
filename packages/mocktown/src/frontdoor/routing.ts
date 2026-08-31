/**
 * The routing table the front door applies — 03-capture.md's mode table, resolved from
 * the service registry plus whatever providers are currently running.
 */
export type FrontDoorMode = "record" | "mock" | "passthrough" | "deny";

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
  targetProtocol?: "http" | "https";
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
  fallthrough: "record" | "deny";
}

/**
 * Resolve one service registry entry into a front-door mode.
 *
 * @param providerBaseUrls service -> the base URL a running provider is listening on.
 */
export function routeForProvider(
  host: string,
  provider: string,
  providerBaseUrls: Map<string, string>,
): Route {
  if (provider === "passthrough") return { host, mode: "passthrough" };
  if (provider === "record") return { host, mode: "record" };
  if (provider === "deny") return { host, mode: "deny" };

  const baseUrl = providerBaseUrls.get(host);
  // A configured provider that isn't running must not fall back to the real upstream.
  // Denying is loud and files an issue; passing through would leak to production.
  if (!baseUrl) return { host, mode: "deny", provider };

  const url = new URL(baseUrl);
  return {
    host,
    mode: "mock",
    target: url.host,
    targetProtocol: url.protocol === "https:" ? "https" : "http",
    provider,
  };
}

/** Stable signature, so the controller only re-applies rules when routing actually changed. */
export function tableSignature(table: RoutingTable): string {
  const routes = [...table.routes]
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((r) => `${r.host}:${r.mode}:${r.targetProtocol ?? ""}:${r.target ?? ""}`);
  return `${table.fallthrough}|${routes.join(",")}`;
}
