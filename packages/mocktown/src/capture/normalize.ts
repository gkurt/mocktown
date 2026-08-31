/**
 * Normalization at write time — 03-capture.md: path templating and volatile-header
 * stripping happen before the row lands, "so the corpus is immediately agent-legible".
 *
 * The template guess is the corpus's grouping key: every `/orders/8812` and
 * `/orders/9f3a` collapses to `/orders/{orderId}`, which is what an agent generating a
 * mock reasons about and what the issue engine compares against to spot a near-miss.
 */

/** Headers that change every request and would only add noise to a diff. */
const VOLATILE_REQUEST_HEADERS = new Set([
  "date", "connection", "keep-alive", "proxy-connection", "content-length",
  "if-none-match", "if-modified-since", "traceparent", "tracestate", "b3",
  "x-request-id", "x-correlation-id", "x-amzn-trace-id", "sec-fetch-dest",
  "sec-fetch-mode", "sec-fetch-site", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform",
]);

const VOLATILE_RESPONSE_HEADERS = new Set([
  "date", "connection", "keep-alive", "content-length", "transfer-encoding",
  "x-request-id", "x-runtime", "cf-ray", "cf-cache-status", "age", "server-timing",
  "x-served-by", "x-timer", "report-to", "nel", "alt-svc", "x-amz-request-id",
  "x-amz-id-2", "x-github-request-id", "request-id",
]);

export function stripVolatile(
  headers: Record<string, string | string[]>,
  direction: "request" | "response",
): Record<string, string | string[]> {
  const volatile = direction === "request" ? VOLATILE_REQUEST_HEADERS : VOLATILE_RESPONSE_HEADERS;
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !volatile.has(name.toLowerCase())));
}

/**
 * Segments that are plainly an identifier rather than a route word.
 *
 * Over-templating is the more expensive mistake — it merges two endpoints into one and
 * the mock loses a route — so each rule below is narrow enough to exclude route words
 * that happen to share a shape. `payment_intents` is the case that keeps this honest:
 * it is prefix-underscore-suffix like `cus_MR7dlLEfqZuUiAwY`, and the thing that
 * separates them is that an id's suffix carries digits.
 */
function looksLikeId(segment: string): boolean {
  if (!segment) return false;
  if (/^\d+$/.test(segment)) return true;                                    // 8812
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return true;  // uuid
  if (/^[0-9a-f]{16,}$/i.test(segment)) return true;                         // long hex
  if (/^\{\{secret:/.test(segment)) return true;                             // a scrubbed credential in the path

  // Prefixed ids: `inv_000001`, `cus_MR7dlLEfqZuUiAwY`, `ord_42`.
  const prefixed = /^[a-z]{2,6}_([A-Za-z0-9]+)$/.exec(segment);
  if (prefixed) {
    const suffix = prefixed[1]!;
    if (/^\d+$/.test(suffix)) return true;                                   // sequential ids
    if (suffix.length >= 8 && /\d/.test(suffix)) return true;                // opaque ids
  }

  // Mixed-case alphanumerics with digits and no separators, long enough to be an id
  // rather than a word: `9f3aK2Lm4Qp1` yes, `customers` no, `v1` no.
  if (segment.length >= 12 && /\d/.test(segment) && /^[A-Za-z0-9]+$/.test(segment)) return true;
  return false;
}

/** Singular parameter name derived from the collection segment before it. */
function paramName(previous: string | undefined, index: number): string {
  if (!previous || looksLikeId(previous)) return index === 0 ? "id" : `id${index + 1}`;
  const word = previous.replace(/[^A-Za-z0-9]/g, "");
  if (!word) return "id";
  const singular = word.endsWith("ies") ? `${word.slice(0, -3)}y` : word.endsWith("ses") ? word.slice(0, -2) : word.endsWith("s") ? word.slice(0, -1) : word;
  return `${singular.charAt(0).toLowerCase()}${singular.slice(1)}Id`;
}

export function templatePath(path: string): string {
  const segments = path.split("/");
  let idIndex = 0;
  const out = segments.map((segment, i) => {
    if (!looksLikeId(segment)) return segment;
    const name = paramName(segments[i - 1], idIndex);
    idIndex++;
    return `{${name}}`;
  });
  return out.join("/");
}

export interface NormalizedUrl {
  service: string;
  path: string;
  pathTemplate: string;
  query: Record<string, string>;
}

export function normalizeUrl(rawUrl: string): NormalizedUrl {
  const url = new URL(rawUrl);
  const query: Record<string, string> = {};
  for (const [key, value] of url.searchParams) query[key] = value;
  // The service is the hostname; the port is routing detail, not identity.
  return { service: url.hostname, path: url.pathname, pathTemplate: templatePath(url.pathname), query };
}

/** The corpus's route key: what "the same endpoint" means everywhere downstream. */
export const routeKey = (method: string, service: string, pathTemplate: string) =>
  `${method.toUpperCase()} ${service}${pathTemplate}`;
