/**
 * The dashboard 09-gui-plugins.md asks for: resolved project, services and provider
 * status, seal state, the live feed and the issue queue — every one of them rendered from
 * an API response, with no derived state of its own.
 */
import { Link } from '@tanstack/react-router';
import { useIssues, usePortless, useSeal, useStatus } from '../hooks.ts';
import { Badge, Card, Cell, Empty, Failure, Muted, Ok, Pending, Table } from '../ui.tsx';
import { FeedLines } from './feed.tsx';

export function Dashboard({ project }: { project: string }) {
  const status = useStatus(project);
  const seal = useSeal(project);
  const issues = useIssues(project, 'outstanding');
  const portless = usePortless(project);

  if (status.error) return <Failure error={status.error} />;
  if (!status.data) return <Pending what="status" />;

  const { frontDoor, services, providers, recordings, outstandingIssues, session, warnings } = status.data;

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="Front door">
        <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
          <dt>
            <Muted>state</Muted>
          </dt>
          <dd>
            {frontDoor.running ? <Badge tone="good">running on :{frontDoor.port}</Badge> : <Badge>stopped</Badge>}{' '}
            <Badge tone={frontDoor.mode === 'deny' ? 'good' : 'warn'}>unknown hosts: {frontDoor.mode}</Badge>
          </dd>
          <dt>
            <Muted>session</Muted>
          </dt>
          <dd className="font-mono">{session ?? '—'}</dd>
          <dt>
            <Muted>recordings</Muted>
          </dt>
          <dd>{recordings}</dd>
          <dt>
            <Muted>open issues</Muted>
          </dt>
          <dd>
            <Link to="/issues" className="underline">
              {outstandingIssues}
            </Link>
          </dd>
          <dt>
            <Muted>stable names</Muted>
          </dt>
          <dd>
            {portless.data ? (
              <Badge tone={portless.data.available ? 'good' : 'plain'}>{portless.data.available ? 'portless' : 'loopback'}</Badge>
            ) : (
              '—'
            )}
          </dd>
        </dl>
        {warnings.length > 0 && (
          <ul className="mt-2 space-y-1">
            {warnings.map((warning) => (
              <li key={warning} className="text-warn">
                ! {warning}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Seal">
        {seal.error ? (
          <Failure error={seal.error} />
        ) : !seal.data ? (
          <Pending what="the seal" />
        ) : (
          <div className="space-y-2">
            <div>
              <Ok ok={seal.data.ok}>{seal.data.ok ? 'sealed' : 'not sealed'}</Ok>{' '}
              {seal.data.stamp && <Muted>stamped {new Date(seal.data.stamp.createdAt).toLocaleString()}</Muted>}
            </div>
            {seal.data.stale.length > 0 && (
              <ul className="space-y-1">
                {seal.data.stale.map((reason) => (
                  <li key={reason} className="text-warn">
                    {reason}
                  </li>
                ))}
              </ul>
            )}
            <Muted>
              flows: {seal.data.flows.length ? seal.data.flows.join(', ') : 'none configured — a seal with no flows proves nothing'}
            </Muted>
          </div>
        )}
      </Card>

      <Card title="Services">
        {services.length === 0 ? (
          <Empty>No services yet. Record something and they appear here.</Empty>
        ) : (
          <Table head={['service', 'provider', 'discovered', 'last seen']}>
            {services.map((service) => (
              <tr key={service.id}>
                <Cell mono>{service.id}</Cell>
                <Cell mono>{service.provider}</Cell>
                <Cell>{service.discovered ? <Badge tone="warn">from traffic</Badge> : <Badge>configured</Badge>}</Cell>
                <Cell>
                  <Muted>{service.lastSeenAt ? new Date(service.lastSeenAt).toLocaleTimeString() : '—'}</Muted>
                </Cell>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      <Card title="Providers">
        {providers.length === 0 ? (
          <Empty>Nothing is serving. `mocktown serve start` brings providers up.</Empty>
        ) : (
          <ul className="space-y-2">
            {providers.map((provider) => (
              <li key={provider.name}>
                <div>
                  <Badge tone={provider.running ? 'good' : 'bad'}>{provider.running ? 'running' : 'stopped'}</Badge>{' '}
                  <span className="font-mono">{provider.name}</span> <Muted>{provider.kind}</Muted>
                </div>
                <ul className="mt-1 ml-4 space-y-0.5 font-mono">
                  {Object.entries(provider.baseUrls).map(([service, url]) => (
                    <li key={service}>
                      {service} <Muted>→ {url}</Muted>
                    </li>
                  ))}
                </ul>
                {provider.warnings.map((warning) => (
                  <p key={warning} className="mt-1 ml-4 text-warn">
                    ! {warning}
                  </p>
                ))}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card
        title="Live feed"
        action={
          <Link to="/feed" className="underline">
            all events
          </Link>
        }
      >
        <FeedLines project={project} limit={12} />
      </Card>

      <Card
        title="Open issues"
        action={
          <Link to="/issues" className="underline">
            queue
          </Link>
        }
      >
        {issues.data?.issues.length ? (
          <ul className="space-y-1">
            {issues.data.issues.slice(0, 8).map((issue) => (
              <li key={issue.id}>
                <Badge tone="warn">{issue.type}</Badge> <span className="font-mono">{issue.service}</span>{' '}
                <Muted>
                  {issue.method ?? ''} {issue.pathTemplate ?? ''}
                </Muted>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>Nothing unserved. That is the goal state.</Empty>
        )}
      </Card>
    </div>
  );
}
