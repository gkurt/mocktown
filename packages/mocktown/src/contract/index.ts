/**
 * The one place a Mocktown procedure is defined. The HTTP API, the OpenAPI document,
 * the typed client, the CLI and the MCP server are all derived from this file and
 * nothing else — 02-architecture.md's "one procedure definition, three surfaces",
 * measured at 10/10 on Bun in spike 02.
 *
 * House rules the generators enforce structurally, so no future procedure can opt out:
 *   - every command supports `--json`, and the human rendering is a projection of it
 *   - the resolved project is the first line of output (08-projects-config.md)
 *   - MCP `readOnlyHint` is derived from the HTTP method, not declared per-tool
 */
import { oc } from '@orpc/contract';
import * as z from 'zod/v4';
import {
  DriftFinding,
  DriftRun,
  EkbEntry,
  FeedEvent,
  Issue,
  IssueStatusFilter,
  IssueType,
  KnobDescriptor,
  Panel,
  PortlessStatus,
  Profile,
  ProjectInput,
  ProviderRef,
  ProviderStatus,
  Recording,
  SandboxStatus,
  SealCheck,
  SealStamp,
  Service,
  Setting,
  SocketFrame,
  StateCollection,
  VerifyResult,
  withProject,
} from '#src/contract/schemas.ts';

/** `env.get` and `env.write` differ only in whether the files land, so they share a shape. */
const EnvOutput = withProject({
  variables: z.record(z.string(), z.string()),
  report: z.array(z.object({ service: z.string(), rung: z.number().int().nullable(), covered: z.boolean(), how: z.string() })),
  agentTasks: z.array(z.object({ service: z.string(), rung: z.number().int(), instruction: z.string(), snippet: z.string().nullable() })),
  written: z.array(z.string()).describe('Files written, empty for the read'),
  notes: z.array(z.string()).default([]).describe('What was deliberately not written, and the knob that would change that'),
});

