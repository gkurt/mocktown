/**
 * The API implementation, typed against the contract.
 *
 * These handlers are deliberately thin: everything with behavior lives in
 * `ProjectRuntime` and the modules it composes. That is what makes 02-architecture.md's
 * "no client has privileged access to anything" structural — the CLI and the MCP server
 * are HTTP clients of exactly this surface, so a capability that is not here does not
 * exist for any of them.
 */
import { readFileSync } from "node:fs";
import { existsSync, mkdirSync } from "node:fs";
import { and, desc, eq } from "drizzle-orm";
import { implement } from "@orpc/server";
import { ORPCError } from "@orpc/client";
import { contract } from "../contract/index.ts";
import { schema } from "../db/client.ts";
import { runtimeFor } from "./runtime.ts";
import { projectPaths } from "../config/paths.ts";
import { exportCorpus, recordingsForService, routeTable } from "../mocks/corpus.ts";
import { scaffoldMock } from "../mocks/scaffold.ts";
import { verifyRecordings } from "../mocks/verify.ts";
import { parseHar } from "../capture/har.ts";
import { Recorder, endSession, startSession } from "../capture/recorder.ts";
import { listProfiles, mintProfileSession } from "../scenario/profiles.ts";
import { setKnobs } from "../scenario/knobs.ts";
import { generateEnv, renderAgentsSection, renderEnvFile, writeAgentsSection } from "../env/generate.ts";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { id } from "../util/id.ts";
import { SKILLS, findSkill } from "../skills/index.ts";
import type { ProviderRef, Recording, Service } from "../contract/schemas.ts";

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
    discovered: row.discovered,
    lastSeenAt: row.lastSeenAt,
  };
}

