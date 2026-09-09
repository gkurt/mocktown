/**
 * The live feed. Every line is one API event rendered as text — the summary comes from
 * recorded traffic, so it is untrusted input and is never rendered as markup (10-security.md,
 * and React's default escaping is what enforces it).
 */
import { useState } from 'react';
import { Choice, Dials } from '../dials.tsx';
import { type FeedEvent, useFeed } from '../hooks.ts';
import { Badge, Card, Empty, Failure, Muted } from '../ui.tsx';

const KINDS: FeedEvent['kind'][] = ['exchange', 'wall-hit', 'issue', 'provider', 'session', 'socket', 'drift'];

const TONE: Record<FeedEvent['kind'], 'good' | 'warn' | 'bad' | 'plain'> = {
  exchange: 'plain',
  'wall-hit': 'bad',
  issue: 'warn',
  provider: 'plain',
  session: 'plain',
  socket: 'plain',
  drift: 'warn',
};

export function FeedLines({ project, limit, kind }: { project: string; limit?: number; kind?: FeedEvent['kind'] }) {
  const { events, gaps, error } = useFeed(project, kind);
  if (error) return <Failure error={error} />;
  if (!events.length) return <Empty>Waiting for traffic. Anything through the front door shows up here.</Empty>;

  return (
    <div className="space-y-1">
      {gaps > 0 && <Muted>the feed is a window, not a log — {gaps} gap(s) since this page opened</Muted>}
      <ul className="space-y-0.5 font-mono">
        {events.slice(0, limit).map((event) => (
          // The row must not wrap: a feed where one long path reflows into three lines stops
          // being scannable, which is the only thing a feed is for.
          <li key={event.seq} className="flex items-baseline gap-2 whitespace-nowrap">
            <span className="shrink-0 text-muted tabular-nums">{new Date(event.at).toLocaleTimeString([], { hour12: false })}</span>
            <span className="shrink-0">
              <Badge tone={TONE[event.kind]}>{event.kind}</Badge>
            </span>
            <span className="truncate" title={event.summary}>
              {event.summary}
            </span>
            {event.durationMs !== null && <span className="ml-auto shrink-0 text-muted tabular-nums">{event.durationMs}ms</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Feed({ project }: { project: string }) {
  const [kind, setKind] = useState<FeedEvent['kind'] | undefined>(undefined);

  return (
    <Card
      title="Live feed"
      action={
        <Dials row>
          <Choice
            label="kind"
            value={kind ?? ''}
            options={[{ value: '', label: 'every kind' }, ...KINDS.map((kind) => ({ value: kind, label: kind }))]}
            onChange={(next) => setKind(KINDS.find((option) => option === next))}
          />
        </Dials>
      }
    >
      <FeedLines project={project} kind={kind} />
    </Card>
  );
}