export const contract = {
  status: {
    get: oc
      .route({ method: 'GET', path: '/status', summary: 'Resolved project, services, providers, front door and seal state' })
      .input(
        z.object({
          ...ProjectInput,
          source: z
            .enum(['flag', 'env', 'file', 'default'])
            .optional()
            .describe('How the caller resolved the project — echoed back so every command can print it (08-projects-config.md)'),
        }),
      )
      .output(
        withProject({
          source: z.string().describe('How the project was resolved: flag, env, file, default, or unknown if the caller did not say'),
          workspace: z.string().nullable(),
          appUrl: z.string().nullable().describe('The app under test, from `app.url` — mocktown never derives this'),
          frontDoor: z.object({ running: z.boolean(), port: z.number().int().nullable(), mode: z.enum(['record', 'deny']) }),
          services: z.array(Service),
          providers: z.array(ProviderStatus),
          recordings: z.number().int(),
          outstandingIssues: z.number().int().describe('Open plus reopened — everything still waiting on someone'),
          session: z.string().nullable(),
          warnings: z.array(z.string()),
        }),
      ),
  },

  project: {
    list: oc
      .route({ method: 'GET', path: '/projects', summary: 'Every registered project, and which one is the global default' })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          default: z.string().describe('The global default, which is not necessarily the resolved project'),
          projects: z.array(
            z.object({
              name: z.string(),
              dataDir: z.string(),
              workspace: z.string().nullable(),
              /** A registry entry outlives the checkout it names; a switcher should say so. */
              workspaceExists: z.boolean(),
            }),
          ),
        }),
      ),
  },

  feed: {
    tail: oc
      .route({
        method: 'GET',
        path: '/feed',
        summary: 'Live feed: what the front door, the issue engine and the providers just did',
      })
      .input(
        z.object({
          ...ProjectInput,
          since: z.coerce.number().int().min(0).default(0).describe('Highest `seq` already seen; 0 starts from the oldest kept event'),
          limit: z.coerce.number().int().min(1).max(500).default(100),
          kind: FeedEvent.shape.kind.optional(),
          service: z.string().optional(),
          waitMs: z.coerce
            .number()
            .int()
            .min(0)
            .max(25_000)
            .default(0)
            .describe('Park up to this long waiting for the next event, then return whatever there is. 0 returns immediately'),
        }),
      )
      .output(
        withProject({
          cursor: z.number().int().describe('Pass this back as `since` on the next call'),
          events: z.array(FeedEvent),
          gap: z
            .boolean()
            .describe('True when events were dropped between `since` and the oldest kept one — the feed is a window, not a log'),
        }),
      ),
  },

  config: {
    get: oc
      .route({ method: 'GET', path: '/config', summary: "The project's knobs, their current values and their defaults" })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          file: z.string().nullable().describe('Path to mocktown.json, null when the project has no workspace'),
          settings: z.array(Setting),
        }),
      ),

    set: oc
      .route({ method: 'PUT', path: '/config', summary: 'Set one knob in mocktown.json' })
      .input(
        z.object({
          ...ProjectInput,
          key: z.string().describe('Dotted key, e.g. `portless.enabled` or `app.url`'),
          value: z.string().describe('JSON text: `true`, `24`, `"localhost"`, `null`, `["a","b"]`'),
        }),
      )
      .output(withProject({ file: z.string().nullable(), settings: z.array(Setting) })),
  },

  services: {
    list: oc
      .route({ method: 'GET', path: '/services', summary: "List the project's service registry" })
      .input(z.object({ ...ProjectInput, provider: ProviderRef.optional().describe('Filter to one provider kind') }))
      .output(withProject({ services: z.array(Service) })),

    set: oc
      .route({ method: 'PUT', path: '/services/{id}', summary: 'Assign a provider to a service' })
      .input(
        z.object({
          ...ProjectInput,
          id: z.string().describe('Hostname or logical service id'),
          provider: ProviderRef,
          seed: z.string().optional().describe('Path to a seed file, relative to the repo root'),
          aliases: z.array(z.string()).optional().describe('Other hostnames this same backend answers on. Omit to leave them unchanged'),
        }),
      )
      .output(
        withProject({
          service: Service,
          file: z.string().nullable().describe('The mocktown.json the decision was written to, or null when the project has no workspace'),
        }),
      ),
  },

  recordings: {
    list: oc
      .route({ method: 'GET', path: '/recordings', summary: 'Browse the scrubbed corpus' })
      .input(
        z.object({
          ...ProjectInput,
          service: z.string().optional(),
          method: z.string().optional(),
          session: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(1000).default(50),
          offset: z.coerce.number().int().min(0).default(0),
        }),
      )
      .output(withProject({ total: z.number().int(), recordings: z.array(Recording) })),

    get: oc
      .route({
        method: 'GET',
        path: '/recordings/{id}',
        summary: 'One exchange in full, with any spilled body inlined and any WebSocket frames in order',
      })
      .input(z.object({ ...ProjectInput, id: z.string() }))
      .output(withProject({ recording: Recording, frames: z.array(SocketFrame).describe('Empty unless the recording is a WebSocket') })),

    routes: oc
      .route({ method: 'GET', path: '/recordings/routes', summary: 'The corpus collapsed to distinct routes — what a mock has to cover' })
      .input(z.object({ ...ProjectInput, service: z.string().optional() }))
      .output(
        withProject({
          routes: z.array(
            z.object({
              service: z.string(),
              method: z.string(),
              pathTemplate: z.string(),
              kind: z.enum(['http', 'websocket', 'grpc']),
              count: z.number().int(),
              statuses: z.array(z.number().int()),
              lastSeenAt: z.string().nullable(),
            }),
          ),
        }),
      ),
  },

  corpus: {
    export: oc
      .route({ method: 'GET', path: '/corpus/export', summary: 'The corpus in agent-legible form, ready for mock generation' })
      .input(
        z.object({
          ...ProjectInput,
          service: z.string().describe('Service to export'),
          limitPerRoute: z.coerce.number().int().min(1).max(50).default(5),
        }),
      )
      .output(
        withProject({
          service: z.string(),
          generatedAt: z.string(),
          // Deliberately a document rather than rows: this is what a generating agent reads.
          routes: z.array(
            z.object({
              method: z.string(),
              pathTemplate: z.string(),
              observations: z.number().int(),
              examples: z.array(
                z.object({
                  recordingId: z.string(),
                  path: z.string(),
                  query: z.record(z.string(), z.string()),
                  statusCode: z.number().int(),
                  requestBody: z.string().nullable(),
                  responseBody: z.string().nullable(),
                  requestHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
                  responseHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
                }),
              ),
              /** POST /orders → GET /orders/{id} coupling, so the mock is stateful not verbatim. */
              statefulHints: z.array(z.string()),
            }),
          ),
          sockets: z
            .array(
              z.object({
                pathTemplate: z.string(),
                observations: z.number().int(),
                frames: z.array(
                  z.object({
                    direction: z.enum(['sent', 'received']),
                    encoding: z.enum(['text', 'base64']),
                    body: z.string(),
                    atMs: z.number().int(),
                  }),
                ),
                truncatedFrames: z.boolean().describe('The transcript hit the per-socket frame cap; the conversation went on'),
                close: z.object({ code: z.number().int(), reason: z.string(), by: z.enum(['client', 'upstream']) }).nullable(),
              }),
            )
            .describe('WebSocket channels, one whole transcript each — what a `sockets` entry in the mock has to reproduce'),
          grpcMethods: z
            .array(z.object({ path: z.string(), observations: z.number().int() }))
            .describe('gRPC methods seen. Recorded, but a generated mock cannot serve them: Bun.serve does not accept HTTP/2'),
          secretKinds: z.array(z.string()).describe('Placeholder kinds present; the mock must accept credentials of these shapes'),
        }),
      ),
  },

  record: {
    start: oc
      .route({ method: 'POST', path: '/record/start', summary: 'Start the front door in record mode and open a session' })
      .input(z.object({ ...ProjectInput, label: z.string().optional(), seed: z.string().optional() }))
      .output(
        withProject({
          session: z.string(),
          proxyUrl: z.string(),
          caCertPath: z.string(),
          env: z.record(z.string(), z.string()),
          warnings: z
            .array(z.string())
            .describe('What the computed NO_PROXY costs: hosts that now enter the front door, and services it still excludes'),
        }),
      ),

    stop: oc
      .route({ method: 'POST', path: '/record/stop', summary: 'Close the recording session' })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          session: z.string().nullable(),
          recorded: z.number().int(),
          services: z.array(z.string()),
          ignored: z
            .object({
              total: z.number().int(),
              patterns: z.array(z.object({ pattern: z.string(), count: z.number().int(), why: z.string() })),
            })
            .describe("Requests dropped as the client runtime's own traffic — reported, never silent"),
          warnings: z.array(z.string()),
        }),
      ),
  },

  serve: {
    start: oc
      .route({ method: 'POST', path: '/serve/start', summary: 'Start providers and serve mocks through the front door' })
      .input(
        z.object({
          ...ProjectInput,
          seed: z.string().optional(),
          sealed: z.boolean().optional().describe('Deny unknown hosts instead of recording them'),
        }),
      )
      .output(
        withProject({
          session: z.string(),
          proxyUrl: z.string(),
          caCertPath: z.string(),
          providers: z.array(ProviderStatus),
          env: z.record(z.string(), z.string()),
          warnings: z.array(z.string()),
        }),
      ),

    stop: oc
      .route({ method: 'POST', path: '/serve/stop', summary: 'Stop providers and the front door' })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ stopped: z.array(z.string()) })),
  },

  import: {
    har: oc
      .route({ method: 'POST', path: '/import/har', summary: 'Import a HAR file into the corpus through the same scrubber' })
      .input(z.object({ ...ProjectInput, path: z.string().describe('Path to the .har file'), label: z.string().optional() }))
      .output(
        withProject({
          session: z.string(),
          imported: z.number().int(),
          skipped: z.array(z.object({ url: z.string(), reason: z.string() })),
          services: z.array(z.string()),
        }),
      ),
  },

  scrub: {
    audit: oc
      .route({ method: 'POST', path: '/scrub/audit', summary: 'Re-scan the stored corpus for anything the current rules would catch' })
      .input(z.object({ ...ProjectInput, service: z.string().optional() }))
      .output(
        withProject({
          scanned: z.number().int(),
          findings: z.array(z.object({ recordingId: z.string(), where: z.string(), kind: z.string(), sample: z.string() })),
        }),
      ),
  },

  issues: {
    list: oc
      .route({ method: 'GET', path: '/issues', summary: "The agent loop's work queue" })
      .input(
        z.object({
          ...ProjectInput,
          status: IssueStatusFilter.optional(),
          type: IssueType.optional(),
          service: z.string().optional(),
          batch: z.string().optional(),
        }),
      )
      .output(withProject({ issues: z.array(Issue) })),

    get: oc
      .route({ method: 'GET', path: '/issues/{id}', summary: 'One issue, self-contained enough for an agent to resolve' })
      .input(z.object({ ...ProjectInput, id: z.string() }))
      .output(withProject({ issue: Issue })),

    resolve: oc
      .route({
        method: 'POST',
        path: '/issues/{id}/resolve',
        summary: 'Claim an issue as fixed; the daemon replays the trigger before closing it',
      })
      .input(
        z.object({
          ...ProjectInput,
          id: z.string(),
          note: z.string().optional(),
          skipVerify: z.boolean().optional().describe('Close without replay — for issues with nothing to replay, like pinned-client'),
        }),
      )
      .output(withProject({ issue: Issue, verified: z.boolean(), verification: VerifyResult.nullable() })),
  },

  providers: {
    list: oc
      .route({ method: 'GET', path: '/providers', summary: 'Provider processes and the services each one serves' })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ providers: z.array(ProviderStatus) })),

    restart: oc
      .route({ method: 'POST', path: '/providers/{name}/restart', summary: 'Restart one provider, re-applying its seed' })
      .input(z.object({ ...ProjectInput, name: z.string() }))
      .output(withProject({ provider: ProviderStatus })),
  },

  mocks: {
    verify: oc
      .route({ method: 'POST', path: '/mocks/{service}/verify', summary: 'Replay recorded sessions against the live mock and diff' })
      .input(
        z.object({
          ...ProjectInput,
          service: z.string(),
          session: z.string().optional(),
          limit: z.coerce.number().int().min(1).max(500).default(100),
        }),
      )
      .output(withProject({ result: VerifyResult })),

    scaffold: oc
      .route({
        method: 'POST',
        path: '/mocks/{service}/scaffold',
        summary: 'Write the generation brief and a starting mock module for an agent to fill in',
      })
      .input(z.object({ ...ProjectInput, service: z.string(), force: z.boolean().optional() }))
      .output(withProject({ service: z.string(), files: z.array(z.string()), brief: z.string() })),

    schema: oc
      .route({
        method: 'POST',
        path: '/mocks/{service}/schema',
        summary: "Draft the service's response schemas from every recording, for the author to own and edit",
      })
      .input(
        z.object({
          ...ProjectInput,
          service: z.string(),
          force: z.boolean().optional().describe('Redraft over a schema that is already checked in, discarding any edits'),
          check: z
            .boolean()
            .optional()
            .describe('Write nothing: re-infer from the corpus and report where it disagrees with the checked-in schema'),
          limit: z.coerce.number().int().min(1).max(20_000).default(5000).describe('How many recordings to infer from'),
        }),
      )
      .output(
        withProject({
          service: z.string(),
          file: z.string(),
          written: z.boolean(),
          checked: z.boolean().describe('Whether this was a --check run rather than a write'),
          ok: z.boolean().describe('False when a --check run found drift; the CLI exits non-zero'),
          reason: z.string().optional().describe('Why nothing was written, when nothing was'),
          recordings: z.number().int().describe('Recordings read'),
          routes: z.array(z.object({ route: z.string(), statusCode: z.number().int(), observations: z.number().int() })),
          drift: z.array(
            z.object({
              route: z.string(),
              statusCode: z.number().int(),
              kind: z.enum(['route-added', 'route-removed', 'field-added', 'field-removed', 'type-changed']),
              path: z.string(),
              detail: z.string(),
            }),
          ),
        }),
      ),
  },

  env: {
    get: oc
      .route({ method: 'GET', path: '/env', summary: 'The generated env-var setup, coverage report and agent task list' })
      .input(z.object({ ...ProjectInput }))
      .output(EnvOutput),

    portless: {
      get: oc
        .route({
          method: 'GET',
          path: '/env/portless',
          summary: 'Whether services have stable `<service>.<project>.localhost` names, and why not',
        })
        .input(z.object({ ...ProjectInput }))
        .output(withProject(PortlessStatus.shape)),

      // Proving portless works costs a registered alias and a real request, so the check is
      // a POST and `env portless get` reads what it last proved — a GET that mutated a
      // machine's proxy state would be a read-only-looking tool with side effects.
      sync: oc
        .route({ method: 'POST', path: '/env/portless/sync', summary: 'Prove portless is usable and claim a stable name per service' })
        .input(z.object({ ...ProjectInput }))
        .output(withProject(PortlessStatus.shape)),
    },

    // Writing files is a separate, mutating procedure rather than a `--write` flag on the
    // read: `readOnlyHint` follows the HTTP method, so a GET that writes to the workspace
    // would hand agents a read-only-looking tool that edits their repo (07-issues-agent-loop.md).
    write: oc
      .route({ method: 'POST', path: '/env/write', summary: 'Write .env.mocktown and the AGENTS.md section' })
      .input(z.object({ ...ProjectInput }))
      .output(EnvOutput),
  },

  sandbox: {
    get: oc
      .route({ method: 'GET', path: '/sandbox', summary: 'Whether the sealed boundary is up, and what it is made of' })
      .input(z.object({ ...ProjectInput }))
      .output(withProject(SandboxStatus.shape)),

    up: oc
      .route({ method: 'POST', path: '/sandbox/up', summary: 'Bring up the sealed network, the relay and the app container' })
      .input(
        z.object({
          ...ProjectInput,
          mode: z
            .enum(['sealed', 'record'])
            .default('sealed')
            .describe('`sealed` denies unknown hosts; `record` lets them out through the front door to build the corpus'),
          rebuild: z.boolean().optional().describe('Rebuild the images even if they exist — after a CA or base-image change'),
        }),
      )
      .output(withProject(SandboxStatus.shape)),

    down: oc
      .route({ method: 'POST', path: '/sandbox/down', summary: 'Tear the boundary down: containers and networks' })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ removed: z.array(z.string()) })),

    exec: oc
      .route({
        method: 'POST',
        path: '/sandbox/exec',
        summary: 'Run a command inside the boundary — the agent surface for flows and tests',
      })
      .input(z.object({ ...ProjectInput, command: z.string().describe('Shell command line, run in /workspace') }))
      .output(withProject({ ok: z.boolean(), exitCode: z.number().int(), stdout: z.string(), stderr: z.string() })),

    verify: oc
      .route({
        method: 'POST',
        path: '/sandbox/verify',
        summary: 'Prove the seal on this host: escape attempts against a negative control',
      })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          ok: z.boolean(),
          checks: z.array(SealCheck),
          inconclusive: z.number().int().describe('Checks that proved nothing either way — never counted as passes'),
          wallHitFiled: z.boolean().describe('Whether the deny-wall probe became an issue, as it must'),
        }),
      ),

    devcontainer: oc
      .route({
        method: 'POST',
        path: '/sandbox/devcontainer',
        summary: 'Generate the devcontainer feature that adds the boundary to an existing devcontainer',
      })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ files: z.array(z.string()), fragment: z.unknown() })),
  },

  seal: {
    get: oc
      .route({ method: 'GET', path: '/seal', summary: 'The latest seal stamp, and whether it still applies' })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          ok: z.boolean().describe('A current, passing stamp — what a CI step checks'),
          stamp: SealStamp.nullable(),
          stale: z.array(z.string()).describe('Why the stamp no longer applies, if it does not'),
          flows: z.array(z.string()),
          configHash: z.string(),
          commit: z.string().nullable(),
        }),
      ),

    verify: oc
      .route({
        method: 'POST',
        path: '/seal/verify',
        summary: 'Run the flows inside the sandbox and stamp the result — designed as a CI step',
      })
      .input(
        z.object({
          ...ProjectInput,
          flows: z.array(z.string()).optional().describe("Override mocktown.json's flow list for this run"),
          rebuild: z.boolean().optional(),
        }),
      )
      .output(
        withProject({
          ok: z.boolean(),
          sealed: z.boolean(),
          instrument: z
            .enum(['sandbox', 'none'])
            .describe('`none` means the run proved nothing: without the sandbox an escape is invisible, not absent'),
          commit: z.string().nullable(),
          configHash: z.string(),
          flows: z.array(z.object({ command: z.string(), exitCode: z.number().int(), durationMs: z.number().int(), output: z.string() })),
          wallHits: z.array(z.object({ host: z.string(), method: z.string(), path: z.string(), reason: z.string() })),
          gaps: z.array(z.object({ service: z.string(), rung: z.number().int().nullable(), instruction: z.string() })),
          servicesExercised: z.array(z.string()),
          reasons: z.array(z.string()),
          stamp: SealStamp.nullable(),
        }),
      ),
  },

  drift: {
    get: oc
      .route({ method: 'GET', path: '/drift', summary: 'Drift-watch schedule and the last run — has the mock rotted?' })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          enabled: z.boolean().describe('Whether the schedule runs. Off by default: a drift run calls the real services'),
          intervalHours: z.number().int(),
          services: z.array(z.string()).describe('Services that would be judged by a run right now'),
          flows: z.array(z.string()).describe('Commands the re-record runs; falls back to seal.flows'),
          nextRunAt: z.string().nullable().describe('Null when the schedule is off'),
          lastRun: DriftRun.nullable(),
          outstandingDriftIssues: z.number().int().describe('Open plus reopened provider-drift issues'),
        }),
      ),

    check: oc
      .route({
        method: 'POST',
        path: '/drift/check',
        summary: 'Re-record the flows against the REAL services and diff them against the mocks',
      })
      .input(
        z.object({
          ...ProjectInput,
          services: z.array(z.string()).optional().describe('Override the service list for this run'),
          flows: z.array(z.string()).optional().describe('Override the flow list for this run'),
        }),
      )
      .output(
        withProject({
          ok: z.boolean().describe('False when anything drifted, and also when the run could not judge what it claimed to'),
          runId: z.string(),
          session: z.string().nullable().describe('The recording session the re-record produced — the fresh evidence'),
          services: z.array(z.string()),
          flows: z.array(z.object({ command: z.string(), exitCode: z.number().int(), durationMs: z.number().int(), output: z.string() })),
          checked: z.number().int().describe('Fresh exchanges replayed against the providers'),
          findings: z.array(DriftFinding),
          reasons: z.array(z.string()).describe('Why this run judged less than it set out to'),
        }),
      ),
  },

  browser: {
    launch: oc
      .route({
        method: 'POST',
        path: '/browser/launch',
        summary: 'Launch a browser through the front door, trusting the project CA for this window only',
      })
      .input(
        z.object({
          ...ProjectInput,
          url: z.string().optional(),
          executable: z.string().optional().describe('Explicit browser binary, for one we do not know about'),
          debugPort: z
            .number()
            .int()
            .min(0)
            .max(65535)
            .optional()
            .describe('Expose CDP so a driver can attach to this window; 0 for an ephemeral port'),
        }),
      )
      .output(
        withProject({
          executable: z.string(),
          profileDir: z.string(),
          args: z.array(z.string()),
          spkiHash: z.string().describe('The one public key this window accepts beyond the system store'),
          pid: z.number().int().nullable(),
          debug: z
            .object({ port: z.number().int(), webSocketDebuggerUrl: z.string() })
            .nullable()
            .describe('The CDP endpoint, when one was asked for. A capability: it drives this browser without further auth'),
          note: z.string().describe('The host-browser gap: attended use does not carry the sandbox guarantee'),
        }),
      ),
  },

  skills: {
    list: oc
      .route({ method: 'GET', path: '/skills', summary: 'The prompt packs shipped with Mocktown for the recurring agent jobs' })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          skills: z.array(
            z.object({
              name: z.string(),
              version: z.string(),
              summary: z.string(),
              topics: z.array(z.string()).describe('The arguments this skill answers to — one file each'),
            }),
          ),
        }),
      ),

    get: oc
      .route({ method: 'GET', path: '/skills/{name}', summary: 'One file of a prompt pack — the entry by default, or one job' })
      .input(
        z.object({
          ...ProjectInput,
          name: z.string(),
          topic: z.string().optional().describe('The job to read, e.g. `generate-mock`. Omitted gives SKILL.md, which routes to the rest'),
        }),
      )
      .output(
        withProject({
          skill: z.object({
            name: z.string(),
            version: z.string(),
            summary: z.string(),
            topics: z.array(z.string()),
            file: z.string().describe('Which file of the pack this is'),
            body: z.string(),
          }),
        }),
      ),

    export: oc
      .route({ method: 'POST', path: '/skills/{name}/export', summary: 'Write a pack into the workspace, laid out for a skills installer' })
      .input(z.object({ ...ProjectInput, name: z.string() }))
      .output(
        withProject({
          dir: z.string().describe('The skill directory written. Its parent is what a skills installer is pointed at'),
          container: z.string().describe('The parent to hand an installer, so it discovers `<container>/<name>/SKILL.md`'),
          files: z.array(z.string()).describe('Absolute paths of everything written'),
        }),
      ),
  },

  ekb: {
    list: oc
      .route({ method: 'GET', path: '/ekb', summary: 'Endpoint knowledge base: how clients get pointed at each service' })
      .input(z.object({ ...ProjectInput, service: z.string().optional() }))
      .output(withProject({ entries: z.array(EkbEntry) })),

    add: oc
      .route({ method: 'PUT', path: '/ekb/{service}', summary: 'Record a redirect recipe — every generated mock must add its own' })
      .input(
        z.object({
          ...ProjectInput,
          service: z.string(),
          rung: z.coerce.number().int().min(1).max(3),
          envVar: z.string().optional(),
          language: z.string().optional(),
          snippet: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .output(withProject({ entry: EkbEntry })),
  },

  knobs: {
    get: oc
      .route({ method: 'GET', path: '/knobs/{service}', summary: 'Knob manifest and current values for a generated mock' })
      .input(z.object({ ...ProjectInput, service: z.string(), profile: z.string().optional() }))
      .output(withProject({ service: z.string(), knobs: z.array(KnobDescriptor) })),

    set: oc
      .route({ method: 'PUT', path: '/knobs/{service}', summary: 'Set knob values; the change is journaled so runs stay replayable' })
      .input(z.object({ ...ProjectInput, service: z.string(), values: z.record(z.string(), z.unknown()) }))
      .output(withProject({ service: z.string(), knobs: z.array(KnobDescriptor) })),
  },

  profiles: {
    list: oc
      .route({ method: 'GET', path: '/profiles', summary: 'The persona roster an agent picks a scenario from' })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ profiles: z.array(Profile) })),

    set: oc
      .route({ method: 'PUT', path: '/profiles/{name}', summary: 'Create or update an auth profile' })
      .input(
        z.object({
          ...ProjectInput,
          name: z.string(),
          description: z.string().describe('Must say how this persona differs from the others'),
          credentials: z.record(z.string(), z.string()).optional(),
          context: z.record(z.string(), z.string()).optional(),
          knobOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
          signIn: z.enum(['credentials', 'consent-picker', 'token-only']).optional(),
        }),
      )
      .output(withProject({ profile: Profile })),

    session: oc
      .route({
        method: 'POST',
        path: '/profiles/{name}/session',
        summary: 'Mint a ready-made token for API-level testing, skipping the login UI',
      })
      .input(z.object({ ...ProjectInput, name: z.string() }))
      .output(
        withProject({ profile: z.string(), token: z.string(), header: z.string().describe('Ready-to-send Authorization header value') }),
      ),
  },

  panels: {
    /**
     * 09-gui-plugins.md's plugin model. A listing, not a loader: the shell iframes `url`,
     * and a manifest that could not be read is reported in `problems` rather than dropped —
     * a panel that silently does not appear reads as a bug in the shell.
     */
    list: oc
      .route({ method: 'GET', path: '/panels', summary: 'Single-file HTML panels the GUI shell can iframe' })
      .input(z.object({ ...ProjectInput }))
      .output(
        withProject({
          dir: z.string().nullable().describe('The workspace panel directory, or null when the project has no workspace'),
          panels: z.array(Panel),
          problems: z.array(z.string()),
        }),
      ),
  },

  state: {
    /**
     * Across every provider at once, which is the question a dashboard and a panel index
     * ask. Counts only — a full dump per service could be enormous, and `state get` is one
     * call away. A service whose provider cannot introspect is listed with the reason
     * rather than omitted (06-emulation.md: gaps here are acceptable, silence is not).
     */
    list: oc
      .route({ method: 'GET', path: '/state', summary: 'State introspection across every running provider, as counts' })
      .input(z.object({ ...ProjectInput, profile: z.string().optional() }))
      .output(
        withProject({
          services: z.array(
            z.object({
              service: z.string(),
              provider: z.string().nullable(),
              introspectable: z.boolean(),
              collections: z.array(z.object({ name: z.string(), count: z.number().int() })),
              note: z.string().nullable(),
            }),
          ),
        }),
      ),

    get: oc
      .route({ method: 'GET', path: '/state/{service}', summary: 'Provider state introspection — backs the GUI panels' })
      .input(z.object({ ...ProjectInput, service: z.string(), profile: z.string().optional(), collection: z.string().optional() }))
      .output(
        withProject({
          service: z.string(),
          provider: z.string().describe('Which provider answered — introspection fidelity depends on it'),
          collections: z.array(StateCollection),
          note: z.string().nullable().describe('Set when introspection is best-effort, e.g. an emulate-backed service'),
        }),
      ),

    reset: oc
      .route({
        method: 'POST',
        path: '/state/reset',
        summary: 'Drop mutable state and re-apply seeds; closes the session and starts a new one',
      })
      .input(z.object({ ...ProjectInput, service: z.string().optional(), profile: z.string().optional() }))
      .output(withProject({ reset: z.array(z.string()), session: z.string(), restarted: z.array(z.string()) })),
  },
};

export type Contract = typeof contract;
