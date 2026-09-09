/**
 * The corpus as a route table — HTTP, WebSocket channels and the gRPC methods that are
 * recorded but not servable (03-capture.md's amendment). Browsing individual rows is
 * Drizzle Studio's job (`mocktown studio`); this view answers "what does the mock have to
 * cover".
 *
 * It is also where recordings get deleted, because this is the screen on which someone
 * notices they should be. The route table is the only place a stray host, a route recorded
 * from the wrong environment, or a capture that should never have been taken is *visible* —
 * putting the delete anywhere else would mean reading it here and acting on it elsewhere.
 *
 * Unlike the state reset, every delete here is armed first: it is irreversible, and the
 * corpus is what mocks are generated and verified from.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useRoutes } from '../hooks.ts';
import { Badge, Card, Cell, Danger, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

type Deletion = { service: string; method?: string; pathTemplate?: string };

export function Corpus({ project }: { project: string }) {
  const routes = useRoutes(project);
  const queries = useQueryClient();
  const remove = useMutation({
    mutationFn: (scope: Deletion) => api.recordings.delete({ project, ...scope }),
    onSuccess: () => queries.invalidateQueries(),
  });

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
      {remove.error && <Failure error={remove.error} />}
      {remove.data && (
        <p className="rounded border border-line bg-raised px-2 py-1">
          <Muted>
            Deleted {remove.data.deleted} recording{remove.data.deleted === 1 ? '' : 's'}
            {remove.data.blobs ? ` and unlinked ${remove.data.blobs} spilled bod${remove.data.blobs === 1 ? 'y' : 'ies'}` : ''}.
            {/* Both of these are the reader's problem, not a detail: a service with nothing
                behind it makes `mocks verify` pass by having no work, and an issue that
                cited a deleted row has lost part of its evidence. */}
            {remove.data.emptiedServices.length ? ` Nothing is left for ${remove.data.emptiedServices.join(', ')}.` : ''}
            {remove.data.issues.length
              ? ` ${remove.data.issues.length} issue${remove.data.issues.length === 1 ? '' : 's'} cited a deleted row; the dead links were stripped.`
              : ''}
          </Muted>
        </p>
      )}

      {services.map(([service, rows]) => (
        <Card
          key={service}
          title={service}
          action={
            <span className="flex items-center gap-3">
              <Muted>
                {rows.length} {rows.length === 1 ? 'route' : 'routes'} · {weight(rows)} recordings
              </Muted>
              <Danger
                label="delete all"
                armed={`delete ${weight(rows)}?`}
                disabled={remove.isPending}
                onConfirm={() => remove.mutate({ service })}
              />
            </span>
          }
        >
          <Table head={['kind', 'method', 'path template', 'seen', 'statuses', 'last', '']}>
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
                  <Cell>
                    <Danger
                      label="delete"
                      armed={`delete ${route.count}?`}
                      disabled={remove.isPending}
                      // The template, not the concrete path: the row is a route, and the
                      // daemon filters on the same normalized column this table groups by.
                      onConfirm={() => remove.mutate({ service, method: route.method, pathTemplate: route.pathTemplate })}
                    />
                  </Cell>
                </tr>
              ))}
          </Table>
        </Card>
      ))}
      <p>
        <Muted>
          {routes.data.routes.length} distinct routes across {services.length} {services.length === 1 ? 'service' : 'services'}. Deleting is
          irreversible and takes the recordings only — generated mocks, the service registry and the seal stamp are left alone, so a mock
          whose evidence is gone keeps serving until someone changes it. Browsing and editing individual rows is Drizzle Studio's job — run
          `mocktown studio` for a table editor over this project's database. gRPC rows are recorded opaquely and cannot be served by a
          generated mock (Bun's server does not accept HTTP/2): point those services at `record`, or run a real gRPC test double as
          `passthrough`.
        </Muted>
      </p>
    </div>
  );
}
