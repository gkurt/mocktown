#!/usr/bin/env bun
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * The CLI. Every API-backed command is generated from the contract — add a procedure and
 * the command appears, with flags, help text and validation. No command is written by
 * hand except the ones that are not API calls at all (`init`, `record -- <cmd>`,
 * `daemon`, `studio`, `mcp`), and those are marked as such below.
 *
 * Two house rules are structural rather than per-command discipline (spike 02):
 *   - `--json` exists on every command, and the human rendering is a projection of it
 *   - the resolved project is the first line of output (08-projects-config.md)
 */
import { Command, Option } from 'commander';
import type * as z from 'zod/v4';
import { launch } from '#src/capture/launch.ts';
import { clientFor, ensureDaemon } from '#src/cli/daemon-client.ts';
import { renderResult } from '#src/cli/render.ts';
import { projectPaths } from '#src/config/paths.ts';
import { ensureRegistered, loadGlobalConfig, resolveProject, saveGlobalConfig } from '#src/config/project.ts';
import { ProjectFile } from '#src/config/schema.ts';
import { contract } from '#src/contract/index.ts';
import { inputShape, type ProcedureInfo, walkContract } from '#src/contract/walk.ts';
import { readDaemonState } from '#src/daemon/server.ts';

const here = dirname(fileURLToPath(import.meta.url));
const program = new Command('mocktown')
  .description("Record an app's outbound traffic, serve it back as stateful mocks, and keep them alive.")
  .option('--project <name>', 'Project to act on (overrides MOCKTOWN_PROJECT and mocktown.json)')
  .option('--json', 'Emit the raw API response');

// ── Flag generation ───────────────────────────────────────────────────────────

/** Unwrap `.optional()` / `.default()` so the flag reflects the value's real type. */
function coreType(field: any): { type: string; optional: boolean; description: string } {
  let node = field;
  let optional = false;
  let description = node?._zod?.def?.description ?? '';
  for (let depth = 0; depth < 8; depth++) {
    const def = node?._zod?.def;
    if (!def) break;
    description ||= def.description ?? '';
    if (def.type === 'optional' || def.type === 'default' || def.type === 'nullable' || def.type === 'pipe') {
      if (def.type !== 'pipe') optional = true;
      node = def.innerType ?? def.in ?? node;
      continue;
    }
    return { type: def.type ?? 'string', optional, description };
  }
  return { type: 'string', optional, description };
}

const kebab = (name: string) => name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

function addOptions(command: Command, schema: z.ZodType): void {
  const shape = inputShape(schema);
  if (!shape) return;
  for (const [name, field] of Object.entries(shape)) {
    // `project` and `source` are the CLI's resolution, not the user's input:
    // 08-projects-config.md's resolution order is the CLI's job, and a required
    // --project on every command would defeat it.
    if (name === 'project' || name === 'source') continue;

    const { type, optional, description } = coreType(field);
    const flag = type === 'boolean' ? `--${kebab(name)}` : `--${kebab(name)} <value>`;
    const option = new Option(flag, description || undefined);
    // Path parameters and other required inputs are mandatory, so a missing one fails
    // before a request goes out rather than as a 400 from the daemon.
    if (!optional && type !== 'boolean') option.makeOptionMandatory();
    command.addOption(option);
  }
}

/** Commander gives strings; the contract wants the declared type. */
function coerceInput(schema: z.ZodType, options: Record<string, unknown>): Record<string, unknown> {
  const shape = inputShape(schema);
  if (!shape) return options;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(options)) {
    const field = shape[name];
    if (value === undefined || !field) continue;
    const { type } = coreType(field);
    if (type === 'object' || type === 'record' || type === 'array') {
      // Nested inputs (seed editors, knob values, profile credentials) arrive as JSON on
      // one flag — spike 02 flagged this as the open question; JSON is the honest answer.
      out[name] = typeof value === 'string' ? JSON.parse(value) : value;
    } else if (type === 'number' || type === 'int') {
      out[name] = typeof value === 'string' ? Number(value) : value;
    } else {
      out[name] = value;
    }
  }
  return out;
}

// ── Generated commands ────────────────────────────────────────────────────────

const procedures = walkContract(contract);

/**
 * A group's `get` collapses onto the group name when it needs no arguments, so `status.get`
 * is `mocktown status` and `env.get` is `mocktown env` — the shapes 08-projects-config.md
 * and 05-redirection.md use. `issues.get` takes an id, so it keeps its verb: `mocktown
 * issues` must not silently mean "fetch one issue". Siblings are unaffected, which is how
 * `mocktown env` and `mocktown env write` coexist.
 */
const collapsedProcedures = new Set(
  procedures
    .filter((p) => p.path.length === 2 && p.path[1] === 'get')
    .filter((p) => {
      const shape = inputShape(p.inputSchema) ?? {};
      return Object.entries(shape).every(([name, field]) => name === 'project' || name === 'source' || coreType(field).optional);
    })
    .map((p) => p.path.join('.')),
);

