/**
 * The corpus as a route table — HTTP, WebSocket channels and the gRPC methods that are
 * recorded but not servable (03-capture.md's amendment). Browsing individual rows is
 * Drizzle Studio's job (`mocktown studio`); this view answers "what does the mock have to
 * cover".
 */
import { useRoutes } from '../hooks.ts';
import { Badge, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

export function Corpus({ project }: { project: string }) {
  const routes = useRoutes(project);

  if (routes.error) return <Failure error={routes.error} />;
  if (!routes.data) return <Pending what="the corpus" />;
  if (!routes.data.routes.length) {
    return (
      <Card title="Corpus">
        <Empty>No recordings yet. `mocktown record -- &lt;your app&gt;` fills this in.</Empty>
      </Card>
    );
  }

  // One mock is written per service, so the routes one agent has to cover are the ones that
  // share a service. A flat table sorted by nothing made that grouping the reader's job.
  const byService = new Map<string, typeof routes.data.routes>();
  for (const route of routes.data.routes) byService.set(route.service, [...(byService.get(route.service) ?? []), route]);
  // Busiest first. Alphabetical buries the services a mock is actually written for under
  // whatever third-party noise the browser happened to make during a recording.
  const weight = (rows: typeof routes.data.routes) => rows.reduce((sum, route) => sum + route.count, 0);
  const services = [...byService.entries()].sort(([a, x], [b, y]) => weight(y) - weight(x) || a.localeCompare(b));

  return (
    <div className="flex flex-col gap-4">
      {services.map(([service, rows]) => (
        <Card
          key={service}
          title={service}
          action={
            <Muted>
              {rows.length} {rows.length === 1 ? 'route' : 'routes'} · {weight(rows)} recordings
            </Muted>
          }
        >
          <Table head={['kind', 'method', 'path template', 'seen', 'statuses', 'last']}>
            {rows
              .slice()
              .sort((a, b) => a.pathTemplate.localeCompare(b.pathTemplate) || a.method.localeCompare(b.method))
              .map((route) => (
                <tr key={`${route.kind}:${route.method}:${route.pathTemplate}`}>
                  <Cell>
                    <Badge tone={route.kind === 'grpc' ? 'bad' : route.kind === 'websocket' ? 'warn' : 'plain'}>{route.kind}</Badge>
                  </Cell>
                  <Cell mono>{route.method}</Cell>
                  <Cell mono>{route.pathTemplate}</Cell>
                  <Cell>{route.count}</Cell>
                  <Cell mono>{route.statuses.join(' ')}</Cell>
                  <Cell>
                    <Muted>{route.lastSeenAt ? new Date(route.lastSeenAt).toLocaleString() : '—'}</Muted>
                  </Cell>
                </tr>
              ))}
          </Table>
        </Card>
      ))}
      <p>
        <Muted>
          {routes.data.routes.length} distinct routes across {services.length} services. Browsing and editing individual rows is Drizzle
          Studio's job — run `mocktown studio` for a table editor over this project's database. gRPC rows are recorded opaquely and cannot
          be served by a generated mock (Bun's server does not accept HTTP/2): point those services at `record`, or run a real gRPC test
          double as `passthrough`.
        </Muted>
      </p>
    </div>
  );
}
