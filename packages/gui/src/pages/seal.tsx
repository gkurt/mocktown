/**
 * Seal and sandbox, side by side, because the seal's worth depends on the instrument that
 * produced it: a run with `instrument: none` proved nothing (05-redirection.md), and the
 * sandbox is what makes an escape visible rather than merely absent.
 *
 * Neither is startable from here. Bringing up containers and running the flow list is a
 * decision with a cost, and the CLI is where that decision is made.
 */
import { useDrift, useSandbox, useSeal } from '../hooks.ts';
import { Badge, Card, Empty, Failure, Muted, Ok, Pending } from '../ui.tsx';

export function Seal({ project }: { project: string }) {
  const seal = useSeal(project);
  const sandbox = useSandbox(project);
  const drift = useDrift(project);

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card title="Seal">
        {seal.error ? (
          <Failure error={seal.error} />
        ) : !seal.data ? (
          <Pending what="the seal" />
        ) : (
          <div className="space-y-2">
            <div>
              <Ok ok={seal.data.ok}>{seal.data.ok ? 'sealed' : 'not sealed'}</Ok>
            </div>
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
              <dt>
                <Muted>commit</Muted>
              </dt>
              <dd className="font-mono">{seal.data.commit ?? '—'}</dd>
              <dt>
                <Muted>config hash</Muted>
              </dt>
              <dd className="font-mono">{seal.data.configHash.slice(0, 16)}</dd>
              <dt>
                <Muted>wall hits</Muted>
              </dt>
              <dd>{seal.data.stamp?.wallHits ?? '—'}</dd>
              <dt>
                <Muted>flows</Muted>
              </dt>
              <dd className="font-mono">{seal.data.flows.join(', ') || '—'}</dd>
            </dl>
            {seal.data.stale.map((reason) => (
              <p key={reason} className="text-warn">
                {reason}
              </p>
            ))}
            <Muted>`mocktown seal verify --json` is the CI step; it exits non-zero for anything but sealed.</Muted>
          </div>
        )}
      </Card>

      <Card title="Sandbox">
        {sandbox.error ? (
          <Failure error={sandbox.error} />
        ) : !sandbox.data ? (
          <Pending what="the sandbox" />
        ) : (
          <div className="space-y-2">
            <div>
              <Badge tone={sandbox.data.running ? 'good' : 'plain'}>{sandbox.data.running ? 'up' : 'down'}</Badge>{' '}
              <Muted>
                {sandbox.data.engine} · {sandbox.data.mode}
              </Muted>
            </div>
            <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
              <dt>
                <Muted>app container</Muted>
              </dt>
              <dd className="font-mono">{sandbox.data.container ?? '—'}</dd>
              <dt>
                <Muted>network</Muted>
              </dt>
              <dd className="font-mono">{sandbox.data.network ?? '—'}</dd>
              <dt>
                <Muted>relay</Muted>
              </dt>
              <dd className="font-mono">
                {sandbox.data.relayIp ?? '—'}
                {sandbox.data.frontDoorPort ? ` → :${sandbox.data.frontDoorPort}` : ''}
              </dd>
              <dt>
                <Muted>image</Muted>
              </dt>
              <dd className="font-mono">{sandbox.data.image ?? '—'}</dd>
              <dt>
                <Muted>browser</Muted>
              </dt>
              <dd>{sandbox.data.browser ? 'headless Chromium in the image' : 'not shipped'}</dd>
            </dl>
            {sandbox.data.warnings.map((problem) => (
              <p key={problem} className="text-warn">
                ! {problem}
              </p>
            ))}
          </div>
        )}
      </Card>

      <Card title="Drift watch">
        {drift.error ? (
          <Failure error={drift.error} />
        ) : !drift.data ? (
          <Pending what="drift" />
        ) : (
          <div className="space-y-2">
            <div>
              <Badge tone={drift.data.enabled ? 'good' : 'plain'}>
                {drift.data.enabled ? `every ${drift.data.intervalHours}h` : 'off'}
              </Badge>{' '}
              {drift.data.nextRunAt && <Muted>next {new Date(drift.data.nextRunAt).toLocaleString()}</Muted>}
            </div>
            <Muted>A drift run re-records against the real services, so it is off until a project asks for it.</Muted>
            {drift.data.lastRun ? (
              <dl className="grid grid-cols-[9rem_1fr] gap-y-1">
                <dt>
                  <Muted>last run</Muted>
                </dt>
                <dd>{new Date(drift.data.lastRun.startedAt).toLocaleString()}</dd>
                <dt>
                  <Muted>checked</Muted>
                </dt>
                <dd>{drift.data.lastRun.checked}</dd>
                <dt>
                  <Muted>drifted</Muted>
                </dt>
                <dd>{drift.data.lastRun.drifted}</dd>
                <dt>
                  <Muted>open drift issues</Muted>
                </dt>
                <dd>{drift.data.openDriftIssues}</dd>
              </dl>
            ) : (
              <Empty>No run yet.</Empty>
            )}
            {drift.data.lastRun?.reasons.map((reason) => (
              <p key={reason} className="text-warn">
                {reason}
              </p>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
