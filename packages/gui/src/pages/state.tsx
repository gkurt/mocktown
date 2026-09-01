/**
 * State introspection across every provider (06-emulation.md). A provider that cannot
 * report its state is listed with the reason rather than omitted: a missing row would read
 * as "this service has no state", which is a different and wrong claim.
 */
import { useState_ } from '../hooks.ts';
import { Badge, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

export function State({ project }: { project: string }) {
  const state = useState_(project);

  if (state.error) return <Failure error={state.error} />;
  if (!state.data) return <Pending what="provider state" />;
  if (!state.data.services.length) {
    return (
      <Card title="State">
        <Empty>Nothing is serving, so there is no state to look at.</Empty>
      </Card>
    );
  }

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      {state.data.services.map((service) => (
        <Card
          key={service.service}
          title={service.service}
          action={<Badge tone={service.introspectable ? 'good' : 'plain'}>{service.provider ?? 'not served'}</Badge>}
        >
          {!service.introspectable ? (
            <Muted>{service.note ?? 'This provider cannot report its state.'}</Muted>
          ) : service.collections.length === 0 ? (
            <Empty>No collections yet.</Empty>
          ) : (
            <Table head={['collection', 'items']}>
              {service.collections.map((collection) => (
                <tr key={collection.name}>
                  <Cell mono>{collection.name}</Cell>
                  <Cell className="tabular-nums">{collection.count}</Cell>
                </tr>
              ))}
            </Table>
          )}
        </Card>
      ))}
    </div>
  );
}