/** Group descriptions, so `mocktown --help` reads as a map of the product. */
const GROUP_DESCRIPTIONS: Record<string, string> = {
  services: 'The service registry: which hostname is served by what',
  recordings: 'Browse the scrubbed corpus',
  corpus: 'Export the corpus in the form a generating agent reads',
  record: 'Record traffic through the front door',
  serve: 'Serve mocked dependencies through the front door',
  import: 'Bring traffic captured by another tool into the corpus',
  scrub: 'Secrets scrubbing and its audit',
  issues: "The agent loop's work queue",
  providers: 'Provider processes behind the front door',
  mocks: 'Generated mocks: scaffold them, verify them',
  skills: 'Prompt packs for the recurring agent jobs',
  ekb: 'Endpoint knowledge base: how clients get pointed at each service',
  knobs: 'Scenario dials on a generated mock',
  profiles: 'Auth profiles \u2014 the personas a scenario is tested as',
  state: 'Provider state: inspect it, reset it',
};

/** `recordings.list` -> `mocktown recordings list`. */
function commandFor(procedure: ProcedureInfo): Command {
  const segments = collapsedProcedures.has(procedure.path.join('.')) ? procedure.path.slice(0, 1) : procedure.path;

  let parent = program;
  for (const segment of segments.slice(0, -1)) {
    parent = parent.commands.find((c) => c.name() === segment) ?? parent.command(segment).description(GROUP_DESCRIPTIONS[segment] ?? '');
  }
  const name = segments.at(-1)!;
  const existing = parent.commands.find((c) => c.name() === name);
  return (existing ?? parent.command(name)).description(procedure.summary ?? '');
}

for (const procedure of procedures) {
  const command = commandFor(procedure);
  addOptions(command, procedure.inputSchema);
  command.option('--json', 'Emit the raw API response');
  command.action(async (options: Record<string, unknown>) => {
    const globals = program.opts();
    const wantsJson = Boolean(options.json ?? globals.json);
    const { json: _json, ...rest } = options;

    try {
      const project = resolveProject({ project: globals.project as string | undefined });
      ensureRegistered(project);
      const connection = await ensureDaemon();
      const client = clientFor(connection);
      const call = procedure.path.reduce<any>((node, key) => node[key], client);
      // A procedure that accepts `source` is asking how the caller resolved the project,
      // so every command can print it — the daemon only ever sees a name.
      const wantsSource = Boolean(inputShape(procedure.inputSchema)?.source);
      const result = await call({
        project: project.name,
        ...(wantsSource ? { source: project.source } : {}),
        ...coerceInput(procedure.inputSchema, rest),
      });

      if (wantsJson) console.log(JSON.stringify(result));
      else console.log(renderResult(procedure.path, result).join('\n'));
    } catch (error: any) {
      const message = error?.message ?? String(error);
      if (wantsJson) console.log(JSON.stringify({ error: message }));
      else console.error(`error: ${message}`);
      process.exitCode = 1;
    }
  });
}

// ── Hand-written commands: the ones that are not API calls ────────────────────

program
  .command('init')
  .argument('[name]', 'Project name (defaults to the directory name)')
  .description('Write mocktown.json, register the project, and add the gitignore entries')
  .action((name?: string) => {
    const cwd = process.cwd();
    // `--project` names the project every other command acts on, so honouring it here too
    // keeps `mocktown init --project x` from silently creating a differently-named one.
    const project = name ?? program.opts().project ?? cwd.split('/').filter(Boolean).at(-1) ?? 'main';
    const file = join(cwd, 'mocktown.json');
    if (existsSync(file)) {
      console.error(`error: ${file} already exists`);
      process.exitCode = 1;
      return;
    }

    writeFileSync(file, `${JSON.stringify(ProjectFile.parse({ project }), null, 2)}\n`);
    mkdirSync(join(cwd, '.mocktown', 'issues'), { recursive: true });

    // Never committed: the recordings DB, the CA key, and .env.mocktown (it embeds local
    // ports — regenerate it rather than sharing it). 08-projects-config.md.
    const gitignore = join(cwd, '.gitignore');
    const entries = ['.mocktown/', '.env.mocktown'];
    const existing = existsSync(gitignore) ? readFileSync(gitignore, 'utf8') : '';
    const missing = entries.filter((entry) => !existing.split('\n').includes(entry));
    if (missing.length) writeFileSync(gitignore, `${existing.trimEnd()}\n${missing.join('\n')}\n`.trimStart());

    ensureRegistered(resolveProject({ cwd }));
    console.log(`project: ${project}`);
    console.log(`  wrote ${file}`);
    console.log(`  data dir ${projectPaths(project).root}`);
    if (missing.length) console.log(`  gitignored ${missing.join(', ')}`);
  });

const projectCommand = program.command('project').description('Manage the global default project');

projectCommand
  .command('list')
  .description('Registered projects and their data directories')
  .action(() => {
    const config = loadGlobalConfig();
    console.log(`default: ${config.defaultProject}`);
    for (const [name, entry] of Object.entries(config.projects)) {
      console.log(`  ${name.padEnd(24)} ${entry.dataDir}${entry.workspace ? `  <- ${entry.workspace}` : ''}`);
    }
  });

