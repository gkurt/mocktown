/**
 * The API implementation, typed against the contract.
 *
 * These handlers are deliberately thin: everything with behavior lives in
 * `ProjectRuntime` and the modules it composes. That is what makes 02-architecture.md's
 * "no client has privileged access to anything" structural — the CLI and the MCP server
 * are HTTP clients of exactly this surface, so a capability that is not here does not
 * exist for any of them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ORPCError } from '@orpc/client';
import { implement } from '@orpc/server';
import { and, desc, eq } from 'drizzle-orm';
import { launchBrowser } from '#src/capture/browser.ts';
import { parseHar } from '#src/capture/har.ts';
import { endSession, Recorder, startSession } from '#src/capture/recorder.ts';
import { projectPaths } from '#src/config/paths.ts';
import { writeService } from '#src/config/services.ts';
import { settingsOf, writeSetting } from '#src/config/settings.ts';
import { contract } from '#src/contract/index.ts';
import type { ProviderRef, Service } from '#src/contract/schemas.ts';
import { runtimeFor } from '#src/daemon/runtime.ts';
import { schema } from '#src/db/client.ts';
import { checkDrift } from '#src/drift/watch.ts';
import { renderAgentsSection, renderEnvFile, writeAgentsSection } from '#src/env/generate.ts';
import { ensureProjectCa } from '#src/frontdoor/ca.ts';
import { listPanels, workspacePanelDir } from '#src/gui/panels.ts';
import { exportCorpus, inflateRecording, recordingsForService, routeTable } from '#src/mocks/corpus.ts';
import { scaffoldMock } from '#src/mocks/scaffold.ts';
import { buildSchemas, driftBetween, loadSchemas, type TypeNode, writeSchemaModule } from '#src/mocks/schema.ts';
import { verifyRecordings } from '#src/mocks/verify.ts';
import { writeDevcontainer } from '#src/sandbox/devcontainer.ts';
import { setKnobs } from '#src/scenario/knobs.ts';
import { listProfiles, mintProfileSession } from '#src/scenario/profiles.ts';
import { certifySeal } from '#src/seal/certify.ts';
import { configHash, currentCommit, latestStamp, stalenessOf } from '#src/seal/stamp.ts';
import { findSkill, SKILLS } from '#src/skills/index.ts';
import { id } from '#src/util/id.ts';

const os = implement(contract);

/**
 * The registry column is plain text so a provider ref can be added without a migration;
 * the contract's union is the schema of record. This cast is the single place the two
 * meet, and the API's own Zod validation rejects a row that does not conform.
 */
function toService(row: typeof schema.services.$inferSelect): Service {
  return {
    id: row.id,
    provider: row.provider as ProviderRef,
    seed: row.seed,
    aliases: row.aliases ?? [],
    discovered: row.discovered,
    lastSeenAt: row.lastSeenAt,
  };
}

function toIssue(row: typeof schema.issues.$inferSelect) {
  return { ...row };
}

