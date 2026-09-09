/**
 * Everything this project can be told to do differently, in one place.
 *
 * Two things share the screen because they are the same question asked at two lifetimes.
 * `mocktown.json` settings are decisions that get committed — they travel with the repo and
 * survive the machine. Scenario knobs are dials on a running mock: they live in SQLite, take
 * effect immediately, and 12-scenario-controls.md always intended the GUI to render their
 * forms from the manifest. Neither had a surface here, so both were CLI-only or, for the
 * settings, editor-only.
 *
 * The settings list is not written out here. It comes from the same Zod schema that defines
 * `mocktown.json`, so a knob added to the schema appears on this screen with its description
 * and its default and no edit to this file.
 *
 * This is the page that made the shell adopt DialKit (dials.tsx). Both halves used to be
 * four-column tables with an input wedged into the second column, which is the wrong shape
 * twice over: a knob declaring `minimum` and `maximum` is a slider and was rendered as a box
 * to type JSON into, and the description — the only thing that says what a knob *does* —
 * was competing for width with the value it describes. A control row with its explanation
 * underneath is a form, which is what this always was.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { Choice, Dials, Range, Switch, TextDial } from '../dials.tsx';
import { useConfig, useKnobs, useStatus } from '../hooks.ts';
import { Badge, Card, Empty, Failure, Muted, Path, Pending } from '../ui.tsx';

type Setting = Awaited<ReturnType<typeof api.config.get>>['settings'][number];
type Knob = Awaited<ReturnType<typeof api.knobs.get>>['knobs'][number];

/** The slice of JSON Schema a knob's manifest can offer that changes which control it gets. */
type Shape = { type?: string; enum?: unknown[]; minimum?: number; maximum?: number; multipleOf?: number } | null;

/** A control and the line of prose that explains it. */
const Dial = ({ children, note }: { children: React.ReactNode; note: React.ReactNode }) => (
  <div>
    {children}
    <p className="mt-0.5 px-3 text-muted">{note}</p>
  </div>
);

/**
 * Values travel as JSON text end to end. Parsing them into form state and back would mean
 * two representations to keep honest, and the moment they disagree the form silently writes
 * something the user did not type — so the text is the state, and only the widget changes.
 */
function SettingDial({ setting, onCommit }: { setting: Setting; onCommit: (value: string) => void }) {
  if (setting.type === 'boolean') {
    return <Switch label={setting.key} checked={setting.value === 'true'} onChange={(checked) => onCommit(String(checked))} />;
  }

  if (setting.choices.length) {
    return (
      <Choice
        label={setting.key}
        value={JSON.parse(setting.value) ?? ''}
        options={setting.choices.map((choice) => ({ value: choice, label: choice }))}
        onChange={(next) => onCommit(JSON.stringify(next))}
      />
    );
  }

  return <TextDial label={setting.key} value={setting.value} onCommit={onCommit} />;
}

function ProjectSettings({ project }: { project: string }) {
  const config = useConfig(project);
  const queries = useQueryClient();
  const set = useMutation({
    mutationFn: (input: { key: string; value: string }) => api.config.set({ project, ...input }),
    onSuccess: () => queries.invalidateQueries(),
  });

  if (config.error) return <Failure error={config.error} />;
  if (!config.data) return <Pending what="the settings" />;

  const data = config.data;
  const changed = data.settings.filter((setting) => setting.value !== setting.default).length;

  return (
    <Card title="Project settings" action={<Badge tone={changed ? 'good' : 'plain'}>{changed} changed</Badge>}>
      {!data.file ? (
        <Empty>This project has no workspace, so there is no mocktown.json to edit. Run `mocktown init` in the repo first.</Empty>
      ) : (
        <>
          <p className="mb-2">
            <Muted>
              Committed to <Path>{data.file}</Path>. A text field commits on Enter; Escape reverts it.
            </Muted>
          </p>
          {/* Gated while a write is in flight, because each of these edits a committed file.
              Safe to do with pointer events here and not on the knobs below: nothing on this
              half is a slider, so there is no drag for a mid-gesture gate to cut short. */}
          <Dials className={set.isPending ? 'pointer-events-none opacity-60' : ''}>
            {data.settings.map((setting) => (
              <Dial
                key={setting.key}
                note={
                  <>
                    {setting.value === setting.default ? null : (
                      <>
                        <span className="text-good">changed</span> · default <span className="font-mono">{setting.default}</span> ·{' '}
                      </>
                    )}
                    {setting.description || '—'}
                  </>
                }
              >
                <SettingDial setting={setting} onCommit={(value) => set.mutate({ key: setting.key, value })} />
              </Dial>
            ))}
          </Dials>
        </>
      )}

      {set.error && (
        <div className="mt-2">
          <Failure error={set.error} />
        </div>
      )}
    </Card>
  );
}