projectCommand
  .command('use')
  .argument('<name>')
  .description('Set the global default project')
  .action((name: string) => {
    const config = loadGlobalConfig();
    config.defaultProject = name;
    saveGlobalConfig(config);
    console.log(`project: ${name}`);
    // The kubectl current-context footgun: concurrent agents across projects would
    // cross-contaminate the moment one switched the default (08-projects-config.md).
    console.log('  note: agent instructions must pin MOCKTOWN_PROJECT explicitly rather than rely on this.');
  });

/**
 * `mocktown record -- <cmd>` is the launch wrapper from 03-capture.md, and
 * `record start` / `record stop` are generated from the contract. Both live under the
 * same command: the wrapper is the group's own action, so it runs when the next argument
 * is not one of its subcommands.
 */
const recordCommand = program.commands.find((c) => c.name() === 'record')!;
recordCommand
  .description("Record a command's outbound traffic through the front door")
  .argument('[command...]', 'Command to run after --')
  .option('--label <label>', 'Label for this recording session')
  .option('--seed <seed>', 'Session seed (default is fixed, so runs are reproducible)')
  .action(async (argv: string[], options: { label?: string; seed?: string }) => {
    const globals = program.opts();
    const project = resolveProject({ project: globals.project as string | undefined });
    ensureRegistered(project);
    const connection = await ensureDaemon();
    const client = clientFor(connection);

    const started = await client.record.start({ project: project.name, label: options.label, seed: options.seed });
    console.log(`project: ${project.name}`);
    console.log(`recording session ${started.session} — proxy ${started.proxyUrl}`);

    if (argv.length === 0) {
      console.log('front door is up; stop with `mocktown record stop`. Env for the app under test:');
      for (const [key, value] of Object.entries(started.env)) console.log(`  export ${key}=${value}`);
      return;
    }

    // The launch wrapper: proxy env plus every per-runtime CA knob, including
    // NODE_USE_ENV_PROXY=1 without which fetch-based SDKs escape the front door.
    const [command, ...args] = argv;
    const result = await launch(command!, args, started.env as Record<string, string>);
    const stopped = await client.record.stop({ project: project.name });
    console.log(`\n${stopped.recorded} exchange${stopped.recorded === 1 ? '' : 's'} recorded across ${stopped.services.length} service(s)`);
    for (const service of stopped.services) console.log(`  ${service}`);
    process.exitCode = result.exitCode;
  });

const daemonCommand = program.command('daemon').description('The long-running server every client talks to');

daemonCommand
  .command('start')
  .option('--port <port>', 'Port to bind on 127.0.0.1')
  .description('Start the daemon in the foreground')
  .action(async (options: { port?: string }) => {
    const args = [join(here, '..', 'daemon', 'index.ts'), ...(options.port ? ['--port', options.port] : [])];
    const child = spawn(process.execPath, args, { stdio: 'inherit' });
    await new Promise((r) => child.once('exit', r));
  });

daemonCommand
  .command('status')
  .description('Whether a daemon is running, and where')
  .action(() => {
    const state = readDaemonState();
    console.log(state ? `running on 127.0.0.1:${state.port} (pid ${state.pid})` : 'not running');
  });

daemonCommand
  .command('stop')
  .description('Stop the running daemon')
  .action(() => {
    const state = readDaemonState();
    if (!state) {
      console.log('not running');
      return;
    }
    process.kill(state.pid, 'SIGTERM');
    console.log(`stopped (pid ${state.pid})`);
  });

program
  .command('studio')
  .description("Open Drizzle Studio against this project's database")
  .action(async () => {
    const globals = program.opts();
    const project = resolveProject({ project: globals.project as string | undefined });
    const db = projectPaths(project.name).db;
    console.log(`project: ${project.name}`);
    console.log(`  database ${db}`);
    // Studio runs under Node, which cannot use `bun:sqlite`, so it needs its own driver.
    // It is an optional dependency: a platform where it fails to build should lose the
    // viewer, not the product.
    try {
      import.meta.resolve('@libsql/client');
    } catch {
      console.error('error: Drizzle Studio needs a Node SQLite driver that is not installed.');
      console.error('  install it with: bun add @libsql/client');
      console.error('  or open the database above in any SQLite viewer \u2014 it is a plain file.');
      process.exitCode = 1;
      return;
    }

    // Studio is a free state viewer over the same schema (09-gui-plugins.md); it reads
    // the file directly, so the daemon stays the only writer.
    const child = spawn('bunx', ['drizzle-kit', 'studio'], {
      stdio: 'inherit',
      cwd: resolve(here, '..', '..'),
      env: { ...process.env, MOCKTOWN_PROJECT: project.name, MOCKTOWN_DB: db },
    });
    await new Promise((r) => child.once('exit', r));
  });

program
  .command('mcp')
  .description('Run the MCP server on stdio — the primary agent surface')
  .action(async () => {
    const { runMcpServer } = await import('#src/mcp/index.ts');
    await runMcpServer();
  });

await program.parseAsync(process.argv);
