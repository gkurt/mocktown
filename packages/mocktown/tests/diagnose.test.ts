/**
 * What an unmatched request is told about the routes that exist.
 *
 * This used to end in a verdict. Above a similarity threshold the issue was typed
 * `near-miss` and its resolution read "widen the existing route rather than adding a
 * second one" — which is a claim that two paths are one endpoint, made by counting
 * matching path segments. On the corpus that retired it, seven issues for routes like
 * `clustering/search` were each told to widen `clustering/graph`: a different endpoint,
 * a different response shape, and a suggestion that would have produced a mock lying
 * about the API. The scores are still computed; they are reported instead of obeyed.
 */
import { expect, test } from 'bun:test';
import { diagnose } from '#src/mocks/match.ts';
import type { MockRoute } from '#src/mocks/types.ts';

const route = (method: string, path: string, describe?: string): MockRoute => ({
  method,
  path,
  describe,
  handler: () => ({ status: 200 }),
});

const ROUTES = [
  route('GET', '/v1/orgs/{orgId}/clustering/graph', 'clusters over time'),
  route('GET', '/v1/orgs/{orgId}/clustering/stats'),
  route('GET', '/v1/orgs/{orgId}/users'),
  route('POST', '/v1/orgs/{orgId}/graph'),
];

test('candidates come back ranked, with the score and the reasons each one lost', () => {
  const { nearest } = diagnose(ROUTES, 'GET', '/v1/orgs/o1/clustering/search');

  expect(nearest.map((c) => c.score)).toEqual([...nearest.map((c) => c.score)].sort((a, b) => b - a));
  expect(nearest[0]!.path).toBe('/v1/orgs/{orgId}/clustering/graph');
  expect(nearest[0]!.reasons).toEqual(['segment 5: route expects "graph", request had "search"']);
  // The describe travels, because "clusters over time" is what tells a reader this is a
  // different endpoint rather than the same one with a narrow template.
  expect(nearest[0]!.describe).toBe('clusters over time');
});

test('the suggestion never decides between widening and adding', () => {
  // The exact case that went wrong seven times: a top candidate scoring well while being
  // a different endpoint. Nothing in the output may assert which it is.
  const { nearest, suggestedResolution } = diagnose(ROUTES, 'GET', '/v1/orgs/o1/clustering/search');

  expect(nearest[0]!.score).toBeGreaterThan(4);
  expect(suggestedResolution).toContain('widening one of the `nearest` routes');
  expect(suggestedResolution).toContain('adding a route of its own');
  expect(suggestedResolution).not.toContain('rather than adding a second one');
});

test('more than one candidate is offered, so the ranking is visible as a ranking', () => {
  // A single "closest" reads as an answer. Three with their scores read as a shortlist,
  // which is what it has always been.
  const { nearest } = diagnose(ROUTES, 'GET', '/v1/orgs/o1/clustering/search');
  expect(nearest.length).toBeGreaterThan(1);
  expect(new Set(nearest.map((c) => c.path)).size).toBe(nearest.length);
});

test('a wrong verb is reported as a reason, not as a different kind of issue', () => {
  const { nearest } = diagnose(ROUTES, 'DELETE', '/v1/orgs/o1/users');
  expect(nearest[0]!.path).toBe('/v1/orgs/{orgId}/users');
  expect(nearest[0]!.reasons).toEqual(['method differs: route is GET, request was DELETE']);
});

test('a mock with no routes at all says so instead of ranking nothing', () => {
  const { nearest, suggestedResolution } = diagnose([], 'GET', '/v1/anything');
  expect(nearest).toEqual([]);
  expect(suggestedResolution).toContain('declares no routes at all');
});
