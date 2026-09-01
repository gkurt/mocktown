/**
 * Route matching and near-miss diagnosis.
 *
 * The diagnosis half is what makes 07-issues-agent-loop.md's promise achievable — "the
 * nearest-matching existing behavior and *why* it didn't match". An issue saying "no
 * route matched" tells an agent nothing; an issue saying "`GET /v1/orders/{orderId}`
 * matched the path but this request was a PATCH" tells it exactly what to widen.
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

export interface NearMiss {
  /** `unmatched-request` when nothing is close, `near-miss` when one route almost fit. */
  kind: 'unmatched-request' | 'near-miss';
  closest: { method: string; path: string; describe?: string } | null;
  /** Human- and agent-readable reasons, most specific first. */
  reasons: string[];
  suggestedResolution: string;
}

/**
 * Why nothing matched. Deliberately conservative about calling something a near miss:
 * a wrong verdict here sends an agent to widen a matcher that was never involved.
 */
export function diagnose(routes: MockRoute[], method: string, path: string): NearMiss {
  const wanted = segmentsOf(path);
  const upper = method.toUpperCase();

  let best: { route: MockRoute; score: number; reasons: string[] } | null = null;

  for (const route of routes) {
    const template = segmentsOf(route.path);
    const reasons: string[] = [];
    let score = 0;

    if (route.method.toUpperCase() !== upper) reasons.push(`method differs: route is ${route.method.toUpperCase()}, request was ${upper}`);
    else score += 3;

    if (template.length !== wanted.length) {
      reasons.push(`path depth differs: route has ${template.length} segments, request had ${wanted.length}`);
    } else {
      score += 2;
      const mismatched: string[] = [];
      for (let i = 0; i < template.length; i++) {
        const t = template[i]!;
        const w = wanted[i]!;
        if (isParam(t)) {
          score += 1;
          continue;
        }
        if (t === w) {
          score += 2;
          continue;
        }
        mismatched.push(`segment ${i + 1}: route expects "${t}", request had "${w}"`);
      }
      reasons.push(...mismatched);
    }

    if (!best || score > best.score) best = { route, score, reasons };
  }

  if (!best || best.score < 4) {
    return {
      kind: 'unmatched-request',
      closest: best ? { method: best.route.method, path: best.route.path, describe: best.route.describe } : null,
      reasons: best ? best.reasons : ['the mock declares no routes for this service'],
      suggestedResolution: 'Add a route for this method and path template to the generated mock, using the corpus examples linked below.',
    };
  }

  // A route that shares the verb and the path shape failed on detail — that is drift in
  // an existing route, and widening it beats duplicating it (07's house rules).
  return {
    kind: 'near-miss',
    closest: { method: best.route.method, path: best.route.path, describe: best.route.describe },
    reasons: best.reasons.length ? best.reasons : ['the route matched structurally but the handler rejected the request'],
    suggestedResolution: `Widen the existing \`${best.route.method.toUpperCase()} ${best.route.path}\` route rather than adding a second one.`,
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
