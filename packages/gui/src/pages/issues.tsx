/**
 * The issue queue, which is the agent loop's work list (07-issues-agent-loop.md). An issue
 * is meant to be self-contained, so the detail view shows the whole payload — the request,
 * the diagnosis and the links — rather than a summary of it.
 */
import { useState } from 'react';
import { useIssues } from '../hooks.ts';
import { Badge, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

const STATUSES = ['open', 'verifying', 'reopened', 'resolved'] as const;

export function Issues({ project }: { project: string }) {
  const [status, setStatus] = useState<(typeof STATUSES)[number] | undefined>('open');
  const [open, setOpen] = useState<string | null>(null);
  const issues = useIssues(project, status);

  return (
    <div className="space-y-3">
      <Card
        title="Issues"
        action={
          <select
            className="rounded border border-line bg-raised px-1 py-0.5"
            value={status ?? ''}
            onChange={(event) => setStatus((event.target.value || undefined) as (typeof STATUSES)[number] | undefined)}
          >
            <option value="">every status</option>
            {STATUSES.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
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
              <tr key={issue.id} className="cursor-pointer hover:bg-line/30" onClick={() => setOpen(open === issue.id ? null : issue.id)}>
                <Cell>{open === issue.id ? '▾' : '▸'}</Cell>
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
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {open && issues.data && <IssueDetail issue={issues.data.issues.find((entry) => entry.id === open)} />}
    </div>
  );
}

function IssueDetail({ issue }: { issue: ReturnType<typeof useIssues>['data'] extends undefined ? never : any }) {
  if (!issue) return null;
  return (
    <Card title={`${issue.id} — ${issue.type}`}>
      <div className="space-y-3">
        {issue.suggestedResolution && <p>{issue.suggestedResolution}</p>}
        {issue.links.length > 0 && (
          <div>
            <Muted>links</Muted>
            <ul className="ml-4 font-mono">
              {issue.links.map((link: string) => (
                <li key={link}>{link}</li>
              ))}
            </ul>
          </div>
        )}
        <div>
          <Muted>diagnosis</Muted>
          <pre className="mt-1 overflow-x-auto rounded bg-line/30 p-2 font-mono">{JSON.stringify(issue.diagnosis, null, 2)}</pre>
        </div>
        <div>
          <Muted>request (scrubbed)</Muted>
          <pre className="mt-1 overflow-x-auto rounded bg-line/30 p-2 font-mono">{JSON.stringify(issue.request, null, 2)}</pre>
        </div>
        <Muted>
          Resolve it from the agent loop — `mocktown issues resolve --id {issue.id}` replays the trigger before closing, and the GUI does
          not get a shortcut past that.
        </Muted>
      </div>
    </Card>
  );
}
