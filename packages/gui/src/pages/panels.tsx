/**
 * The panels view: list them, iframe them (09-gui-plugins.md). The shell knows nothing
 * about what a panel does — it hands over a frame and the project, and the panel talks to
 * the same API as everyone else.
 *
 * The frame is sandboxed and the daemon serves panel documents under a CSP that has no
 * external origins in it, so a panel cannot take scrubbed traffic off this machine. It runs
 * with `allow-same-origin` because it needs the API, which also means the sandbox attribute
 * is not the boundary here — the CSP is (gui/serve.ts).
 *
 * The scheme goes in the query string beside the project, because `color-scheme` does not
 * cross a frame boundary: an iframe inherits it as a property but the embedded document
 * still resolves `prefers-color-scheme` against the OS, so a shell pinned to dark was
 * framing a white panel. Reaching into the frame's document to fix that would be the shell
 * knowing something about what a panel is; a query parameter is the convention panels
 * already read the project from.
 */
import { useState } from 'react';
import { usePanels } from '../hooks.ts';
import { useScheme } from '../theme.ts';
import { Badge, Card, Empty, Failure, Muted, Path, Pending } from '../ui.tsx';

export function Panels({ project }: { project: string }) {
  const panels = usePanels(project);
  const scheme = useScheme();
  const [open, setOpen] = useState<string | null>(null);

  if (panels.error) return <Failure error={panels.error} />;
  if (!panels.data) return <Pending what="panels" />;

  const active = panels.data.panels.find((panel) => panel.url === open) ?? panels.data.panels[0];

  return (
    <div className="space-y-3">
      <Card title="Panels" action={<Muted>{panels.data.dir ? <Path>{panels.data.dir}</Path> : 'this project has no workspace'}</Muted>}>
        {panels.data.panels.length === 0 ? (
          <Empty>No panels. Drop an HTML file and a manifest into `.mocktown/panels/`.</Empty>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {panels.data.panels.map((panel) => (
              <li key={panel.url}>
                <button
                  type="button"
                  onClick={() => setOpen(panel.url)}
                  className={`rounded border px-2 py-1 ${panel.url === active?.url ? 'border-ink' : 'border-line hover:bg-line/40'}`}
                >
                  {panel.name} <Badge>{panel.source}</Badge>
                </button>
              </li>
            ))}
          </ul>
        )}
        {panels.data.problems.map((problem) => (
          <p key={problem} className="mt-2 text-warn">
            ! {problem}
          </p>
        ))}
      </Card>

      {active && (
        <Card
          title={active.name}
          action={
            <Muted>
              <Path>{active.file}</Path>
            </Muted>
          }
        >
          <iframe
            key={active.url}
            title={active.name}
            src={`${active.url}?project=${encodeURIComponent(project)}&scheme=${scheme}`}
            sandbox="allow-scripts allow-same-origin"
            className="h-[70vh] w-full rounded border border-line bg-raised"
          />
        </Card>
      )}
    </div>
  );
}
