/**
 * Route matching, and why nothing matched.
 *
 * The diagnosis half is what makes 07-issues-agent-loop.md's promise achievable — "the
 * nearest-matching existing behavior and *why* it didn't match". An issue saying "no
 * route matched" tells an agent nothing; an issue saying "`GET /v1/orders/{orderId}`
 * matched the path but this request was a PATCH" tells it exactly what to widen.
 *
 * **It ranks; it does not rule.** This used to end in a verdict: score the closest route,
 * and above a threshold call the issue a `near-miss` whose resolution was "widen the
 * existing route rather than adding a second one". The score measures how similar two
 * *strings* are, and no threshold on that can tell one endpoint from two. On the corpus
 * that prompted this, `clustering/search` scored 12 against `clustering/graph` and every
 * one of seven such issues was told to widen a route that had nothing to do with it —
 * `search` and `graph` are different endpoints returning different shapes.
 *
 * So the candidates come back ranked, with their scores and the reasons each one lost,
 * and the caller decides. A reader who can see that the best of them differs by a whole
 * path segment needs no verdict from us; one who cannot is not helped by a confident
 * wrong one.
 */
import type { MockRoute, MockSocket } from '#src/mocks/types.ts';

export interface RouteMatch {
  route: MockRoute;
  params: Record<string, string>;
}

const segmentsOf = (path: string) => path.split('/').filter(Boolean);
const isParam = (segment: string) => segment.startsWith('{') && segment.endsWith('}');

export function matchRoute(routes: MockRoute[], method: string, path: string): RouteMatch | null {
  const wanted = segmentsOf(path);
  for (const route of routes) {
    if (route.method.toUpperCase() !== method.toUpperCase()) continue;
    const template = segmentsOf(route.path);
    if (template.length !== wanted.length) continue;

    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < template.length; i++) {
      const t = template[i]!;
      const w = wanted[i]!;
      if (isParam(t)) params[t.slice(1, -1)] = decodeURIComponent(w);
      else if (t !== w) {
        ok = false;
        break;
      }
    }
    if (ok) return { route, params };
  }
  return null;
}

/** One declared route, and how close it came. */
export interface Candidate {
  method: string;
  path: string;
  describe?: string | undefined;
  /**
   * Similarity, not confidence: +3 for the verb, +2 for the segment count, then +2 per
   * literal segment that matched and +1 per `{param}`. Comparable between candidates for
   * the same request and meaningless between requests, which is why nothing thresholds it.
   */
  score: number;
  /** Why this one lost, most specific first. */
  reasons: string[];
}

export interface Diagnosis {
  /** Best first. Empty when the mock declares no routes at all. */
  nearest: Candidate[];
  suggestedResolution: string;
}

/** Why nothing matched: every declared route, scored and ranked, with no verdict attached. */
export function diagnose(routes: MockRoute[], method: string, path: string, limit = 3): Diagnosis {
  const wanted = segmentsOf(path);
  const upper = method.toUpperCase();

  const scored: Candidate[] = routes.map((route) => {
    const template = segmentsOf(route.path);
    const reasons: string[] = [];
    let score = 0;

    if (route.method.toUpperCase() !== upper) reasons.push(`method differs: route is ${route.method.toUpperCase()}, request was ${upper}`);
    else score += 3;

    if (template.length !== wanted.length) {
      reasons.push(`path depth differs: route has ${template.length} segments, request had ${wanted.length}`);
    } else {
      score += 2;
      for (let i = 0; i < template.length; i++) {
        const t = template[i]!;
        const w = wanted[i]!;
        if (isParam(t)) score += 1;
        else if (t === w) score += 2;
        else reasons.push(`segment ${i + 1}: route expects "${t}", request had "${w}"`);
      }
    }

    return { method: route.method.toUpperCase(), path: route.path, describe: route.describe, score, reasons };
  });

  const nearest = scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);

  return {
    nearest,
    // One instruction, whatever the scores. Whether this is a route to add or an existing
    // one to widen is a question about the API's shape, which `nearest` gives the reader
    // what they need to answer and which no similarity score can answer for them.
    suggestedResolution: nearest.length
      ? 'Serve this method and path template from the generated mock — either by widening one of the `nearest` routes in the ' +
        'diagnosis, if it turns out to be the same endpoint, or by adding a route of its own. The links show the corpus examples.'
      : 'The mock declares no routes at all. Add one for this method and path template; the links show the corpus examples.',
  };
}

export interface SocketMatch {
  socket: MockSocket;
  params: Record<string, string>;
}

/**
 * A WebSocket channel by path template. Same segment matching as a route — a socket path
 * in a generated mock is written in the corpus's own template form, so
 * `/v1/streams/{streamId}` lines up with what normalization produced from real traffic.
 */
export function matchSocket(sockets: MockSocket[], path: string): SocketMatch | null {
  const match = matchRoute(
    sockets.map((socket) => ({ method: 'GET', path: socket.path, handler: () => ({ status: 101 }) })),
    'GET',
    path,
  );
  if (!match) return null;
  const socket = sockets.find((entry) => entry.path === match.route.path);
  return socket ? { socket, params: match.params } : null;
}