export const router = os.router({
  status: {
    get: os.status.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const recordings = runtime.db.select().from(schema.recordings).all().length;
      const openIssues = runtime.issues.list({ status: 'open' }).length;
      const services = runtime.services().map(toService);

      // Provider failures only. Anything a reader cannot put right from here is not a
      // warning: the registry is `services`, and a decision someone owes is an issue.
      const warnings = runtime.providerStatuses().flatMap((p) => p.warnings);

      return {
        project: runtime.name,
        // The daemon is told the project by name, so only the caller knows how it got
        // there. An unlabelled call named the project explicitly, which is a flag.
        // The daemon only ever receives a project *name*; the surface that resolved it
        // says how. A surface that stays silent gets "unknown" rather than a guess —
        // misreported resolution is exactly the confusion 08-projects-config.md warns of.
        source: input.source ?? 'unknown',
        workspace: runtime.resolved.workspace,
        appUrl: runtime.resolved.file?.app?.url ?? null,
        frontDoor: runtime.frontDoorStatus(),
        services,
        providers: runtime.providerStatuses(),
        recordings,
        openIssues,
        session: runtime.session,
        warnings,
      };
    }),
  },

  /**
   * A long poll rather than a stream, so the feed is a normal procedure on all three
   * surfaces (see `daemon/events.ts` for the decision). A caller passes back the `cursor`
   * it last saw; a quiet project returns an empty list after `waitMs` and the caller asks
   * again with the same cursor.
   */
  feed: {
    tail: os.feed.tail.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      if (input.waitMs > 0) await runtime.feed.wait(input.since, input.waitMs);
      const window = runtime.feed.since(input.since, input.limit);

      return {
        project: runtime.name,
        // The cursor advances over the *unfiltered* window: a client watching one kind
        // must not be handed the same events again, nor park forever because the kind it
        // asked about happens to be quiet.
        cursor: window.reduce((max, event) => Math.max(max, event.seq), input.since),
        events: window.filter((event) => (!input.kind || event.kind === input.kind) && (!input.service || event.service === input.service)),
        // Honest about the window's edge: a client that fell behind is told, rather than
        // silently shown a feed with a hole in it.
        gap: input.since > 0 && input.since < runtime.feed.oldestSeq - 1,
      };
    }),
  },

  config: {
    get: os.config.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, file: runtime.resolved.paths?.projectFile ?? null, settings: settingsOf(runtime.resolved.file) };
    }),

    set: os.config.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const projectFile = runtime.resolved.paths?.projectFile;
      if (!projectFile)
        throw new ORPCError('BAD_REQUEST', {
          message: 'This project has no workspace, so it has no mocktown.json to edit. Run `mocktown init` in the repo first.',
        });

      let settings: ReturnType<typeof settingsOf>;
      try {
        settings = writeSetting(projectFile, input.key, input.value);
      } catch (error) {
        throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : String(error) });
      }
      // The file on disk is the source of truth, and the runtime is holding the old copy —
      // without this the caller reads back the value they just replaced.
      runtime.reload();
      return { project: runtime.name, file: projectFile, settings };
    }),
  },

  services: {
    list: os.services.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const services = runtime
        .services()
        .map(toService)
        .filter((s) => !input.provider || s.provider === input.provider);
      return { project: runtime.name, services };
    }),

    set: os.services.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      runtime.db
        .insert(schema.services)
        .values({ id: input.id, provider: input.provider, seed: input.seed ?? null, aliases: input.aliases ?? [], discovered: false })
        .onConflictDoUpdate({
          target: schema.services.id,
          // Omitting `--alias` leaves the aliases alone; `--alias ''` is how you clear them.
          set: {
            provider: input.provider,
            seed: input.seed ?? null,
            ...(input.aliases ? { aliases: input.aliases } : {}),
            discovered: false,
          },
        })
        .run();
      const row = runtime.db.select().from(schema.services).where(eq(schema.services.id, input.id)).get()!;

      // The database decides how this run behaves; the file is how the decision travels. A
      // workspace-less project has nowhere to put it, and that is worth saying rather than
      // reporting a write that did not happen.
      const projectFile = runtime.resolved.paths?.projectFile ?? null;
      if (projectFile) {
        try {
          writeService(projectFile, input.id, { provider: input.provider, seed: input.seed, aliases: input.aliases ?? row.aliases });
        } catch (error) {
          throw new ORPCError('BAD_REQUEST', { message: error instanceof Error ? error.message : String(error) });
        }
        runtime.reload();
      }
      return { project: runtime.name, service: toService(row), file: projectFile };
    }),
  },

  recordings: {
    list: os.recordings.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const conditions = [
        ...(input.service ? [eq(schema.recordings.service, input.service)] : []),
        ...(input.method ? [eq(schema.recordings.method, input.method.toUpperCase())] : []),
        ...(input.session ? [eq(schema.recordings.sessionId, input.session)] : []),
      ];
      const base = runtime.db.select().from(schema.recordings);
      const filtered = conditions.length ? base.where(and(...conditions)) : base;
      const rows = filtered.orderBy(desc(schema.recordings.recordedAt)).limit(input.limit).offset(input.offset).all();
      const total = (
        conditions.length
          ? runtime.db
              .select()
              .from(schema.recordings)
              .where(and(...conditions))
          : runtime.db.select().from(schema.recordings)
      ).all().length;

      return { project: runtime.name, total, recordings: rows.map((row) => inflateRecording(runtime.name, row)) };
    }),

    get: os.recordings.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const row = runtime.db.select().from(schema.recordings).where(eq(schema.recordings.id, input.id)).get();
      if (!row) throw new ORPCError('NOT_FOUND', { message: `no recording "${input.id}"` });
      return { project: runtime.name, recording: inflateRecording(runtime.name, row), frames: socketFrames(runtime.db, row) };
    }),

    routes: os.recordings.routes.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, routes: routeTable(runtime.db, input.service) };
    }),
  },

  corpus: {
    export: os.corpus.export.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...exportCorpus(runtime.db, input.service, input.limitPerRoute) };
    }),
  },

  record: {
    start: os.record.start.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const started = await runtime.startRecord({ label: input.label, seed: input.seed });
      return { project: runtime.name, ...started };
    }),

    stop: os.record.stop.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.stopRecord()) };
    }),
  },

  serve: {
    start: os.serve.start.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const started = await runtime.startServe({ seed: input.seed, sealed: input.sealed });
      return { project: runtime.name, ...started, providers: runtime.providerStatuses() };
    }),

    stop: os.serve.stop.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.stopServe()) };
    }),
  },

  import: {
    har: os.import.har.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      if (!existsSync(input.path)) throw new ORPCError('NOT_FOUND', { message: `no such file: ${input.path}` });

      const { exchanges, skipped } = parseHar(readFileSync(input.path, 'utf8'));
      const session = startSession(runtime.db, 'import', { label: input.label ?? input.path });
      // Imported exchanges run through the same scrubber and land in the same corpus
      // (03-capture.md), so downstream cannot tell a HAR row from a front-door one.
      const recorder = new Recorder(runtime.db, runtime.name, runtime.currentScrubber, session);
      const services = new Set<string>();
      for (const exchange of exchanges) {
        const row = recorder.record(exchange, 'har');
        if (row) services.add(row.service);
      }
      endSession(runtime.db, session);

      return { project: runtime.name, session, imported: exchanges.length, skipped, services: [...services] };
    }),
  },

  scrub: {
    audit: os.scrub.audit.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const rows = (
        input.service
          ? runtime.db.select().from(schema.recordings).where(eq(schema.recordings.service, input.service))
          : runtime.db.select().from(schema.recordings)
      ).all();

      const findings = runtime.currentScrubber.audit(
        rows.map((row) => {
          const recording = inflateRecording(runtime.name, row);
          return {
            id: row.id,
            method: row.method,
            url: `https://${row.service}${row.path}`,
            statusCode: row.statusCode,
            requestHeaders: row.requestHeaders,
            responseHeaders: row.responseHeaders,
            requestBody: recording.requestBody ?? '',
            responseBody: recording.responseBody ?? '',
          };
        }),
      );

      return {
        project: runtime.name,
        scanned: rows.length,
        findings: findings.map((f) => ({ recordingId: f.exchangeId, where: f.where, kind: f.kind, sample: f.sample })),
      };
    }),
  },

  issues: {
    list: os.issues.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return {
        project: runtime.name,
        issues: runtime.issues.list({ status: input.status, type: input.type, service: input.service, batch: input.batch }).map(toIssue),
      };
    }),

    get: os.issues.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const issue = runtime.issues.get(input.id);
      if (!issue) throw new ORPCError('NOT_FOUND', { message: `no issue "${input.id}"` });
      return { project: runtime.name, issue: toIssue(issue) };
    }),

    /**
     * Resolution is incremental and *verified*: the daemon replays the triggering
     * requests against the patched mock, and only a passing replay closes the issue
     * (07-issues-agent-loop.md). A failed verification reopens it with the diff attached.
     */
    resolve: os.issues.resolve.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const issue = runtime.issues.get(input.id);
      if (!issue) throw new ORPCError('NOT_FOUND', { message: `no issue "${input.id}"` });

      // Some issue types have nothing to replay — a pinned client never reaches a mock, and
      // an undeclared service is answered in mocktown.json rather than by a request.
      const unverifiable = issue.type === 'pinned-client' || issue.type === 'redirect-gap' || issue.type === 'undeclared-service';
      if (input.skipVerify || unverifiable) {
        runtime.issues.setStatus(
          input.id,
          'resolved',
          input.note ?? (unverifiable ? 'closed without replay: this issue type has no request to replay' : undefined),
        );
        return { project: runtime.name, issue: toIssue(runtime.issues.get(input.id)!), verified: false, verification: null };
      }

      const baseUrl = runtime.baseUrlFor(issue.service);
      if (!baseUrl) {
        throw new ORPCError('CONFLICT', {
          message: `no provider is running for "${issue.service}", so the fix cannot be verified. Start one with \`mocktown serve start\` and resolve again.`,
        });
      }

      runtime.issues.setStatus(input.id, 'verifying');
      const recordings = recordingsForService(runtime.db, issue.service, undefined, 1000, issue.pathTemplate ?? undefined).map((row) =>
        inflateRecording(runtime.name, row),
      );

      // The same schema `mocks verify` uses. Closing an issue used to judge the exchange
      // without it, so one exchange could pass one command and fail the other — and it was
      // the stricter, corpus-only judgement that gated the queue.
      const issueMocksDir = runtime.resolved.paths?.mocksDir;
      let issueSchemas = null;
      if (issueMocksDir) {
        try {
          issueSchemas = await loadSchemas(issueMocksDir, issue.service);
        } catch (error) {
          throw new ORPCError('CONFLICT', {
            message: `the checked-in schema for "${issue.service}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }

      const result = await verifyRecordings(
        recordings,
        { baseUrl, service: issue.service, schemas: issueSchemas },
        runtime.currentScrubber,
      );
      // An empty replay is not a passing replay. Closing an issue on zero evidence is worse
      // than leaving it open, because the queue then reads as work that was actually done.
      // Counted from what was actually judged, so a set that was entirely sockets or
      // entirely exempted cannot close an issue by having nothing to say about it.
      const judged = result.passed + result.failed;
      const passed = judged > 0 && result.failed === 0;
      const route = `${issue.method ?? ''} ${issue.pathTemplate ?? issue.path ?? ''}`.trim();
      // An empty replay means the corpus holds no recording of this route — which is often
      // the whole reason the issue exists, the app having called something the recording
      // session never reached. Replay cannot confirm a fix for a route it has no evidence
      // of, and saying only that the replay was empty sends someone hunting for a recording
      // that does not exist. Keyed on what the replay found rather than on the issue's type:
      // the type says what went wrong, not whether there is anything to replay.
      const reason =
        judged > 0
          ? `verification failed: ${result.failed}/${judged} replayed requests did not match`
          : `nothing to replay for ${route}: the corpus holds no recording of it, so replay cannot confirm the fix. ` +
            `Prove it with \`mocktown mocks verify --service ${issue.service}\` — which checks the routes that *are* recorded still pass — ` +
            'then close this with `--skip-verify` and a note saying what the fix was written against.';
      runtime.issues.setStatus(input.id, passed ? 'resolved' : 'reopened', passed ? input.note : reason);

      return { project: runtime.name, issue: toIssue(runtime.issues.get(input.id)!), verified: passed, verification: result };
    }),
  },

  providers: {
    list: os.providers.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, providers: runtime.providerStatuses() };
    }),

    restart: os.providers.restart.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const provider = runtime.providerStatuses().find((p) => p.name === input.name);
      if (!provider) throw new ORPCError('NOT_FOUND', { message: `no running provider named "${input.name}"` });
      await runtime.resetState({});
      const after = runtime.providerStatuses().find((p) => p.name === input.name)!;
      return { project: runtime.name, provider: after };
    }),
  },

  mocks: {
    verify: os.mocks.verify.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const baseUrl = runtime.baseUrlFor(input.service);
      if (!baseUrl) {
        throw new ORPCError('CONFLICT', {
          message: `no provider is running for "${input.service}". Run \`mocktown serve start\` first.`,
        });
      }
      const recordings = recordingsForService(runtime.db, input.service, input.session, input.limit).map((row) =>
        inflateRecording(runtime.name, row),
      );
      // A schema the author checked in outranks the corpus. A broken one must not be
      // swallowed into "no schema", though — that would silently demote every route back
      // to single-recording comparison and look like a passing run.
      const mocksDir = runtime.resolved.paths?.mocksDir;
      let schemas = null;
      if (mocksDir) {
        try {
          schemas = await loadSchemas(mocksDir, input.service);
        } catch (error) {
          throw new ORPCError('CONFLICT', {
            message: `the checked-in schema for "${input.service}" could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      const result = await verifyRecordings(recordings, { baseUrl, service: input.service, schemas }, runtime.currentScrubber);

      // A failing replay is evidence, so it becomes work rather than console output.
      for (const failure of result.failures) {
        runtime.issues.file({
          type: 'state-violation',
          service: input.service,
          method: failure.method,
          path: failure.path,
          pathTemplate: failure.pathTemplate,
          sessionId: runtime.session,
          request: { method: failure.method, path: failure.path },
          diagnosis: {
            reason: failure.reason,
            diff: failure.diff,
            expectedStatus: failure.expectedStatus,
            actualStatus: failure.actualStatus,
          },
          suggestedResolution: `Replay of recording ${failure.recordingId} did not match. ${failure.reason}`,
          links: [`mocktown recordings get --id ${failure.recordingId}`],
        });
      }

      return { project: runtime.name, result };
    }),

    scaffold: os.mocks.scaffold.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const paths = runtime.resolved.paths;
      if (!paths) {
        throw new ORPCError('CONFLICT', {
          message: 'scaffolding writes into the repo, so it needs a workspace. Run `mocktown init` in the repo first.',
        });
      }
      const corpus = exportCorpus(runtime.db, input.service, 5);
      if (corpus.routes.length === 0) {
        throw new ORPCError('CONFLICT', {
          message: `no recordings for "${input.service}" — record some traffic first, or import a HAR file.`,
        });
      }
      mkdirSync(paths.mocksDir, { recursive: true });
      const { files, brief } = scaffoldMock(paths.mocksDir, corpus, { force: input.force });
      return { project: runtime.name, service: input.service, files, brief };
    }),

    schema: os.mocks.schema.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const paths = runtime.resolved.paths;
      if (!paths) {
        throw new ORPCError('CONFLICT', {
          message: 'the schema is checked into the repo, so it needs a workspace. Run `mocktown init` in the repo first.',
        });
      }
      // Inference reads whole bodies, so it has to come through `inflateRecording`: a
      // large response is content-addressed in `blobs/` and the stored row's body is null.
      // Reading the rows raw would infer a schema from the small responses only.
      const rows = recordingsForService(runtime.db, input.service, undefined, input.limit).map((row) =>
        inflateRecording(runtime.name, row),
      );
      // The scrubber's field rules are a pure function of the field name, so the same
      // question can be asked now: which of these fields had their values replaced before
      // they ever reached disk. The answer goes in the file as a comment, because the rule
      // is weak evidence — `totalTokens` matches `token` — and the call is the author's.
      const scrubber = runtime.currentScrubber;
      const note = (field: string, type: TypeNode) => {
        const rule = scrubber.fieldRule(field);
        if (!rule) return undefined;
        // Only a primitive was ever replaced. `tokenUsage` matches the `token` rule by name
        // but is an object the scrubber walked straight through, and marking the container
        // as well as its leaves is noise on the line above the one that matters.
        const kinds = type.kind === 'union' ? type.options.map((option) => option.kind) : [type.kind];
        if (!kinds.every((kind) => kind === 'string' || kind === 'number' || kind === 'null')) return undefined;
        // A string here is a `{{secret:…}}` placeholder, and a placeholder is not evidence
        // of the field's type: captures taken before numeric redaction turned counts into
        // strings, which is how a mock ends up returning `"4096"` for a token total.
        return kinds.includes('string')
          ? `scrubbed as \`${rule.kind}\`: a placeholder — confirm the type, older captures turned numbers into strings`
          : `scrubbed as \`${rule.kind}\`: the value is a stub, the type is real`;
      };
      const entries = buildSchemas(
        rows
          .filter((row) => row.kind === 'http')
          .map((row) => ({
            method: row.method,
            pathTemplate: row.pathTemplate,
            statusCode: row.statusCode,
            body: row.responseBody,
          })),
        note,
      );
      if (entries.length === 0) {
        throw new ORPCError('CONFLICT', {
          message: `no JSON responses recorded for "${input.service}" — record some traffic first, or import a HAR file.`,
        });
      }
      const routes = entries.map((entry) => ({ route: entry.route, statusCode: entry.statusCode, observations: entry.observations }));

      if (input.check) {
        const checkedIn = await loadSchemas(paths.mocksDir, input.service);
        if (!checkedIn) {
          throw new ORPCError('CONFLICT', {
            message: `no schema is checked in for "${input.service}" — there is nothing to check against. Run \`mocktown mocks schema --service ${input.service}\` to draft one.`,
          });
        }
        const drift = driftBetween(checkedIn, entries);
        return {
          project: runtime.name,
          service: input.service,
          file: join(paths.mocksDir, input.service, 'schema.ts'),
          written: false,
          checked: true,
          ok: drift.length === 0,
          recordings: rows.length,
          routes,
          drift,
        };
      }

      mkdirSync(join(paths.mocksDir, input.service), { recursive: true });
      const { file, written, reason } = writeSchemaModule(paths.mocksDir, input.service, entries, { force: input.force });
      return {
        project: runtime.name,
        service: input.service,
        file,
        written,
        checked: false,
        ok: true,
        ...(reason ? { reason } : {}),
        recordings: rows.length,
        routes,
        drift: [],
      };
    }),
  },

  env: {
    get: os.env.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...runtime.envArtifacts(), written: [], notes: [] };
    }),

    write: os.env.write.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const artifacts = runtime.envArtifacts();
      const paths = runtime.resolved.paths;
      if (!paths)
        throw new ORPCError('BAD_REQUEST', {
          message: 'This project has no workspace, so there is nowhere to write. Run `mocktown init` in the repo first.',
        });

      writeFileSync(paths.envFile, renderEnvFile(runtime.name, artifacts.variables));
      // AGENTS.md is committed and hand-written, so touching it is opt-in. The alternative
      // to saying so here is a caller who thinks the section was written and cannot see why
      // their agent never read it.
      const agentsFile = runtime.resolved.file?.env?.agentsFile ?? false;
      const written = [
        paths.envFile,
        ...(agentsFile ? [writeAgentsSection(paths.root, renderAgentsSection(runtime.name, artifacts.agentTasks, artifacts.report))] : []),
      ];
      const notes = agentsFile
        ? []
        : [
            'AGENTS.md was not touched. `mocktown config set --key env.agentsFile --value true` lets `env write` maintain its section there.',
          ];
      return { project: runtime.name, ...artifacts, written, notes };
    }),

    portless: {
      get: os.env.portless.get.handler(({ input }) => {
        const runtime = runtimeFor(input.project);
        return { project: runtime.name, ...runtime.portlessStatus() };
      }),

      sync: os.env.portless.sync.handler(async ({ input }) => {
        const runtime = runtimeFor(input.project);
        return { project: runtime.name, ...(await runtime.syncPortless()) };
      }),
    },
  },

  sandbox: {
    get: os.sandbox.get.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.sandboxStatus()) };
    }),

    up: os.sandbox.up.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.sandboxUp({ mode: input.mode, rebuild: input.rebuild })) };
    }),

    down: os.sandbox.down.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.sandboxDown()) };
    }),

    exec: os.sandbox.exec.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const result = await runtime.sandboxExec(input.command);
      return { project: runtime.name, ok: result.exitCode === 0, ...result };
    }),

    /**
     * The deny-wall probe is only half a check. 04-sandbox.md's guarantee is that *every
     * escape attempt is evidence*, so the issue the probe should have filed is confirmed
     * here — a wall that denies silently would pass the network checks and still break the
     * loop the product is built around.
     */
    verify: os.sandbox.verify.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const result = await runtime.sandboxVerify();
      const wallHitFiled = result.probedHost ? runtime.issues.list({}).some((issue) => issue.service === result.probedHost) : false;
      const checks = result.probedHost
        ? [
            ...result.checks,
            {
              name: 'The denied request became an issue',
              status: (wallHitFiled ? 'pass' : 'fail') as 'pass' | 'fail',
              detail: wallHitFiled
                ? `filed against ${result.probedHost}`
                : 'the request was denied but nothing was filed, so the escape left no evidence',
            },
          ]
        : result.checks;

      return {
        project: runtime.name,
        ok: checks.every((check) => check.status !== 'fail'),
        checks,
        inconclusive: checks.filter((check) => check.status === 'inconclusive').length,
        wallHitFiled,
      };
    }),

    devcontainer: os.sandbox.devcontainer.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const paths = runtime.resolved.paths;
      if (!paths) {
        throw new ORPCError('CONFLICT', {
          message: 'the devcontainer files are written into the repo, so this needs a workspace. Run `mocktown init` there first.',
        });
      }
      const status = await runtime.sandboxStatus();
      if (!status.running || !status.network || !status.relayIp) {
        throw new ORPCError('CONFLICT', {
          message:
            'the generated devcontainer joins the sealed network by name, so the sandbox has to be up to name it. ' +
            'Run `mocktown sandbox up` first.',
        });
      }
      const ca = await ensureProjectCa(runtime.name);
      const artifacts = writeDevcontainer(paths.root, {
        project: runtime.name,
        caCert: ca.cert,
        browser: status.browser,
        network: status.network,
        relayIp: status.relayIp,
      });
      return { project: runtime.name, ...artifacts };
    }),
  },

  seal: {
    get: os.seal.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const stamp = latestStamp(runtime.db);
      const flows = runtime.resolved.file?.seal.flows ?? [];
      const current = {
        commit: currentCommit(runtime.resolved.workspace),
        configHash: configHash({
          services: Object.fromEntries(runtime.services().map((s) => [s.id, s.provider])),
          envVars: Object.keys(runtime.envArtifacts().variables),
          flows,
        }),
      };
      const stale = stalenessOf(stamp, current);
      return {
        project: runtime.name,
        // A stale stamp is not a pass. Treating "sealed once, against a different
        // configuration" as sealed is how a new dependency reaches production behind a
        // green CI check (05-redirection.md).
        ok: Boolean(stamp?.sealed) && stale.length === 0,
        stamp,
        stale,
        flows,
        ...current,
      };
    }),

    verify: os.seal.verify.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await certifySeal(runtime, { flows: input.flows, rebuild: input.rebuild })) };
    }),
  },

  drift: {
    get: os.drift.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const config = runtime.resolved.file?.drift ?? { enabled: false, intervalHours: 24, services: [], flows: [] };
      const last = runtime.db.select().from(schema.driftRuns).orderBy(desc(schema.driftRuns.startedAt)).limit(1).get() ?? null;

      return {
        project: runtime.name,
        enabled: config.enabled,
        intervalHours: config.intervalHours,
        services: driftTargets(runtime, config.services),
        flows: config.flows.length ? config.flows : (runtime.resolved.file?.seal.flows ?? []),
        // Computed from the last run rather than from a timer, so it survives a daemon
        // restart and says something true even when the scheduler is not running.
        nextRunAt: config.enabled ? nextRunAt(last?.startedAt ?? null, config.intervalHours) : null,
        lastRun: last ? { ...last } : null,
        openDriftIssues: runtime.issues.list({ status: 'open', type: 'provider-drift' }).length,
      };
    }),

    /**
     * The one procedure in the contract that deliberately talks to the real internet, so
     * the summary says so and the CLI renderer repeats it. `ok: false` covers both "the
     * mock rotted" and "this run could not judge what it set out to" — a drift check that
     * recorded nothing is not a pass.
     */
    check: os.drift.check.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const result = await checkDrift(runtime, { services: input.services, flows: input.flows, trigger: 'manual' });
      return {
        project: runtime.name,
        ok: result.ok,
        runId: result.runId,
        session: result.session,
        services: result.services,
        flows: result.flows,
        checked: result.checked,
        findings: result.findings,
        reasons: result.reasons,
      };
    }),
  },

  browser: {
    launch: os.browser.launch.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      const frontDoor = runtime.frontDoorStatus();
      if (!frontDoor.running || !frontDoor.port) {
        throw new ORPCError('CONFLICT', {
          message:
            'the launched browser points at the front door, which is not running. Start it with `mocktown record start` ' +
            'to capture what the browser does, or `mocktown serve start` to browse against mocks.',
        });
      }
      const ca = await ensureProjectCa(runtime.name);
      const launched = await launchBrowser({
        proxyUrl: `http://127.0.0.1:${frontDoor.port}`,
        caCert: ca.cert,
        profileDir: projectPaths(runtime.name).browserProfile,
        url: input.url,
        executable: input.executable,
        debugPort: input.debugPort,
      });
      return {
        project: runtime.name,
        ...launched,
        note:
          'This window is outside the sandbox boundary, so its traffic is captured cooperatively and best-effort. ' +
          'Only the sandbox carries the no-egress guarantee (04-sandbox.md).',
      };
    }),
  },

  skills: {
    list: os.skills.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, skills: SKILLS.map(({ name, version, summary }) => ({ name, version, summary })) };
    }),

    get: os.skills.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const skill = findSkill(input.name);
      if (!skill) {
        throw new ORPCError('NOT_FOUND', { message: `no skill "${input.name}" — available: ${SKILLS.map((s) => s.name).join(', ')}` });
      }
      return { project: runtime.name, skill };
    }),
  },

  ekb: {
    list: os.ekb.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const rows = (
        input.service
          ? runtime.db.select().from(schema.ekb).where(eq(schema.ekb.service, input.service))
          : runtime.db.select().from(schema.ekb)
      ).all();
      return { project: runtime.name, entries: rows.map((row) => ({ ...row })) };
    }),

    add: os.ekb.add.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const entryId = id('ekb');
      runtime.db
        .insert(schema.ekb)
        .values({
          id: entryId,
          service: input.service,
          rung: input.rung,
          envVar: input.envVar ?? null,
          language: input.language ?? null,
          snippet: input.snippet ?? null,
          note: input.note ?? null,
          source: 'user',
        })
        .run();
      const row = runtime.db.select().from(schema.ekb).where(eq(schema.ekb.id, entryId)).get()!;
      return { project: runtime.name, entry: { ...row } };
    }),
  },

  knobs: {
    get: os.knobs.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return {
        project: runtime.name,
        service: input.service,
        knobs: runtime.describeKnobsFor(input.service, input.profile ?? 'default'),
      };
    }),

    set: os.knobs.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const manifest = runtime.knobManifest(input.service);
      if (!manifest) {
        throw new ORPCError('CONFLICT', {
          message: `no running mock for "${input.service}" declares knobs. Start it with \`mocktown serve start\`.`,
        });
      }
      const { rejected } = setKnobs(runtime.db, manifest, input.service, input.values, runtime.session ?? 'no-session');
      if (rejected.length > 0) {
        throw new ORPCError('BAD_REQUEST', {
          message: rejected.map((r) => `${r.key}: ${r.reason}`).join('; '),
        });
      }
      return { project: runtime.name, service: input.service, knobs: runtime.describeKnobsFor(input.service, 'default') };
    }),
  },

  profiles: {
    list: os.profiles.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, profiles: listProfiles(runtime.db).map((p) => ({ ...p })) };
    }),

    set: os.profiles.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      runtime.db
        .insert(schema.profiles)
        .values({
          name: input.name,
          description: input.description,
          credentials: input.credentials ?? {},
          context: input.context ?? {},
          knobOverrides: input.knobOverrides ?? {},
          signIn: input.signIn ?? 'credentials',
        })
        .onConflictDoUpdate({
          target: schema.profiles.name,
          set: {
            description: input.description,
            ...(input.credentials ? { credentials: input.credentials } : {}),
            ...(input.context ? { context: input.context } : {}),
            ...(input.knobOverrides ? { knobOverrides: input.knobOverrides } : {}),
            ...(input.signIn ? { signIn: input.signIn } : {}),
          },
        })
        .run();
      const row = runtime.db.select().from(schema.profiles).where(eq(schema.profiles.name, input.name)).get()!;
      return { project: runtime.name, profile: { ...row } };
    }),

    session: os.profiles.session.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const minted = mintProfileSession(runtime.db, input.name, runtime.session ?? startSession(runtime.db, 'serve'));
      return { project: runtime.name, profile: input.name, ...minted };
    }),
  },

  panels: {
    list: os.panels.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, dir: workspacePanelDir(runtime.resolved.workspace), ...listPanels(runtime.resolved.workspace) };
    }),
  },

  state: {
    list: os.state.list.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, services: await runtime.stateOverview(input.profile) };
    }),

    get: os.state.get.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      if (!runtime.providerFor(input.service)) {
        throw new ORPCError('NOT_FOUND', {
          message: `no running provider serves "${input.service}". Run \`mocktown serve start\` first.`,
        });
      }
      const snapshot = await runtime.stateFor(input.service, { profile: input.profile, collection: input.collection });
      return { project: runtime.name, service: input.service, ...snapshot };
    }),

    reset: os.state.reset.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.resetState({ service: input.service, profile: input.profile })) };
    }),
  },
});