/**
 * One knob, as whatever control its manifest describes.
 *
 * A bounded number is the case worth having DialKit for: `latency.ms: 0–2000` is a thing you
 * sweep to find where the app breaks, and typing 250 then 500 then 750 into a text box is
 * not sweeping. Everything unbounded or structured stays text, because a slider with no
 * ends is a worse text box.
 */
function KnobDial({ knob, onCommit }: { knob: Knob; onCommit: (value: unknown) => void }) {
  const shape = knob.jsonSchema as Shape;
  const type = shape?.type;

  if (type === 'boolean') return <Switch label={knob.key} checked={knob.value === true} onChange={onCommit} />;

  if ((type === 'number' || type === 'integer') && shape?.minimum !== undefined && shape.maximum !== undefined) {
    return (
      <Range
        label={knob.key}
        value={typeof knob.value === 'number' ? knob.value : Number(knob.default ?? shape.minimum)}
        min={shape.minimum}
        max={shape.maximum}
        step={shape.multipleOf ?? (type === 'integer' ? 1 : undefined)}
        onCommit={onCommit}
      />
    );
  }

  // `z.enum([…])` reaches here as a string with an `enum` list, which is a set of choices
  // rather than something to type — and typing one of two words correctly is the reader's
  // problem to have, not the form's to create.
  if (Array.isArray(shape?.enum)) {
    const options = shape.enum.map((option) => ({ value: String(option), label: String(option) }));
    return <Choice label={knob.key} value={String(knob.value ?? '')} options={options} onChange={onCommit} />;
  }

  if (type === 'string') return <TextDial label={knob.key} value={String(knob.value ?? '')} onCommit={onCommit} />;

  // Anything else — an object, an array, an unbounded number — is edited as the JSON it is.
  return <JsonDial knob={knob} onCommit={onCommit} />;
}

/**
 * A knob with no simpler shape, edited as JSON text. The parse failure is shown rather than
 * swallowed: a missing bracket is the reader's typo, and a control that quietly declines to
 * commit looks like a broken form.
 */
function JsonDial({ knob, onCommit }: { knob: Knob; onCommit: (value: unknown) => void }) {
  const [invalid, setInvalid] = useState<string | null>(null);

  return (
    <>
      <TextDial
        label={knob.key}
        value={JSON.stringify(knob.value)}
        onCommit={(raw) => {
          try {
            const parsed = JSON.parse(raw);
            setInvalid(null);
            onCommit(parsed);
          } catch (failure) {
            setInvalid(failure instanceof Error ? failure.message : String(failure));
          }
        }}
      />
      {invalid && <p className="mt-0.5 px-3 text-bad">{invalid}</p>}
    </>
  );
}

function ServiceKnobs({ project, service }: { project: string; service: string }) {
  const knobs = useKnobs(project, service);
  const queries = useQueryClient();
  const set = useMutation({
    mutationFn: (values: Record<string, unknown>) => api.knobs.set({ project, service, values }),
    onSuccess: () => queries.invalidateQueries(),
  });

  // A mock that declares no knobs is the common case, and a card saying so for every service
  // would bury the ones that do.
  if (!knobs.data?.knobs.length) return null;

  return (
    <Card title={service} action={<Badge>{knobs.data.knobs.length} knobs</Badge>}>
      <Dials>
        {knobs.data.knobs.map((knob) => (
          <Dial
            key={knob.key}
            note={
              <>
                default <span className="font-mono">{JSON.stringify(knob.default)}</span> · {knob.description || '—'}
              </>
            }
          >
            <KnobDial knob={knob} onCommit={(value) => set.mutate({ [knob.key]: value })} />
          </Dial>
        ))}
      </Dials>
      <p className="mt-2">
        <Muted>
          Values are project state, not config: they take effect at once and every change is journaled, so a run stays replayable.
        </Muted>
      </p>
      {set.error && (
        <div className="mt-2">
          <Failure error={set.error} />
        </div>
      )}
    </Card>
  );
}

export function Settings({ project }: { project: string }) {
  const status = useStatus(project);
  // The provider is asked what it loaded, not the registry what it was told. A module in
  // `mocks/` is served whether or not the registry entry says `generated:`, and reading the
  // registry here hid every knob on a project whose services are still marked `record`.
  const generated = (status.data?.providers ?? []).filter((provider) => provider.kind === 'generated').flatMap((p) => p.services);

  return (
    <div className="flex flex-col gap-4">
      <ProjectSettings project={project} />
      {generated.map((service) => (
        <ServiceKnobs key={service} project={project} service={service} />
      ))}
      <Card title="Scenario knobs">
        <Muted>
          {generated.length === 0
            ? 'No generated mock is loaded, so nothing declares knobs yet. A mock declares them in its module and they appear here on their own.'
            : `${generated.length} generated mock${generated.length === 1 ? '' : 's'} loaded. One with no knobs of its own is not listed above — declaring one in the mock module is all it takes to get a control here.`}
        </Muted>
      </Card>
    </div>
  );
}
