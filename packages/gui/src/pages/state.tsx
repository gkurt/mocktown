/**
 * State introspection across every provider (06-emulation.md), and the reset that puts it
 * back. A provider that cannot report its state is listed with the reason rather than
 * omitted: a missing row would read as "this service has no state", which is a different
 * and wrong claim.
 *
 * The reset is not confirmed. 12-scenario-controls.md designed it to be cheap enough to run
 * between test cases, so a guard would put friction on the fast path it exists for — and
 * unlike a delete, it has a defined result rather than a lost one: seeds re-apply, and what
 * happened before stays in the corpus under the session it closed. What the page owes the
 * reader instead is the *consequence*, which is why the new session id and any provider
 * that had to restart are reported rather than the screen just refreshing.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api.ts';
import { useState_ } from '../hooks.ts';
import { Badge, Button, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

export function State({ project }: { project: string }) {
  const state = useState_(project);
  const queries = useQueryClient();
  const reset = useMutation({
    mutationFn: (service?: string) => api.state.reset({ project, service }),
    onSuccess: () => queries.invalidateQueries(),
  });

  if (state.error) return <Failure error={state.error} />;
  if (!state.data) return <Pending what="provider state" />;
  if (!state.data.services.length) {
    return (
      <Card title="State">
        <Empty>Nothing is serving, so there is no state to look at.</Empty>
      </Card>
    );
  }

  const resettable = state.data.services.filter((service) => service.provider !== null);

  return (
    <div className="flex flex-col gap-3">
      <Card
        title="Reset"
        action={
          <Button onClick={() => reset.mutate(undefined)} disabled={reset.isPending || resettable.length === 0}>
            {reset.isPending ? 'resetting…' : 'reset everything'}
          </Button>
        }
      >
        <p>
          <Muted>
            Drops whatever the app under test has written and re-applies each provider's seed. The recording session closes and a new one
            opens, so the corpus can still answer "what happened after the reset". Recordings, issues and generated mocks are untouched.
          </Muted>
        </p>
        {reset.error && (
          <div className="mt-2">
            <Failure error={reset.error} />
          </div>
        )}
        {reset.data && (
          <p className="mt-2">
            <Muted>
              Reset {reset.data.reset.length ? reset.data.reset.join(', ') : 'nothing that was running'} — now on session{' '}
              <span className="font-mono">{reset.data.session}</span>.
              {/* An emulator resets by restarting its process, which costs seconds. Saying so
                  is the difference between a slow page and an apparently broken one. */}
              {reset.data.restarted.length ? ` Restarted ${reset.data.restarted.join(', ')}, which takes a few seconds each.` : ''}
            </Muted>
          </p>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        {state.data.services.map((service) => (
          <Card
            key={service.service}
            title={service.service}
            action={
              <span className="flex items-center gap-2">
                <Badge tone={service.introspectable ? 'good' : 'plain'}>{service.provider ?? 'not served'}</Badge>
                {service.provider && (
                  <Button onClick={() => reset.mutate(service.service)} disabled={reset.isPending}>
                    reset
                  </Button>
                )}
              </span>
            }
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
    </div>
  );
}
