/**
 * The surfaces around the loop: HAR import, `mocktown env`, issue files, and the
 * structural house rules the contract walk is supposed to enforce.
 *
 * The last group is the important one. Spike 02's argument for owning the walk was that
 * it makes house rules *structural* rather than per-command discipline — `--json` on
 * every command, `readOnlyHint` derived from the HTTP method, the project resolved by
 * the CLI. That argument is only true if something checks it, so this does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '.tmp-surfaces');
process.env.MOCKTOWN_CONFIG_HOME = join(root, 'config');
process.env.MOCKTOWN_DATA_HOME = join(root, 'data');

const { ProjectRuntime } = await import('#src/daemon/runtime.ts');
const { resolveProject } = await import('#src/config/project.ts');
const { schema } = await import('#src/db/client.ts');
const { parseHar } = await import('#src/capture/har.ts');
const { Recorder, startSession } = await import('#src/capture/recorder.ts');
const { generateEnv, renderAgentsSection, renderEnvFile } = await import('#src/env/generate.ts');
const { contract } = await import('#src/contract/index.ts');
const { walkContract, inputShape, describedAs, fieldInfo } = await import('#src/contract/walk.ts');
const { captureEnv } = await import('#src/capture/launch.ts');
const { RENDERERS } = await import('#src/cli/render.ts');

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

  test('the AGENTS.md section pins the project rather than trusting the global default', () => {
    const artifacts = generateEnv(inputs);
    const section = renderAgentsSection('surfaces-test', artifacts.agentTasks, artifacts.report);
    // The kubectl current-context footgun: concurrent agents would cross-contaminate.
    expect(section).toContain('export MOCKTOWN_PROJECT=surfaces-test');
    expect(section).toContain('untrusted input');
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
    const issueId = runtime.issues.file({ type: 'near-miss', service: 'b.test', method: 'GET', pathTemplate: '/y' });
    runtime.issues.setStatus(issueId, 'resolved');
    // A fix that did not hold is the same piece of work, with history.
    expect(runtime.issues.file({ type: 'near-miss', service: 'b.test', method: 'GET', pathTemplate: '/y' })).toBe(issueId);
    expect(runtime.issues.get(issueId)!.status).toBe('reopened');
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
