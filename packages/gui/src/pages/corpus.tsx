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

  return (
    <Card title={`Corpus — ${routes.data.routes.length} distinct routes`}>
      <Table head={['kind', 'method', 'service', 'path template', 'seen', 'statuses', 'last']}>
        {routes.data.routes.map((route) => (
          <tr key={`${route.kind}:${route.service}:${route.method}:${route.pathTemplate}`}>
            <Cell>
              <Badge tone={route.kind === 'grpc' ? 'bad' : route.kind === 'websocket' ? 'warn' : 'plain'}>{route.kind}</Badge>
            </Cell>
            <Cell mono>{route.method}</Cell>
            <Cell mono>{route.service}</Cell>
            <Cell mono>{route.pathTemplate}</Cell>
            <Cell>{route.count}</Cell>
            <Cell mono>{route.statuses.join(' ')}</Cell>
            <Cell>
              <Muted>{route.lastSeenAt ? new Date(route.lastSeenAt).toLocaleString() : '—'}</Muted>
            </Cell>
          </tr>
        ))}
      </Table>
      <p className="mt-2">
        <Muted>
          gRPC rows are recorded opaquely and cannot be served by a generated mock — Bun's server does not accept HTTP/2. Point those
          services at `record`, or run a real gRPC test double as `passthrough`.
        </Muted>
      </p>
    </Card>
  );
}
