/**
 * The service registry — the one place the GUI writes. Changing a service's provider is a
 * single-field mutation through `services.set`, which is why this page needs no form
 * library: the whole interaction is one dial and an invalidate.
 *
 * The dial is in a drawer rather than in the row. A provider is the one decision on this
 * screen — it is what decides whether a service records, denies or reaches the real world —
 * and a select dropped into a table cell reads as another column of data rather than as the
 * one thing here that changes what the front door does. The drawer is also where a service's
 * aliases and seed get the room to be read, which a cell of comma-joined hostnames did not.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Choice, Dials } from '../dials.tsx';
import { useServices } from '../hooks.ts';
import { Badge, Card, Cell, Drawer, Empty, Failure, Muted, Pending, RowButton, Table } from '../ui.tsx';

const CHOICES = ['record', 'deny', 'passthrough'] as const;

type Service = NonNullable<ReturnType<typeof useServices>['data']>['services'][number];

export function Services({ project }: { project: string }) {
  const services = useServices(project);
  const [open, setOpen] = useState<string | null>(null);
  const queries = useQueryClient();
  const set = useMutation({
    mutationFn: (input: { id: string; provider: (typeof CHOICES)[number] }) => api.services.set({ project, ...input }),
    onSuccess: () => queries.invalidateQueries(),
  });

  if (services.error) return <Failure error={services.error} />;
  if (!services.data) return <Pending what="the registry" />;

  const active = services.data.services.find((service) => service.id === open);

  return (
    <>
      <Card title="Services">
        {services.data.services.length === 0 ? (
          <Empty>Empty registry. Anything the app calls while recording lands here.</Empty>
        ) : (
          <Table head={['', 'service', 'provider', 'aliases', 'seed', 'origin', 'last seen']}>
            {services.data.services.map((service) => (
              <RowButton key={service.id} label={service.id} selected={service.id === open} onOpen={() => setOpen(service.id)}>
                <Cell mono>{service.id}</Cell>
                <Cell mono>{service.provider}</Cell>
                {/* Other hostnames routed here. Shown next to the provider because they share
                    it: an alias is the same mock and the same corpus under another name. */}
                <Cell mono>{service.aliases.length ? service.aliases.join(', ') : <Muted>—</Muted>}</Cell>
                <Cell mono>{service.seed ?? '—'}</Cell>
                <Cell>{service.discovered ? <Badge tone="warn">from traffic</Badge> : <Badge>configured</Badge>}</Cell>
                <Cell>
                  <Muted>{service.lastSeenAt ? new Date(service.lastSeenAt).toLocaleString() : '—'}</Muted>
                </Cell>
              </RowButton>
            ))}
          </Table>
        )}
      </Card>

      <Drawer
        open={active !== undefined}
        onClose={() => setOpen(null)}
        title={active ? <span className="font-mono">{active.id}</span> : ''}
        action={
          active ? <Badge tone={active.discovered ? 'warn' : 'plain'}>{active.discovered ? 'from traffic' : 'configured'}</Badge> : null
        }
      >
        {active && (
          <ServiceDetail
            service={active}
            pending={set.isPending}
            error={set.error}
            onProvider={(provider) => set.mutate({ id: active.id, provider })}
          />
        )}
      </Drawer>
    </>
  );
}

function ServiceDetail({
  service,
  pending,
  error,
  onProvider,
}: {
  service: Service;
  pending: boolean;
  error: unknown;
  onProvider: (provider: (typeof CHOICES)[number]) => void;
}) {
  // A generated or emulator provider carries a target after the colon, so it is not one of a
  // fixed set of choices — those are set from the CLI or mocktown.json, and offering a dial
  // that could only ever overwrite them with `record` would be a trap.
  const fixed = service.provider.includes(':');

  return (
    <div className="space-y-3">
      {fixed ? (
        <p>
          <Muted>
            Served by <span className="font-mono text-ink">{service.provider}</span>, which names its own target — set that from
            mocktown.json or the CLI, not from here.
          </Muted>
        </p>
      ) : (
        <Dials>
          <Choice
            label="provider"
            value={service.provider}
            options={CHOICES.map((choice) => ({ value: choice, label: choice }))}
            onChange={(next) => {
              const provider = CHOICES.find((choice) => choice === next);
              if (provider && !pending) onProvider(provider);
            }}
          />
        </Dials>
      )}

      {error ? <Failure error={error} /> : null}

      <dl className="grid grid-cols-[7rem_1fr] gap-y-1">
        <dt>
          <Muted>aliases</Muted>
        </dt>
        <dd>
          {service.aliases.length ? (
            <ul className="font-mono">
              {service.aliases.map((alias) => (
                <li key={alias}>{alias}</li>
              ))}
            </ul>
          ) : (
            <Muted>none — nothing else is routed here</Muted>
          )}
        </dd>
        <dt>
          <Muted>seed</Muted>
        </dt>
        <dd className="font-mono">{service.seed ?? '—'}</dd>
        <dt>
          <Muted>last seen</Muted>
        </dt>
        <dd>{service.lastSeenAt ? new Date(service.lastSeenAt).toLocaleString() : <Muted>never</Muted>}</dd>
      </dl>

      <Muted>
        `record` captures and forwards, `deny` refuses loudly, and `passthrough` reaches the real service — the only mode on this screen
        that leaves the machine.
      </Muted>
    </div>
  );
}
