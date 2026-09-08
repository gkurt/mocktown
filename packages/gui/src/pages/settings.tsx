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
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api.ts';
import { useConfig, useKnobs, useStatus } from '../hooks.ts';
import { Badge, Card, Cell, Empty, Failure, Muted, Pending, Table } from '../ui.tsx';

type Setting = Awaited<ReturnType<typeof api.config.get>>['settings'][number];

const input = 'rounded border border-line bg-raised px-1 py-0.5 font-mono disabled:opacity-50';

/**
 * Values travel as JSON text end to end. Parsing them into form state and back would mean
 * two representations to keep honest, and the moment they disagree the form silently writes
 * something the user did not type — so the text is the state, and only the widget changes.
 */
function Field({ setting, disabled, onCommit }: { setting: Setting; disabled: boolean; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? setting.value;

  if (setting.type === 'boolean') {
    return (
      <input
        type="checkbox"
        className="size-4 accent-good"
        checked={setting.value === 'true'}
        disabled={disabled}
        onChange={(event) => onCommit(String(event.target.checked))}
      />
    );
  }

  if (setting.choices.length) {
    return (
      <select
        className={input}
        value={JSON.parse(setting.value) ?? ''}
        disabled={disabled}
        onChange={(e) => onCommit(JSON.stringify(e.target.value))}
      >
        {setting.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  }

  // Enter commits and blur does not: a list of hostnames is easy to half-type, and losing
  // focus should not be what decides a value is finished.
  return (
    <input
      className={`${input} w-full`}
      value={text}
      disabled={disabled}
      spellCheck={false}
      onChange={(event) => setDraft(event.target.value)}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setDraft(null);
        if (event.key !== 'Enter') return;
        onCommit(text);
        setDraft(null);
      }}
    />
  );
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
  const changed = data.settings.filter((s) => s.value !== s.default).length;

  return (
    <Card title="Project settings" action={<Badge tone={changed ? 'good' : 'plain'}>{changed} changed</Badge>}>
      {data.file ? (
        <p className="mb-2">
          <Muted>
            Committed to <code className="font-mono">{data.file}</code>. A text field commits on Enter; Escape reverts it.
          </Muted>
        </p>
      ) : (
        <Empty>This project has no workspace, so there is no mocktown.json to edit. Run `mocktown init` in the repo first.</Empty>
      )}

      <Table head={['setting', 'value', 'default', 'what it does']}>
        {data.settings.map((setting) => (
          <tr key={setting.key}>
            <Cell mono className="whitespace-nowrap align-top">
              {setting.value === setting.default ? setting.key : <strong className="font-medium">{setting.key}</strong>}
            </Cell>
            {/* The widest column by design: `capture.ignore` is a long array of hostnames and
                editing one through a keyhole is how the wrong entry gets deleted. */}
            <Cell className="w-2/5 align-top">
              <Field
                setting={setting}
                disabled={set.isPending || !data.file}
                onCommit={(value) => set.mutate({ key: setting.key, value })}
              />
            </Cell>
            <Cell mono className="align-top">
              <Muted>{setting.value === setting.default ? '—' : setting.default}</Muted>
            </Cell>
            <Cell className="align-top">{setting.description || <Muted>—</Muted>}</Cell>
          </tr>
        ))}
      </Table>

      {set.error && (
        <div className="mt-2">
          <Failure error={set.error} />
        </div>
      )}
    </Card>
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
      <Table head={['knob', 'value', 'default', 'what it does']}>
        {knobs.data.knobs.map((knob) => {
          const type = (knob.jsonSchema as { type?: string } | null)?.type;
          const json = JSON.stringify(knob.value);
          return (
            <tr key={knob.key}>
              <Cell mono className="whitespace-nowrap align-top">
                {knob.key}
              </Cell>
              <Cell className="align-top">
                {type === 'boolean' ? (
                  <input
                    type="checkbox"
                    className="size-4 accent-good"
                    checked={knob.value === true}
                    disabled={set.isPending}
                    onChange={(event) => set.mutate({ [knob.key]: event.target.checked })}
                  />
                ) : (
                  <input
                    className={`${input} w-40`}
                    defaultValue={type === 'string' ? String(knob.value ?? '') : json}
                    disabled={set.isPending}
                    spellCheck={false}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      const raw = (event.target as HTMLInputElement).value;
                      set.mutate({ [knob.key]: type === 'string' ? raw : JSON.parse(raw) });
                    }}
                  />
                )}
              </Cell>
              <Cell mono className="align-top">
                <Muted>{JSON.stringify(knob.default)}</Muted>
              </Cell>
              <Cell className="align-top">{knob.description || <Muted>—</Muted>}</Cell>
            </tr>
          );
        })}
      </Table>
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
  const generated = (status.data?.providers ?? []).filter((p) => p.kind === 'generated').flatMap((p) => p.services);

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
