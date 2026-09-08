/**
 * The service registry — the one place the GUI writes. Changing a service's provider is a
 * single-field mutation through `services.set`, which is why this page needs no form
 * library: the whole interaction is a select and an invalidate.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useServices } from '../hooks.ts';
import { Badge, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

const CHOICES = ['record', 'deny', 'passthrough'] as const;

export function Services({ project }: { project: string }) {
  const services = useServices(project);
  const queries = useQueryClient();
  const set = useMutation({
    mutationFn: (input: { id: string; provider: string }) => api.services.set({ project, id: input.id, provider: input.provider as any }),
    onSuccess: () => queries.invalidateQueries(),
  });

  if (services.error) return <Failure error={services.error} />;
  if (!services.data) return <Pending what="the registry" />;

  return (
    <Card title="Services">
      {services.data.services.length === 0 ? (
        <Empty>Empty registry. Anything the app calls while recording lands here.</Empty>
      ) : (
        <Table head={['service', 'provider', 'aliases', 'seed', 'origin', 'last seen']}>
          {services.data.services.map((service) => (
            <tr key={service.id}>
              <Cell mono>{service.id}</Cell>
              <Cell>
                {/* A generated or emulator provider carries a target after the colon, so it is not
                    a fixed choice — those are set from the CLI or mocktown.json. */}
                {service.provider.includes(':') ? (
                  <span className="font-mono">{service.provider}</span>
                ) : (
                  <select
                    className="rounded border border-line bg-raised px-1 py-0.5 font-mono"
                    value={service.provider}
                    disabled={set.isPending}
                    onChange={(event) => set.mutate({ id: service.id, provider: event.target.value })}
                  >
                    {CHOICES.map((choice) => (
                      <option key={choice} value={choice}>
                        {choice}
                      </option>
                    ))}
                  </select>
                )}
              </Cell>
              {/* Other hostnames routed here. Shown next to the provider because they share
                  it: an alias is the same mock and the same corpus under another name. */}
              <Cell mono>{service.aliases.length ? service.aliases.join(', ') : <Muted>—</Muted>}</Cell>
              <Cell mono>{service.seed ?? '—'}</Cell>
              <Cell>{service.discovered ? <Badge tone="warn">from traffic</Badge> : <Badge>configured</Badge>}</Cell>
              <Cell>
                <Muted>{service.lastSeenAt ? new Date(service.lastSeenAt).toLocaleString() : '—'}</Muted>
              </Cell>
            </tr>
          ))}
        </Table>
      )}
      {set.error && (
        <div className="mt-2">
          <Failure error={set.error} />
        </div>
      )}
    </Card>
  );
}
