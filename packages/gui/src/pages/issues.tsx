/**
 * The issue queue, which is the agent loop's work list (07-issues-agent-loop.md). An issue
 * is meant to be self-contained, so the detail view shows the whole payload — the request,
 * the diagnosis and the links — rather than a summary of it.
 *
 * That payload is also why the detail is a drawer rather than an expanded row: a diagnosis
 * is a few dozen lines of JSON, and unfolding it under the row pushed the row that opened it
 * off the screen and moved every other row under the cursor. The queue stays put now, and
 * clicking down it compares issues instead of relayouting the page around each one.
 */
import { useState } from 'react';
import { Choice, Dials } from '../dials.tsx';
import { useIssues } from '../hooks.ts';
import { Badge, Card, Cell, Drawer, Empty, Failure, Muted, Path, Pending, RowButton, Table } from '../ui.tsx';

/**
 * `outstanding` leads and is the default: it is open-or-reopened, and picking `open`
 * instead hides the issues whose fix just failed verification — the ones a reader opening
 * this page is most likely looking for.
 */
const STATUSES = ['outstanding', 'open', 'verifying', 'reopened', 'resolved'] as const;

type Issue = NonNullable<ReturnType<typeof useIssues>['data']>['issues'][number];

export function Issues({ project }: { project: string }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number] | undefined>('outstanding');
  const [open, setOpen] = useState<string | null>(null);
  const issues = useIssues(project, status);

  // Looked up rather than stashed on click, so the drawer follows the four-second poll: an
  // issue that gets resolved or re-opened while it is being read says so.
  const active = issues.data?.issues.find((issue) => issue.id === open);

  return (
    <>
      <Card
        title="Issues"
        action={
          <Dials row>
            <Choice
              label="status"
              value={status ?? ''}
              options={[{ value: '', label: 'every status' }, ...STATUSES.map((status) => ({ value: status, label: status }))]}
              onChange={(next) => setStatus(STATUSES.find((option) => option === next))}
            />
          </Dials>
        }
      >
        {issues.error ? (
          <Failure error={issues.error} />
        ) : !issues.data ? (
          <Pending what="issues" />
        ) : issues.data.issues.length === 0 ? (
          <Empty>Nothing here. Every request the app made could be served.</Empty>
        ) : (
          <Table head={['', 'type', 'service', 'request', 'seen', 'updated']}>
            {issues.data.issues.map((issue) => (
              <RowButton key={issue.id} label={issue.id} selected={issue.id === open} onOpen={() => setOpen(issue.id)}>
                <Cell>
                  <Badge tone={issue.status === 'open' ? 'warn' : issue.status === 'resolved' ? 'good' : 'plain'}>{issue.type}</Badge>
                </Cell>
                <Cell mono>{issue.service}</Cell>
                <Cell mono>
                  {issue.method ?? ''} {issue.pathTemplate ?? issue.path ?? ''}
                </Cell>
                <Cell>{issue.occurrences}</Cell>
                <Cell>
                  <Muted>{new Date(issue.updatedAt).toLocaleString()}</Muted>
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
        action={active ? <Badge tone={active.status === 'resolved' ? 'good' : 'warn'}>{active.status}</Badge> : null}
      >
        {active && <IssueDetail issue={active} />}
      </Drawer>
    </>
  );
}

function IssueDetail({ issue }: { issue: Issue }) {
  return (
    <div className="space-y-3">
      <p>
        <Badge tone="warn">{issue.type}</Badge> <span className="font-mono">{issue.service}</span>{' '}
        <Muted>
          {issue.method ?? ''} {issue.pathTemplate ?? issue.path ?? ''}
        </Muted>
      </p>
      {issue.suggestedResolution && <p>{issue.suggestedResolution}</p>}
      {issue.links.length > 0 && (
        <div>
          <Muted>links</Muted>
          <ul className="ml-4">
            {issue.links.map((link) => (
              <li key={link}>
                <Path>{link}</Path>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <Muted>diagnosis</Muted>
        <pre className="mt-1 scrollable scrollable-transition scroll-fade-inline rounded bg-line/30 p-2 font-mono">
          {JSON.stringify(issue.diagnosis, null, 2)}
        </pre>
      </div>
      <div>
        <Muted>request (scrubbed)</Muted>
        <pre className="mt-1 scrollable scrollable-transition scroll-fade-inline rounded bg-line/30 p-2 font-mono">
          {JSON.stringify(issue.request, null, 2)}
        </pre>
      </div>
      <Muted>
        Resolve it from the agent loop — `mocktown issues resolve --id {issue.id}` replays the trigger before closing, and the GUI does not
        get a shortcut past that.
      </Muted>
    </div>
  );
}