export type Router = typeof router;

/**
 * A WebSocket recording's frames, in order. Empty for every other kind, which is why this
 * is a lookup rather than a column on the row (03-capture.md).
 */
function socketFrames(db: ReturnType<typeof runtimeFor>['db'], row: typeof schema.recordings.$inferSelect) {
  if (row.kind !== 'websocket') return [];
  return db
    .select()
    .from(schema.socketFrames)
    .where(eq(schema.socketFrames.recordingId, row.id))
    .orderBy(schema.socketFrames.ordinal)
    .all()
    .map((frame) => ({
      ordinal: frame.ordinal,
      direction: frame.direction,
      encoding: frame.encoding,
      body: frame.body,
      atMs: frame.atMs,
    }));
}

/** What a drift run would judge right now: the configured list, or every mocked service. */
function driftTargets(runtime: ReturnType<typeof runtimeFor>, configured: string[]): string[] {
  if (configured.length) return configured;
  return runtime
    .services()
    .filter((service) => service.provider.startsWith('emulator:') || service.provider.startsWith('generated:'))
    .map((service) => service.id);
}

function nextRunAt(lastStartedAt: string | null, intervalHours: number): string {
  const base = lastStartedAt ? new Date(lastStartedAt).getTime() : Date.now();
  return new Date(base + intervalHours * 3600_000).toISOString();
}
