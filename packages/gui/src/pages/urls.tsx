/**
 * Where everything is, on one screen. The addresses were always knowable — providers carry
 * their base URLs, portless carries the stable names, `env` carries the variables that
 * point an app at them — but they were spread across three commands and a generated file,
 * so the question "what URL do I open" had no answer in the GUI at all.
 *
 * The app's own URL is the one address mocktown cannot derive, because the app is the
 * developer's process. It comes from `app.url` in mocktown.json and is asked for here.
 */
import { useEnv, usePortless, useStatus } from '../hooks.ts';
import { Badge, Card, Cell, Copy, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

const Link = ({ href }: { href: string }) => (
  <a className="font-mono text-good underline underline-offset-2" href={href} target="_blank" rel="noreferrer">
    {href}
  </a>
);

export function Urls({ project }: { project: string }) {
  const status = useStatus(project);
  const portless = usePortless(project);
  const env = useEnv(project);

  if (status.error) return <Failure error={status.error} />;
  if (!status.data) return <Pending what="the addresses" />;

  const stable = new Map((portless.data?.names ?? []).map((entry) => [entry.service, entry.url]));
  const direct = new Map<string, string>();
  for (const provider of status.data.providers) for (const [service, url] of Object.entries(provider.baseUrls)) direct.set(service, url);

  const services = [...new Set([...direct.keys(), ...stable.keys()])].sort();
  // This screen answers "what address do I use", so it shows the variables that carry one.
  // The proxy and certificate settings matter just as much to a working run, but they are
  // not addresses and they crowd out the three lines someone came here to read.
  const variables = Object.entries(env.data?.variables ?? {}).filter(([, value]) => /^https?:\/\//.test(value));

  return (
    <div className="flex flex-col gap-4">
      <Card title="The app under test">
        {status.data.appUrl ? (
          <Link href={status.data.appUrl} />
        ) : (
          <Empty>
            Not set. Add <code className="font-mono">{'"app": { "url": "http://localhost:5173" }'}</code> to mocktown.json and this becomes
            a link — mocktown cannot guess it, because the app is your process, not one of ours.
          </Empty>
        )}
      </Card>

      <Card title="Mock addresses">
        {services.length === 0 ? (
          <Empty>Nothing is serving. `mocktown serve start` brings the providers up.</Empty>
        ) : (
          <Table head={['service', 'stable name', '', 'direct', '']}>
            {services.map((service) => (
              <tr key={service}>
                <Cell mono>{service}</Cell>
                <Cell>{stable.get(service) ? <Link href={stable.get(service)!} /> : <Muted>—</Muted>}</Cell>
                <Cell>{stable.get(service) ? <Copy value={stable.get(service)!} label="the stable name" /> : null}</Cell>
                <Cell>{direct.get(service) ? <Link href={direct.get(service)!} /> : <Muted>—</Muted>}</Cell>
                <Cell>{direct.get(service) ? <Copy value={direct.get(service)!} label="the direct address" /> : null}</Cell>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2">
          {/* One provider serves every generated mock on one port and tells them apart by Host,
              so the direct URL only works with the service in the Host header. */}
          <Muted>
            A direct address is one port shared by every generated mock, dispatched on the <code className="font-mono">Host</code> header —
            reaching one from a browser needs the stable name.{' '}
            {portless.data?.available ? null : `Stable names are off: ${portless.data?.reason ?? 'portless has not been synced'}.`}
          </Muted>
        </p>
      </Card>

      <Card title="What to give the app" action={<Badge tone={variables.length ? 'good' : 'plain'}>{variables.length} addresses</Badge>}>
        {variables.length === 0 ? (
          <Empty>No redirection variables yet.</Empty>
        ) : (
          <pre className="scrollable scrollable-transition scroll-fade-inline rounded border border-line bg-surface p-2 font-mono text-[12px] leading-5">
            {variables.map(([name, value]) => `${name}=${value}`).join('\n')}
          </pre>
        )}
        <p className="mt-2">
          <Muted>
            The variables that carry an address. `mocktown env write` puts these in <code className="font-mono">.env.mocktown</code>, along
            with the proxy and certificate settings a run also needs.
          </Muted>
        </p>
      </Card>
    </div>
  );
}