/** A stored recording, with any spilled body read back from `blobs/`. */
function toRecording(project: string, row: typeof schema.recordings.$inferSelect): Recording {
  const blobDir = projectPaths(project).blobs;
  const readBlob = (hash: string | null) => {
    if (!hash) return null;
    const path = join(blobDir, hash);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  };
  return {
    ...row,
    requestBody: row.requestBody ?? readBlob(row.requestBlob),
    responseBody: row.responseBody ?? readBlob(row.responseBlob),
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
      const openIssues = runtime.issues.list({ status: "open" }).length;
      const services = runtime.services().map(toService);

      const warnings = [
        ...runtime.providerStatuses().flatMap((p) => p.warnings),
        // Silent passthroughs are forbidden (06-emulation.md), so every one is announced.
        ...services.filter((s) => s.provider === "passthrough")
          .map((s) => `${s.id} is set to passthrough: its traffic goes to the real service and is not recorded.`),
        ...services.filter((s) => s.discovered)
          .map((s) => `${s.id} was discovered from traffic and is not in mocktown.json. Add it to commit the decision.`),
      ];

      return {
        project: runtime.name,
        // The daemon is told the project by name, so only the caller knows how it got
        // there. An unlabelled call named the project explicitly, which is a flag.
        // The daemon only ever receives a project *name*; the surface that resolved it
        // says how. A surface that stays silent gets "unknown" rather than a guess —
        // misreported resolution is exactly the confusion 08-projects-config.md warns of.
        source: input.source ?? "unknown",
        workspace: runtime.resolved.workspace,
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

  services: {
    list: os.services.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const services = runtime.services()
        .map(toService)
        .filter((s) => !input.provider || s.provider === input.provider);
      return { project: runtime.name, services };
    }),

    set: os.services.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      runtime.db.insert(schema.services)
        .values({ id: input.id, provider: input.provider, seed: input.seed ?? null, discovered: false })
        .onConflictDoUpdate({
          target: schema.services.id,
          set: { provider: input.provider, seed: input.seed ?? null, discovered: false },
        })
        .run();
      const row = runtime.db.select().from(schema.services).where(eq(schema.services.id, input.id)).get()!;
      return { project: runtime.name, service: toService(row) };
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
      const total = (conditions.length
        ? runtime.db.select().from(schema.recordings).where(and(...conditions))
        : runtime.db.select().from(schema.recordings)).all().length;

      return { project: runtime.name, total, recordings: rows.map((row) => toRecording(runtime.name, row)) };
    }),

    get: os.recordings.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const row = runtime.db.select().from(schema.recordings).where(eq(schema.recordings.id, input.id)).get();
      if (!row) throw new ORPCError("NOT_FOUND", { message: `no recording "${input.id}"` });
      return { project: runtime.name, recording: toRecording(runtime.name, row) };
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
      if (!existsSync(input.path)) throw new ORPCError("NOT_FOUND", { message: `no such file: ${input.path}` });

      const { exchanges, skipped } = parseHar(readFileSync(input.path, "utf8"));
      const session = startSession(runtime.db, "import", { label: input.label ?? input.path });
      // Imported exchanges run through the same scrubber and land in the same corpus
      // (03-capture.md), so downstream cannot tell a HAR row from a front-door one.
      const recorder = new Recorder(runtime.db, runtime.name, runtime.currentScrubber, session);
      const services = new Set<string>();
      for (const exchange of exchanges) {
        const row = recorder.record(exchange, "har");
        if (row) services.add(row.service);
      }
      endSession(runtime.db, session);

      return { project: runtime.name, session, imported: exchanges.length, skipped, services: [...services] };
    }),
  },

  scrub: {
    audit: os.scrub.audit.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const rows = (input.service
        ? runtime.db.select().from(schema.recordings).where(eq(schema.recordings.service, input.service))
        : runtime.db.select().from(schema.recordings)).all();

      const findings = runtime.currentScrubber.audit(rows.map((row) => {
        const recording = toRecording(runtime.name, row);
        return {
          id: row.id, method: row.method, url: `https://${row.service}${row.path}`, statusCode: row.statusCode,
          requestHeaders: row.requestHeaders, responseHeaders: row.responseHeaders,
          requestBody: recording.requestBody ?? "", responseBody: recording.responseBody ?? "",
        };
      }));

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
      if (!issue) throw new ORPCError("NOT_FOUND", { message: `no issue "${input.id}"` });
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
      if (!issue) throw new ORPCError("NOT_FOUND", { message: `no issue "${input.id}"` });

      // Some issue types have nothing to replay — a pinned client never reaches a mock.
      const unverifiable = issue.type === "pinned-client" || issue.type === "redirect-gap";
      if (input.skipVerify || unverifiable) {
        runtime.issues.setStatus(input.id, "resolved", input.note ?? (unverifiable ? "closed without replay: this issue type has no request to replay" : undefined));
        return { project: runtime.name, issue: toIssue(runtime.issues.get(input.id)!), verified: false, verification: null };
      }

      const baseUrl = runtime.baseUrlFor(issue.service);
      if (!baseUrl) {
        throw new ORPCError("CONFLICT", {
          message: `no provider is running for "${issue.service}", so the fix cannot be verified. Start one with \`mocktown serve start\` and resolve again.`,
        });
      }

      runtime.issues.setStatus(input.id, "verifying");
      const recordings = recordingsForService(runtime.db, issue.service, undefined, 100)
        .filter((row) => !issue.pathTemplate || row.pathTemplate === issue.pathTemplate)
        .map((row) => toRecording(runtime.name, row));

      const result = await verifyRecordings(recordings, { baseUrl, service: issue.service }, runtime.currentScrubber);
      const passed = result.failed === 0;
      runtime.issues.setStatus(
        input.id,
        passed ? "resolved" : "reopened",
        passed ? input.note : `verification failed: ${result.failed}/${result.total} replayed requests did not match`,
      );

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
      if (!provider) throw new ORPCError("NOT_FOUND", { message: `no running provider named "${input.name}"` });
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
        throw new ORPCError("CONFLICT", {
          message: `no provider is running for "${input.service}". Run \`mocktown serve start\` first.`,
        });
      }
      const recordings = recordingsForService(runtime.db, input.service, input.session, input.limit)
        .map((row) => toRecording(runtime.name, row));
      const result = await verifyRecordings(recordings, { baseUrl, service: input.service }, runtime.currentScrubber);

      // A failing replay is evidence, so it becomes work rather than console output.
      for (const failure of result.failures) {
        runtime.issues.file({
          type: "state-violation",
          service: input.service,
          method: failure.method,
          path: failure.path,
          pathTemplate: failure.path,
          sessionId: runtime.session,
          request: { method: failure.method, path: failure.path },
          diagnosis: { reason: failure.reason, diff: failure.diff, expectedStatus: failure.expectedStatus, actualStatus: failure.actualStatus },
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
        throw new ORPCError("CONFLICT", {
          message: "scaffolding writes into the repo, so it needs a workspace. Run `mocktown init` in the repo first.",
        });
      }
      const corpus = exportCorpus(runtime.db, input.service, 5);
      if (corpus.routes.length === 0) {
        throw new ORPCError("CONFLICT", {
          message: `no recordings for "${input.service}" — record some traffic first, or import a HAR file.`,
        });
      }
      mkdirSync(paths.mocksDir, { recursive: true });
      const { files, brief } = scaffoldMock(paths.mocksDir, corpus, { force: input.force });
      return { project: runtime.name, service: input.service, files, brief };
    }),
  },

  env: {
    get: os.env.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...envArtifacts(runtime), written: [] };
    }),

    write: os.env.write.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const artifacts = envArtifacts(runtime);
      const paths = runtime.resolved.paths;
      if (!paths) throw new ORPCError("BAD_REQUEST", { message: "This project has no workspace, so there is nowhere to write. Run `mocktown init` in the repo first." });

      writeFileSync(paths.envFile, renderEnvFile(runtime.name, artifacts.variables));
      const written = [
        paths.envFile,
        writeAgentsSection(paths.root, renderAgentsSection(runtime.name, artifacts.agentTasks, artifacts.report)),
      ];
      return { project: runtime.name, ...artifacts, written };
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
        throw new ORPCError("NOT_FOUND", { message: `no skill "${input.name}" — available: ${SKILLS.map((s) => s.name).join(", ")}` });
      }
      return { project: runtime.name, skill };
    }),
  },

  ekb: {
    list: os.ekb.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const rows = (input.service
        ? runtime.db.select().from(schema.ekb).where(eq(schema.ekb.service, input.service))
        : runtime.db.select().from(schema.ekb)).all();
      return { project: runtime.name, entries: rows.map((row) => ({ ...row })) };
    }),

    add: os.ekb.add.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const entryId = id("ekb");
      runtime.db.insert(schema.ekb).values({
        id: entryId,
        service: input.service,
        rung: input.rung,
        envVar: input.envVar ?? null,
        language: input.language ?? null,
        snippet: input.snippet ?? null,
        note: input.note ?? null,
        source: "user",
      }).run();
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
        knobs: runtime.describeKnobsFor(input.service, input.profile ?? "default"),
      };
    }),

    set: os.knobs.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const manifest = runtime.knobManifest(input.service);
      if (!manifest) {
        throw new ORPCError("CONFLICT", {
          message: `no running mock for "${input.service}" declares knobs. Start it with \`mocktown serve start\`.`,
        });
      }
      const { rejected } = setKnobs(runtime.db, manifest, input.service, input.values, runtime.session ?? "no-session");
      if (rejected.length > 0) {
        throw new ORPCError("BAD_REQUEST", {
          message: rejected.map((r) => `${r.key}: ${r.reason}`).join("; "),
        });
      }
      return { project: runtime.name, service: input.service, knobs: runtime.describeKnobsFor(input.service, "default") };
    }),
  },

  profiles: {
    list: os.profiles.list.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, profiles: listProfiles(runtime.db).map((p) => ({ ...p })) };
    }),

    set: os.profiles.set.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      runtime.db.insert(schema.profiles).values({
        name: input.name,
        description: input.description,
        credentials: input.credentials ?? {},
        context: input.context ?? {},
        knobOverrides: input.knobOverrides ?? {},
        signIn: input.signIn ?? "credentials",
      }).onConflictDoUpdate({
        target: schema.profiles.name,
        set: {
          description: input.description,
          ...(input.credentials ? { credentials: input.credentials } : {}),
          ...(input.context ? { context: input.context } : {}),
          ...(input.knobOverrides ? { knobOverrides: input.knobOverrides } : {}),
          ...(input.signIn ? { signIn: input.signIn } : {}),
        },
      }).run();
      const row = runtime.db.select().from(schema.profiles).where(eq(schema.profiles.name, input.name)).get()!;
      return { project: runtime.name, profile: { ...row } };
    }),

    session: os.profiles.session.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const minted = mintProfileSession(runtime.db, input.name, runtime.session ?? startSession(runtime.db, "serve"));
      return { project: runtime.name, profile: input.name, ...minted };
    }),
  },

  state: {
    get: os.state.get.handler(({ input }) => {
      const runtime = runtimeFor(input.project);
      const provider = runtime.providerFor(input.service);
      if (!provider) {
        throw new ORPCError("NOT_FOUND", {
          message: `no running provider serves "${input.service}". Run \`mocktown serve start\` first.`,
        });
      }
      const snapshot = provider.state?.(input.service, { profile: input.profile, collection: input.collection })
        ?? { collections: [], note: `The ${provider.kind} provider does not implement state introspection.` };
      return { project: runtime.name, service: input.service, ...snapshot };
    }),

    reset: os.state.reset.handler(async ({ input }) => {
      const runtime = runtimeFor(input.project);
      return { project: runtime.name, ...(await runtime.resetState({ service: input.service, profile: input.profile })) };
    }),
  },
});

export type Router = typeof router;

/** Both env procedures generate the same artifacts; only `write` puts them on disk. */
function envArtifacts(runtime: ReturnType<typeof runtimeFor>) {
  const frontDoor = runtime.frontDoorStatus();
  return generateEnv({
    project: runtime.name,
    proxyUrl: `http://127.0.0.1:${frontDoor.port ?? runtime.resolved.local.frontDoorPort ?? 4400}`,
    caCertPath: projectPaths(runtime.name).caCert,
    baseUrls: runtime.allBaseUrls(),
    ekb: runtime.db.select().from(schema.ekb).all().map((row) => ({ ...row })),
    services: runtime.services().map((s) => s.id),
  });
}
