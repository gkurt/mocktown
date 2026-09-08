/**
 * Data access. Every hook here is a thin wrapper over one API procedure — the GUI's rule
 * from 09-gui-plugins.md is that it never gains logic of its own, and the honest test of
 * that is that this file has no branching in it beyond wiring.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { api, strandedToken, useStranded } from './api.ts';

export type IssueStatus = NonNullable<Parameters<typeof api.issues.list>[0]['status']>;

/**
 * Everything is scoped to one project, and the project is always visible
 * (08-projects-config.md).
 *
 * A stranded token (api.ts) fails every request, including the ones that were succeeding a
 * second earlier. There is nothing to poll for and nothing the reader can do from this page,
 * so the polling stops, the error is dropped for any query that already has data, and what
 * was last fetched stays on screen under the shell's banner.
 */
export function useProjectQuery<T>(
  key: unknown[],
  project: string,
  fn: () => Promise<T>,
  refetchMs?: number,
): { data: T | undefined; error: unknown } {
  const stranded = useStranded();
  const query = useQuery({
    queryKey: [...key, project],
    queryFn: fn,
    refetchInterval: stranded ? false : refetchMs,
    retry: stranded ? false : 1,
  });

  return { data: query.data, error: stranded && query.data !== undefined ? null : query.error };
}

export const useStatus = (project: string) => useProjectQuery(['status'], project, () => api.status.get({ project }), 4000);
export const useIssues = (project: string, status?: IssueStatus) =>
  useProjectQuery(['issues', status], project, () => api.issues.list({ project, status }), 4000);
export const useServices = (project: string) => useProjectQuery(['services'], project, () => api.services.list({ project }));
export const useRoutes = (project: string) => useProjectQuery(['routes'], project, () => api.recordings.routes({ project }));
export const useState_ = (project: string) => useProjectQuery(['state'], project, () => api.state.list({ project }), 5000);
export const usePanels = (project: string) => useProjectQuery(['panels'], project, () => api.panels.list({ project }));
export const useSeal = (project: string) => useProjectQuery(['seal'], project, () => api.seal.get({ project }));
export const useSandbox = (project: string) => useProjectQuery(['sandbox'], project, () => api.sandbox.get({ project }));
export const useDrift = (project: string) => useProjectQuery(['drift'], project, () => api.drift.get({ project }));
export const usePortless = (project: string) => useProjectQuery(['portless'], project, () => api.env.portless.get({ project }));
export const useProfiles = (project: string) => useProjectQuery(['profiles'], project, () => api.profiles.list({ project }));
export const useEnv = (project: string) => useProjectQuery(['env'], project, () => api.env.get({ project }));
export const useConfig = (project: string) => useProjectQuery(['config'], project, () => api.config.get({ project }));
export const useKnobs = (project: string, service: string) =>
  useProjectQuery(['knobs', service], project, () => api.knobs.get({ project, service }));

export type FeedEvent = Awaited<ReturnType<typeof api.feed.tail>>['events'][number];

const FEED_KEEP = 300;

/**
 * The live feed, as a long poll rather than a socket. The daemon holds the request open
 * until something happens or the wait elapses (daemon/events.ts), so this is one `fetch`
 * in a loop — and a dropped connection self-heals on the next turn of that loop.
 */
export function useFeed(project: string, kind?: FeedEvent['kind']): { events: FeedEvent[]; gaps: number; error: unknown } {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [gaps, setGaps] = useState(0);
  const [error, setError] = useState<unknown>(null);
  const cursor = useRef(0);

  useEffect(() => {
    let live = true;
    cursor.current = 0;
    setEvents([]);

    (async () => {
      while (live) {
        try {
          const page = await api.feed.tail({ project, since: cursor.current, kind, waitMs: 20_000 });
          if (!live) return;
          cursor.current = page.cursor;
          setError(null);
          // A gap means the ring dropped events this client never saw. Counting them is the
          // honest thing to do: a feed with a silent hole in it is worse than a marked one.
          if (page.gap) setGaps((count) => count + 1);
          if (page.events.length) setEvents((current) => [...page.events.toReversed(), ...current].slice(0, FEED_KEEP));
        } catch (failure) {
          if (!live) return;
          // A stranded token will refuse the next poll and every one after it. Stopping
          // leaves the events already received on screen, which is the whole point of the
          // feed; retrying every two seconds until reload would only replace them.
          if (strandedToken.get()) return;
          setError(failure);
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }
    })();

    return () => {
      live = false;
    };
  }, [project, kind]);

  return { events, gaps, error };
}
