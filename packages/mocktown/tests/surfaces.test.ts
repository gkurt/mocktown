/**
 * The surfaces around the loop: HAR import, `mocktown env`, issue files, and the
 * structural house rules the contract walk is supposed to enforce.
 *
 * The last group is the important one. Spike 02's argument for owning the walk was that
 * it makes house rules *structural* rather than per-command discipline — `--json` on
 * every command, `readOnlyHint` derived from the HTTP method, the project resolved by
 * the CLI. That argument is only true if something checks it, so this does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { oc } from '@orpc/contract';
import * as z from 'zod/v4';

const root = join(import.meta.dir, '.tmp-surfaces');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { schema } = await import('#src/db/client.ts');
const { parseHar } = await import('#src/capture/har.ts');
const { Recorder, startSession } = await import('#src/capture/recorder.ts');
const { generateEnv, renderAgentsSection, renderEnvFile, staleEnvVars } = await import('#src/env/generate.ts');
const { contract } = await import('#src/contract/index.ts');
const { walkContract, inputShape, describedAs, fieldInfo, contractSignature } = await import('#src/contract/walk.ts');
const { captureEnv } = await import('#src/capture/launch.ts');
const { RENDERERS } = await import('#src/cli/render.ts');
const { coerceInput } = await import('#src/cli/coerce.ts');
const { settingsOf, writeSetting } = await import('#src/config/settings.ts');
const { writeService } = await import('#src/config/services.ts');
const { projectFileJsonSchema, SCHEMA_REF } = await import('#src/config/jsonschema.ts');
const { ProjectFile } = await import('#src/config/schema.ts');
const { daemonStateFile, globalConfigDir, workspacePaths } = await import('#src/config/paths.ts');
const { daemonLiveness, readDaemonState } = await import('#src/config/daemon.ts');
const { findFreePort } = await import('#src/util/ports.ts');

const workspace = join(root, 'app');
let runtime: InstanceType<typeof ProjectRuntime>;

beforeAll(() => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'mocktown.json'), JSON.stringify({ project: 'surfaces-test', services: {} }));
  runtime = new ProjectRuntime(resolveProject({ cwd: workspace }));
  runtime.ensureDirs();
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('HAR import', () => {
  const har = JSON.stringify({
    log: {
      entries: [
        {
          time: 42,
          request: {
            method: 'GET',
            url: 'https://api.example.test/v1/orders/8812?expand=customer',
            headers: [
              { name: 'Authorization', value: 'Bearer ghp_R3alL00k1ngPersonalAccessToken0123456789' },
              { name: ':authority', value: 'api.example.test' },
            ],
          },
          response: {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            content: { mimeType: 'application/json', text: '{"id":"8812","customer":"ada@example.com"}' },
          },
        },
        {
          request: { method: 'GET', url: 'ws://api.example.test/socket', headers: [] },
          response: { status: 101, headers: [], content: {} },
        },
      ],
    },
  });

  test('translates entries and reports what it could not use', () => {
    const { exchanges, skipped } = parseHar(har);
    expect(exchanges).toHaveLength(1);
    expect(exchanges[0]!.method).toBe('GET');
    // h2 pseudo-headers are transport framing, not headers.
    expect(exchanges[0]!.requestHeaders).not.toHaveProperty(':authority');
    // An import must never silently drop traffic.
    expect(skipped).toEqual([{ url: 'ws://api.example.test/socket', reason: 'not an HTTP(S) request' }]);
  });

  test('imported exchanges land in the same corpus, through the same scrubber', () => {
    const session = startSession(runtime.db, 'import', { label: 'har' });
    const recorder = new Recorder(runtime.db, runtime.name, runtime.currentScrubber, session);
    for (const exchange of parseHar(har).exchanges) recorder.record(exchange, 'har');

    const row = runtime.db.select().from(schema.recordings).all().at(-1)!;
    expect(row.source).toBe('har');
    expect(row.service).toBe('api.example.test');
    // Normalization applies identically to imported traffic.
    expect(row.pathTemplate).toBe('/v1/orders/{orderId}');
    expect(JSON.stringify(row.requestHeaders)).not.toContain('ghp_R3alL00k1ngPersonalAccessToken0123456789');
    expect(JSON.stringify(row.requestHeaders)).toContain('{{secret:github-token#');
    expect(row.responseBody).toContain('ada@example.com');
  });
});

describe('mocktown env', () => {
  const inputs = {
    project: 'surfaces-test',
    proxyUrl: 'http://127.0.0.1:4400',
    caCertPath: '/tmp/ca.pem',
    baseUrls: new Map([
      ['api.github.com', 'http://127.0.0.1:4601'],
      ['api.twilio.com', 'http://127.0.0.1:4602'],
    ]),
    ekb: [
      {
        id: '1',
        service: 'api.github.com',
        rung: 1,
        envVar: 'GITHUB_API_URL',
        language: null,
        snippet: null,
        note: null,
        source: 'emulate-skill',
      },
      {
        id: '2',
        service: 'api.twilio.com',
        rung: 3,
        envVar: null,
        language: null,
        snippet: null,
        note: 'no endpoint option',
        source: 'emulate-skill',
      },
    ],
    services: ['api.github.com', 'api.twilio.com', 'unknown.internal'],
  };

  test('covers what it can mechanically and is honest about the rest', () => {
    const artifacts = generateEnv(inputs);

    // Presence = emulated: one variable per service, no global mode flag.
    expect(artifacts.variables.GITHUB_API_URL).toBe('http://127.0.0.1:4601');
    // A rung-3 service gets no invented variable. Emitting one would let the seal pass
    // while the SDK talked to production.
    expect(Object.values(artifacts.variables)).not.toContain('http://127.0.0.1:4602');

    const twilio = artifacts.report.find((r) => r.service === 'api.twilio.com')!;
    expect(twilio.covered).toBe(false);
    expect(artifacts.agentTasks.some((t) => t.service === 'api.twilio.com')).toBe(true);

    // A service with no recipe at all is reported and becomes a task, not a silent gap.
    const unknown = artifacts.report.find((r) => r.service === 'unknown.internal')!;
    expect(unknown.covered).toBe(false);
    expect(unknown.rung).toBeNull();
  });

  test('the env file and the launch wrapper cannot drift', () => {
    // Both are rendered from `captureEnv`, so a knob added for one is added for both.
    const artifacts = generateEnv(inputs);
    for (const [key, value] of Object.entries(captureEnv({ proxyUrl: inputs.proxyUrl, caCertPath: inputs.caCertPath }))) {
      expect(artifacts.variables[key]).toBe(value);
    }
    expect(renderEnvFile('surfaces-test', artifacts.variables)).toContain('NODE_USE_ENV_PROXY=1');
  });

  test('the env file survives the paths macOS actually uses', () => {
    // The documented loader is `. ./.env.mocktown`; the default data dir sits under
    // "Application Support", so an unquoted value made the tail of the line a command.
    const caPath = "/Users/dev/Library/Application Support/mocktown/it's/ca.pem";
    mkdirSync(root, { recursive: true });
    const file = join(root, 'env-quoting.env');
    writeFileSync(file, renderEnvFile('surfaces-test', { MOCKTOWN_CA: caPath, PLAIN: 'http://127.0.0.1:4400' }));
    const shell = Bun.spawnSync(['sh', '-c', `set -a && . "$1" && set +a && printf '%s\\n%s' "$MOCKTOWN_CA" "$PLAIN"`, 'sh', file]);
    expect(shell.stderr.toString()).toBe('');
    expect(shell.stdout.toString()).toBe(`${caPath}\nhttp://127.0.0.1:4400`);
    // Quoting is reserved for values that need it, so the common line still reads as before.
    expect(renderEnvFile('surfaces-test', { PLAIN: 'http://127.0.0.1:4400' })).toContain('PLAIN=http://127.0.0.1:4400');
  });

  test('an env file that no longer matches is reported, and a deleted line is not', () => {
    const variables = { VITE_API_URL: 'http://api.proj.mocktown', MOCKTOWN_CA: '/Users/n o/ca.pem' };

    // The failure this exists for. `.env.mocktown` is a thing that remembers URLs, which is
    // what stable names were introduced to stop; change the TLDs and the file keeps the old
    // spelling, which still resolves, so nothing breaks and nobody finds out.
    const drifted = renderEnvFile('surfaces-test', { ...variables, VITE_API_URL: 'http://api.proj.localhost' });
    expect(staleEnvVars(drifted, variables)).toEqual(['VITE_API_URL']);

    // Anything this writer produces from the current values agrees with itself, quoting
    // included — comparing raw would flag every path containing a space, forever.
    expect(staleEnvVars(renderEnvFile('surfaces-test', variables), variables)).toEqual([]);

    // "Presence = emulated" is the file's own convention, so a line someone deleted is a
    // decision to send that dependency to the real service, not something to nag about.
    expect(staleEnvVars('VITE_API_URL=http://api.proj.mocktown', variables)).toEqual([]);
  });

  test('the AGENTS.md section pins the project rather than trusting the global default', () => {
    const artifacts = generateEnv(inputs);
    const section = renderAgentsSection('surfaces-test', artifacts.agentTasks, artifacts.report);
    // The kubectl current-context footgun: concurrent agents would cross-contaminate.
    expect(section).toContain('export MOCKTOWN_PROJECT=surfaces-test');
    expect(section).toContain('untrusted input');
  });
});

describe("mocktown.json's JSON Schema", () => {
  test('describes what someone writes, not what mocktown reads back', () => {
    const schema = projectFileJsonSchema() as { required?: string[]; properties: Record<string, unknown> };

    // The trap in generating this. Every field in `ProjectFile` has a default, so the
    // *output* view marks them all required — and an editor would then light up a valid,
    // minimal `{ "project": "x" }` with a wall of errors about keys nobody has to write.
    expect(schema.required).toEqual(['project']);

    // Every knob the settings screen offers has to be describable here too, or the two
    // surfaces disagree about what the file may contain.
    for (const key of ['services', 'portless', 'capture', 'env', 'app', 'scrub']) {
      expect(Object.keys(schema.properties)).toContain(key);
    }
  });

  test('every property carries the hover text an editor shows', () => {
    // The prose explaining these groups lives in JSDoc comments, which Zod cannot see — so
    // the richest text in the config schema reached nothing. `.describe()` is the only
    // channel to a hover, and `portless` in particular has to say what enabling it costs
    // before someone turns it on.
    const properties = (projectFileJsonSchema() as { properties: Record<string, { description?: string }> }).properties;
    const silent = Object.entries(properties)
      .filter(([, node]) => !node.description)
      .map(([key]) => key);
    expect(silent).toEqual([]);
  });

  test('allows the `$schema` line mocktown itself writes', () => {
    // Generated configs carry `$schema`. If the schema does not permit it, the first thing
    // an editor flags is the line that told it where to look.
    expect(Object.keys((projectFileJsonSchema() as { properties: Record<string, unknown> }).properties)).toContain('$schema');
    expect(ProjectFile.safeParse({ $schema: SCHEMA_REF, project: 'x' }).success).toBe(true);
  });

  test('survives a settings write, which rewrites the file it sits in', () => {
    const file = join(workspace, 'schema-ref.json');
    writeFileSync(file, JSON.stringify({ $schema: SCHEMA_REF, project: 'surfaces-test' }, null, 2));

    writeSetting(file, 'portless.enabled', 'true');

    // `config set` edits the file rather than regenerating it from a parse, and this is the
    // key that proves it: a rewrite would drop it and silently unhook the editor.
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.$schema).toBe(SCHEMA_REF);
    expect(raw.portless.enabled).toBe(true);
  });

  test('`mocktown init` writes a config the schema is next to, and mocktown can read back', async () => {
    const fresh = join(root, 'fresh-repo');
    mkdirSync(fresh, { recursive: true });
    const cli = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
    const result = Bun.spawnSync(['bun', cli, 'init', 'fresh-project'], {
      cwd: fresh,
      env: { ...process.env, MOCKTOWN_CONFIG_HOME: join(root, 'config'), MOCKTOWN_DATA_HOME: join(root, 'data') },
    });
    expect(result.stderr.toString()).toBe('');

    const written = JSON.parse(readFileSync(join(fresh, 'mocktown.json'), 'utf8'));
    expect(written.$schema).toBe(SCHEMA_REF);
    // Writing a config mocktown cannot read is the one failure `init` must never have.
    expect(ProjectFile.safeParse(written).success).toBe(true);

    // The reference has to resolve, or the editor reports a broken `$schema` on a file
    // mocktown generated a second earlier.
    const schemaPath = workspacePaths(fresh).schemaFile;
    expect(schemaPath).toBe(join(fresh, SCHEMA_REF));
    expect(JSON.parse(readFileSync(schemaPath, 'utf8')).title).toBe('mocktown.json');

    // `.mocktown/` says for itself what of it is committed, so the repo's own .gitignore
    // carries only the file that lives outside it.
    expect(readFileSync(join(fresh, '.gitignore'), 'utf8')).toContain('.env.mocktown');
    // Only what mocktown derives is named; the mocks, the panels and anything a person
    // adds are committed without needing a rule.
    const rules = readFileSync(workspacePaths(fresh).localIgnore, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'));
    expect(rules).toEqual(['/config.local.json', '/mocktown.schema.json', '/issues/', '/skills/']);
    rmSync(schemaPath);
    new ProjectRuntime(resolveProject({ cwd: fresh })).ensureDirs();
    expect(existsSync(schemaPath)).toBe(true);
  }, 30_000);
});

describe('nested CLI flags', () => {
  const shape = walkContract(contract).find((p) => p.route === '/services/{id}')!.inputSchema;

  test('a list of strings accepts one bare value, and JSON for more', () => {
    // `--aliases '["app.example.com"]'` to name a single hostname is a tax with nothing
    // behind it, and the parser's own failure names an offset into a string nobody can see.
    expect(coerceInput(shape, { aliases: 'app.example.com' }).aliases).toEqual(['app.example.com']);
    expect(coerceInput(shape, { aliases: '["a.com","b.com"]' }).aliases).toEqual(['a.com', 'b.com']);
    // Splitting on commas would be the obvious next step and is wrong: `--flows` carries
    // shell commands, and those contain commas.
    expect(coerceInput(shape, { aliases: 'a.com,b.com' }).aliases).toEqual(['a.com,b.com']);
  });
});

describe('the project settings surface', () => {
  /**
   * The list is derived from `ProjectFile` rather than written out, so the test that matters
   * is that the derivation stays faithful: right type, right default, and no entry for a
   * shape no form could edit.
   */
  test('every knob comes from the schema, with its type and default', () => {
    const byKey = Object.fromEntries(settingsOf(null).map((setting) => [setting.key, setting]));

    expect(byKey['portless.enabled']).toMatchObject({ type: 'boolean', value: 'false', default: 'false' });
    expect(byKey['drift.intervalHours']).toMatchObject({ type: 'number', default: '24' });
    expect(byKey['capture.ignore']).toMatchObject({ type: 'string[]', default: '[]' });
    expect(byKey['app.url']).toMatchObject({ type: 'string', default: 'null' });
    // The description is the only documentation a GUI form field gets.
    expect(byKey['drift.enabled']!.description).toContain('real services');

    // Identity is not a knob — renaming a project in place orphans its data directory rather
    // than renaming anything. Services have their own screen. Rules are objects, not fields.
    const keys = settingsOf(null).map((setting) => setting.key);
    expect(keys).not.toContain('project');
    expect(keys).not.toContain('services');
    expect(keys).not.toContain('scrub.rules');
  });

  test('every knob explains itself', () => {
    // The settings screen renders this text as the only documentation a knob gets, and a
    // form field labelled `scrub.entropyBackstop` with a checkbox and nothing else is not a
    // control anyone can use. Adding a field to the schema means writing its `.describe()`.
    const undocumented = settingsOf(null).filter((setting) => !setting.description);
    expect(undocumented.map((setting) => setting.key)).toEqual([]);
  });

  test('a written knob lands in mocktown.json and keeps the rest of the file', () => {
    const file = join(workspace, 'mocktown.json');
    writeFileSync(file, JSON.stringify({ project: 'surfaces-test', services: { 'api.acme': { provider: 'record' } } }, null, 2));

    const settings = writeSetting(file, 'portless.enabled', 'true');
    expect(settings.find((s) => s.key === 'portless.enabled')!.value).toBe('true');

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.portless.enabled).toBe(true);
    // A settings write is not a rewrite: the file is edited, not regenerated from a parse,
    // so nothing the caller did not touch is normalised away.
    expect(raw.services).toEqual({ 'api.acme': { provider: 'record' } });
    expect(raw.capture).toBeUndefined();
  });

  test('a registry decision lands in mocktown.json, not just in the database', () => {
    // The `undeclared-service` issue tells you to run `services set` so the next machine
    // inherits the decision. For a while the command wrote only the daemon's database, so
    // the decision never left the machine that made it and the host was rediscovered on the
    // next clone — the one failure the issue exists to prevent.
    const file = join(workspace, 'registry.json');
    writeFileSync(file, JSON.stringify({ $schema: SCHEMA_REF, project: 'surfaces-test' }, null, 2));

    writeService(file, 'accounts.example', { provider: 'passthrough' });

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.services['accounts.example']).toEqual({ provider: 'passthrough' });
    expect(raw.$schema).toBe(SCHEMA_REF);
  });

  test('changing a provider keeps the aliases and seed already committed for that service', () => {
    const file = join(workspace, 'registry-merge.json');
    writeFileSync(
      file,
      JSON.stringify(
        { project: 'surfaces-test', services: { 'api.acme': { provider: 'record', seed: 'seeds/api.ts', aliases: ['api.acme.dev'] } } },
        null,
        2,
      ),
    );

    writeService(file, 'api.acme', { provider: 'generated:api.acme' });

    const raw = JSON.parse(readFileSync(file, 'utf8'));
    expect(raw.services['api.acme']).toEqual({ provider: 'generated:api.acme', seed: 'seeds/api.ts', aliases: ['api.acme.dev'] });
  });

  test('a bad value is refused before it can break every other command', () => {
    const file = join(workspace, 'mocktown.json');
    const before = readFileSync(file, 'utf8');

    expect(() => writeSetting(file, 'portless.enabled', 'yes please')).toThrow(/must be JSON/);
    expect(() => writeSetting(file, 'drift.intervalHours', '"soon"')).toThrow(/intervalHours/);
    expect(() => writeSetting(file, 'nonsense.key', 'true')).toThrow(/not a setting/);

    // A config file that will not parse takes down the command that would fix it, so a
    // rejected write must leave the file exactly as it was.
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('issues as files', () => {
  test('open issues materialize under .mocktown/issues and resolved ones disappear', () => {
    const issueId = runtime.issues.file({
      type: 'unknown-service',
      service: 'telemetry.acme',
      method: 'POST',
      pathTemplate: '/v1/events',
      suggestedResolution: 'Register the service.',
    });

    const dir = join(workspace, '.mocktown', 'issues');
    expect(readdirSync(dir)).toContain(`${issueId}.json`);

    const written = JSON.parse(readFileSync(join(dir, `${issueId}.json`), 'utf8'));
    // A file-oriented agent gets the same warning the API carries.
    expect(written._mocktown.note).toContain('untrusted input');
    expect(written._mocktown.resolve).toContain(issueId);

    runtime.issues.setStatus(issueId, 'resolved');
    // The directory is the open queue, not an archive.
    expect(existsSync(join(dir, `${issueId}.json`))).toBe(false);
  });

  test('the same failure recurring counts occurrences instead of duplicating work', () => {
    const first = runtime.issues.file({ type: 'unmatched-request', service: 'a.test', method: 'GET', pathTemplate: '/x' });
    const second = runtime.issues.file({ type: 'unmatched-request', service: 'a.test', method: 'GET', pathTemplate: '/x' });
    expect(second).toBe(first);
    expect(runtime.issues.get(first)!.occurrences).toBe(2);
  });

  test('a recurrence refreshes the diagnosis and the fix together', () => {
    // A fresh reason next to a stale resolution is worse than either: the issue
    // contradicts itself, and an agent reading only the issue acts on the wrong half.
    const issueId = runtime.issues.file({
      type: 'unmatched-request',
      service: 'c.test',
      method: 'GET',
      pathTemplate: '/z',
      diagnosis: { reason: 'first reason' },
      suggestedResolution: 'first fix',
    });
    runtime.issues.file({
      type: 'unmatched-request',
      service: 'c.test',
      method: 'GET',
      pathTemplate: '/z',
      diagnosis: { reason: 'second reason' },
      suggestedResolution: 'second fix',
    });

    const issue = runtime.issues.get(issueId)!;
    expect((issue.diagnosis as { reason: string }).reason).toBe('second reason');
    expect(issue.suggestedResolution).toBe('second fix');
  });

  test('a resolved issue that recurs reopens rather than filing anew', () => {
    const issueId = runtime.issues.file({ type: 'unmatched-request', service: 'b.test', method: 'GET', pathTemplate: '/y' });
    runtime.issues.setStatus(issueId, 'resolved');
    // A fix that did not hold is the same piece of work, with history.
    expect(runtime.issues.file({ type: 'unmatched-request', service: 'b.test', method: 'GET', pathTemplate: '/y' })).toBe(issueId);
    expect(runtime.issues.get(issueId)!.status).toBe('reopened');
  });

  test('a recurrence refreshes the evidence it cites, not just the reason', () => {
    // The reason names a recording and the link fetches one. Updating one without the other
    // leaves an issue that cites evidence for a failure it is no longer describing.
    const issueId = runtime.issues.file({
      type: 'state-violation',
      service: 'c.test',
      method: 'GET',
      pathTemplate: '/z',
      suggestedResolution: 'Replay of recording rec_first did not match.',
      links: ['mocktown recordings get --id rec_first'],
    });
    runtime.issues.file({
      type: 'state-violation',
      service: 'c.test',
      method: 'GET',
      pathTemplate: '/z',
      suggestedResolution: 'Replay of recording rec_second did not match.',
      links: ['mocktown recordings get --id rec_second'],
    });

    const issue = runtime.issues.get(issueId)!;
    expect(issue.suggestedResolution).toContain('rec_second');
    expect(issue.links).toEqual(['mocktown recordings get --id rec_second']);
  });
});

describe("the contract's house rules are structural", () => {
  const procedures = walkContract(contract);

  test('every procedure is reachable on all three surfaces', () => {
    expect(procedures.length).toBeGreaterThan(20);
    for (const procedure of procedures) {
      // A procedure with no summary produces a CLI command and an MCP tool with no help.
      expect(procedure.summary, `${procedure.path.join('.')} has no summary`).toBeTruthy();
      expect(procedure.route.startsWith('/'), `${procedure.path.join('.')} has no REST path`).toBe(true);
      expect(['GET', 'PUT', 'POST', 'DELETE']).toContain(procedure.method);
    }
  });

  /**
   * A long-lived daemon plus an edited contract is the normal state of development, and the
   * failure it used to produce named nothing: whichever renderer touched a field the daemon
   * had never learned to send threw `undefined is not an object`.
   */
  test('the signature moves when a client-visible shape moves, and not otherwise', () => {
    const signature = contractSignature(contract);
    expect(signature).toMatch(/^[0-9a-f]{12}$/);
    expect(contractSignature(contract)).toBe(signature);

    // Two variants of the same shape, so the assertions are about the function and not
    // about whichever procedure happened to be convenient to mutate.
    const base = (summary: string, out: z.ZodType) => ({
      thing: {
        get: oc
          .route({ method: 'GET', path: '/thing', summary })
          .input(z.object({ project: z.string() }))
          .output(out),
      },
    });
    const original = base('Get the thing', z.object({ project: z.string(), name: z.string() }));

    // An added output field is exactly the skew that breaks a renderer.
    const grown = base('Get the thing', z.object({ project: z.string(), name: z.string(), extra: z.string() }));
    expect(contractSignature(grown)).not.toBe(contractSignature(original));

    // A summary is documentation, not shape: it must not invalidate a running daemon.
    const reworded = base('Fetch the thing', z.object({ project: z.string(), name: z.string() }));
    expect(contractSignature(reworded)).toBe(contractSignature(original));
  });

  test('every procedure names the project it acts on', () => {
    // 08-projects-config.md: every command prints the resolved project, which is only
    // possible if every procedure carries it.
    for (const procedure of procedures) {
      expect(inputShape(procedure.inputSchema), `${procedure.path.join('.')} has no input shape`).toHaveProperty('project');
    }
  });

  test('readOnlyHint follows the HTTP method, not a per-tool declaration', () => {
    const readOnly = procedures.filter((p) => p.method === 'GET').map((p) => p.path.join('_'));
    const mutating = procedures.filter((p) => p.method !== 'GET').map((p) => p.path.join('_'));
    expect(readOnly).toContain('issues_list');
    expect(mutating).toContain('issues_resolve');
    // The two sets must be disjoint, or an agent could call a mutating tool speculatively.
    expect(readOnly.filter((name) => mutating.includes(name))).toEqual([]);
  });

  test('every procedure has a human rendering, not a JSON dump', () => {
    // `--json` is the raw response and the human output is a projection of it. A procedure
    // with no renderer falls back to printing the JSON, which quietly breaks that contract.
    const unrendered = procedures.map((p) => p.path.join('.')).filter((key) => !RENDERERS[key]);
    expect(unrendered).toEqual([]);
  });

  test('MCP tool names survive the dot-to-underscore flattening without colliding', () => {
    const names = procedures.map((p) => p.path.join('_'));
    expect(new Set(names).size).toBe(names.length);
  });

  test('a described input field reaches the generated flag', () => {
    // Zod 4 keeps `.describe()` text in `z.globalRegistry`, not on `_zod.def`. Reading the
    // def compiles, type-checks and returns `undefined` for every field, which is how the
    // whole CLI lost its flag help at once. This is the guard against reading it again.
    const set = procedures.find((p) => p.path.join('.') === 'services.set')!;
    const id = inputShape(set.inputSchema)!.id!;
    expect(describedAs(id)).toBe('Hostname or logical service id');
    expect(fieldInfo(id).description).toBe('Hostname or logical service id');
  });

  test('a union flag documents the forms it accepts', () => {
    // `--provider generated` failing with a bare validation error taught nobody that the
    // value wanted a qualifier. The accepted forms belong in the help text.
    const set = procedures.find((p) => p.path.join('.') === 'services.set')!;
    const provider = inputShape(set.inputSchema)!.provider!;
    const { description } = fieldInfo(provider);
    expect(description).toContain('generated:<name>');
    expect(description).toContain('record');
    expect(description).toContain('deny');
  });

  test('an optional field stays optional through the description lookup', () => {
    const set = procedures.find((p) => p.path.join('.') === 'services.set')!;
    const shape = inputShape(set.inputSchema)!;
    expect(fieldInfo(shape.seed!).optional).toBe(true);
    // A required field must stay required, or the CLI stops demanding it up front.
    expect(fieldInfo(shape.id!).optional).toBe(false);
  });
});

/**
 * The daemon state file is how every client finds the daemon, and it outlives the process
 * that wrote it: a `kill -9`, a crash or a reboot all leave one behind. Read as fact, a
 * leftover file sends every command at a port nothing is on — and the failure that comes
 * back, `the socket connection was closed unexpectedly`, names neither the daemon nor the
 * file to delete. Each test here is a restart that went that way.
 */
describe('the daemon state file is a claim, not proof of life', () => {
  const cli = join(import.meta.dir, '..', 'src', 'cli', 'index.ts');
  const daemonEntry = join(import.meta.dir, '..', 'src', 'daemon', 'index.ts');
  const env = { ...process.env, MOCKTOWN_CONFIG_HOME: join(root, 'config'), MOCKTOWN_DATA_HOME: join(root, 'data') };

  /** A pid that is certainly nobody's: spawn something trivial and let it be reaped. */
  function deadPid(): number {
    const corpse = Bun.spawnSync(['true']);
    expect(corpse.exitCode).toBe(0);
    return corpse.pid;
  }

  function register(state: { port: number; pid: number }): void {
    mkdirSync(globalConfigDir(), { recursive: true });
    writeFileSync(daemonStateFile(), JSON.stringify({ token: 'surfaces-token', contract: 'unknown', ...state }));
  }

  async function until(predicate: () => boolean, timeoutMs = 20_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (predicate()) return true;
      await Bun.sleep(50);
    }
    return false;
  }

  /** A real daemon process, registered and answering, so a shutdown can be observed end to end. */
  async function startRegisteredDaemon() {
    const child = Bun.spawn(['bun', daemonEntry], { env, stdout: 'pipe', stderr: 'pipe' });
    if (!(await until(() => readDaemonState()?.pid === child.pid))) {
      child.kill('SIGKILL');
      throw new Error(`the daemon never registered: ${await new Response(child.stderr).text()}`);
    }
    return child;
  }

  afterEach(() => rmSync(daemonStateFile(), { force: true }));

  test('a dead pid is a stale file, not a running daemon', async () => {
    register({ port: 4499, pid: deadPid() });
    expect((await daemonLiveness()).status).toBe('stale');
  });

  test('a live pid whose port answers nothing is not running either', async () => {
    // What a recycled pid looks like: the daemon died, the OS handed its number to something
    // else, and only the port can tell the difference. This process stands in for that.
    register({ port: await findFreePort(4900), pid: process.pid });
    expect((await daemonLiveness()).status).toBe('unresponsive');
  });

  test('a pid that is alive and a port that answers is running', async () => {
    const port = await findFreePort(4950);
    const server = Bun.serve({
      port,
      hostname: '127.0.0.1',
      fetch: (request) => new Response('{}', { status: new URL(request.url).pathname === '/api/v1/openapi.json' ? 200 : 404 }),
    });
    try {
      register({ port, pid: process.pid });
      const liveness = await daemonLiveness();
      expect(liveness.status).toBe('running');
      // The state is handed back with the verdict: a caller that has to re-read the file to
      // get the token has two answers to reconcile.
      expect(liveness.status === 'running' && liveness.state.token).toBe('surfaces-token');
    } finally {
      await server.stop(true);
    }
  });

  test('`daemon status` names the stale file instead of a port nothing is on', () => {
    register({ port: 4499, pid: deadPid() });
    const result = Bun.spawnSync(['bun', cli, 'daemon', 'status'], { env });
    expect(result.stdout.toString()).toContain('not running (stale state file');
    expect(result.stdout.toString()).not.toContain('running on 127.0.0.1:4499');
    // Status reports; it does not repair. `daemon stop` is the command that clears it, and
    // that is what the output says.
    expect(existsSync(daemonStateFile())).toBe(true);
  }, 30_000);

  test('`daemon stop` clears a stale file instead of raising ESRCH at whoever ran it', () => {
    register({ port: 4499, pid: deadPid() });
    const result = Bun.spawnSync(['bun', cli, 'daemon', 'stop'], { env });
    expect(result.exitCode).toBe(0);
    // The unguarded `process.kill` printed `SystemError: kill() failed: ESRCH` and a stack
    // trace at someone whose only problem was a file left behind by a crash.
    expect(result.stderr.toString()).toBe('');
    expect(result.stdout.toString()).toContain('not running');
    // Gone, so the next command starts a daemon rather than dialling the dead port again.
    expect(existsSync(daemonStateFile())).toBe(false);
  }, 30_000);

  test('a daemon removes its own registration on the way out', async () => {
    const child = await startRegisteredDaemon();
    child.kill('SIGTERM');
    await child.exited;
    expect(existsSync(daemonStateFile())).toBe(false);
  }, 30_000);

  test('but never one that belongs to another daemon', async () => {
    const child = await startRegisteredDaemon();
    try {
      // Two daemons at once is the situation this guards: an orphan from an earlier shell and
      // the one that registered after it. Stopping the orphan used to delete the live
      // daemon's registration, leaving it running with no client able to find it.
      const live = { port: 4500, pid: process.pid };
      register(live);
      child.kill('SIGTERM');
      await child.exited;
      expect(readDaemonState()).toMatchObject(live);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }, 30_000);
});
