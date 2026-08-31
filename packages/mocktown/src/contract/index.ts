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
import { oc } from "@orpc/contract";
import { z } from "zod";
import {
  EkbEntry, Issue, IssueStatus, IssueType, KnobDescriptor, Profile, ProjectInput,
  ProviderRef, ProviderStatus, Recording, Service, VerifyResult, withProject,
} from "./schemas.ts";

/** `env.get` and `env.write` differ only in whether the files land, so they share a shape. */
const EnvOutput = withProject({
  variables: z.record(z.string(), z.string()),
  report: z.array(z.object({ service: z.string(), rung: z.number().int().nullable(), covered: z.boolean(), how: z.string() })),
  agentTasks: z.array(z.object({ service: z.string(), rung: z.number().int(), instruction: z.string(), snippet: z.string().nullable() })),
  written: z.array(z.string()).describe("Files written, empty for the read"),
});

export const contract = {
  status: {
    get: oc
      .route({ method: "GET", path: "/status", summary: "Resolved project, services, providers, front door and seal state" })
      .input(z.object({
        ...ProjectInput,
        source: z.enum(["flag", "env", "file", "default"]).optional()
          .describe("How the caller resolved the project — echoed back so every command can print it (08-projects-config.md)"),
      }))
      .output(withProject({
        source: z.string().describe("How the project was resolved: flag, env, file, default, or unknown if the caller did not say"),
        workspace: z.string().nullable(),
        frontDoor: z.object({ running: z.boolean(), port: z.number().int().nullable(), mode: z.enum(["record", "deny"]) }),
        services: z.array(Service),
        providers: z.array(ProviderStatus),
        recordings: z.number().int(),
        openIssues: z.number().int(),
        session: z.string().nullable(),
        warnings: z.array(z.string()),
      })),
  },

  services: {
    list: oc
      .route({ method: "GET", path: "/services", summary: "List the project's service registry" })
      .input(z.object({ ...ProjectInput, provider: ProviderRef.optional().describe("Filter to one provider kind") }))
      .output(withProject({ services: z.array(Service) })),

    set: oc
      .route({ method: "PUT", path: "/services/{id}", summary: "Assign a provider to a service" })
      .input(z.object({ ...ProjectInput, id: z.string().describe("Hostname or logical service id"), provider: ProviderRef, seed: z.string().optional() }))
      .output(withProject({ service: Service })),
  },

  recordings: {
    list: oc
      .route({ method: "GET", path: "/recordings", summary: "Browse the scrubbed corpus" })
      .input(z.object({
        ...ProjectInput,
        service: z.string().optional(),
        method: z.string().optional(),
        session: z.string().optional(),
        limit: z.coerce.number().int().min(1).max(1000).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      }))
      .output(withProject({ total: z.number().int(), recordings: z.array(Recording) })),

    get: oc
      .route({ method: "GET", path: "/recordings/{id}", summary: "One exchange in full, with any spilled body inlined" })
      .input(z.object({ ...ProjectInput, id: z.string() }))
      .output(withProject({ recording: Recording })),

    routes: oc
      .route({ method: "GET", path: "/recordings/routes", summary: "The corpus collapsed to distinct routes — what a mock has to cover" })
      .input(z.object({ ...ProjectInput, service: z.string().optional() }))
      .output(withProject({
        routes: z.array(z.object({
          service: z.string(), method: z.string(), pathTemplate: z.string(),
          count: z.number().int(), statuses: z.array(z.number().int()), lastSeenAt: z.string().nullable(),
        })),
      })),
  },

  corpus: {
    export: oc
      .route({ method: "GET", path: "/corpus/export", summary: "The corpus in agent-legible form, ready for mock generation" })
      .input(z.object({ ...ProjectInput, service: z.string().describe("Service to export"), limitPerRoute: z.coerce.number().int().min(1).max(50).default(5) }))
      .output(withProject({
        service: z.string(),
        generatedAt: z.string(),
        // Deliberately a document rather than rows: this is what a generating agent reads.
        routes: z.array(z.object({
          method: z.string(),
          pathTemplate: z.string(),
          observations: z.number().int(),
          examples: z.array(z.object({
            recordingId: z.string(), path: z.string(), query: z.record(z.string(), z.string()),
            statusCode: z.number().int(), requestBody: z.string().nullable(), responseBody: z.string().nullable(),
            requestHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
            responseHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
          })),
          /** POST /orders → GET /orders/{id} coupling, so the mock is stateful not verbatim. */
          statefulHints: z.array(z.string()),
        })),
        secretKinds: z.array(z.string()).describe("Placeholder kinds present; the mock must accept credentials of these shapes"),
      })),
  },

  record: {
    start: oc
      .route({ method: "POST", path: "/record/start", summary: "Start the front door in record mode and open a session" })
      .input(z.object({ ...ProjectInput, label: z.string().optional(), seed: z.string().optional() }))
      .output(withProject({ session: z.string(), proxyUrl: z.string(), caCertPath: z.string(), env: z.record(z.string(), z.string()) })),

    stop: oc
      .route({ method: "POST", path: "/record/stop", summary: "Close the recording session" })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ session: z.string().nullable(), recorded: z.number().int(), services: z.array(z.string()) })),
  },

  serve: {
    start: oc
      .route({ method: "POST", path: "/serve/start", summary: "Start providers and serve mocks through the front door" })
      .input(z.object({ ...ProjectInput, seed: z.string().optional(), sealed: z.boolean().optional().describe("Deny unknown hosts instead of recording them") }))
      .output(withProject({ session: z.string(), proxyUrl: z.string(), caCertPath: z.string(), providers: z.array(ProviderStatus), env: z.record(z.string(), z.string()), warnings: z.array(z.string()) })),

    stop: oc
      .route({ method: "POST", path: "/serve/stop", summary: "Stop providers and the front door" })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ stopped: z.array(z.string()) })),
  },

  import: {
    har: oc
      .route({ method: "POST", path: "/import/har", summary: "Import a HAR file into the corpus through the same scrubber" })
      .input(z.object({ ...ProjectInput, path: z.string().describe("Path to the .har file"), label: z.string().optional() }))
      .output(withProject({ session: z.string(), imported: z.number().int(), skipped: z.array(z.object({ url: z.string(), reason: z.string() })), services: z.array(z.string()) })),
  },

  scrub: {
    audit: oc
      .route({ method: "POST", path: "/scrub/audit", summary: "Re-scan the stored corpus for anything the current rules would catch" })
      .input(z.object({ ...ProjectInput, service: z.string().optional() }))
      .output(withProject({
        scanned: z.number().int(),
        findings: z.array(z.object({ recordingId: z.string(), where: z.string(), kind: z.string(), sample: z.string() })),
      })),
  },

  issues: {
    list: oc
      .route({ method: "GET", path: "/issues", summary: "The agent loop's work queue" })
      .input(z.object({ ...ProjectInput, status: IssueStatus.optional(), type: IssueType.optional(), service: z.string().optional(), batch: z.string().optional() }))
      .output(withProject({ issues: z.array(Issue) })),

    get: oc
      .route({ method: "GET", path: "/issues/{id}", summary: "One issue, self-contained enough for an agent to resolve" })
      .input(z.object({ ...ProjectInput, id: z.string() }))
      .output(withProject({ issue: Issue })),

    resolve: oc
      .route({ method: "POST", path: "/issues/{id}/resolve", summary: "Claim an issue as fixed; the daemon replays the trigger before closing it" })
      .input(z.object({ ...ProjectInput, id: z.string(), note: z.string().optional(), skipVerify: z.boolean().optional().describe("Close without replay — for issues with nothing to replay, like pinned-client") }))
      .output(withProject({ issue: Issue, verified: z.boolean(), verification: VerifyResult.nullable() })),
  },

  providers: {
    list: oc
      .route({ method: "GET", path: "/providers", summary: "Provider processes and the services each one serves" })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ providers: z.array(ProviderStatus) })),

    restart: oc
      .route({ method: "POST", path: "/providers/{name}/restart", summary: "Restart one provider, re-applying its seed" })
      .input(z.object({ ...ProjectInput, name: z.string() }))
      .output(withProject({ provider: ProviderStatus })),
  },

  mocks: {
    verify: oc
      .route({ method: "POST", path: "/mocks/{service}/verify", summary: "Replay recorded sessions against the live mock and diff" })
      .input(z.object({ ...ProjectInput, service: z.string(), session: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) }))
      .output(withProject({ result: VerifyResult })),

    scaffold: oc
      .route({ method: "POST", path: "/mocks/{service}/scaffold", summary: "Write the generation brief and a starting mock module for an agent to fill in" })
      .input(z.object({ ...ProjectInput, service: z.string(), force: z.boolean().optional() }))
      .output(withProject({ service: z.string(), files: z.array(z.string()), brief: z.string() })),
  },

  env: {
    get: oc
      .route({ method: "GET", path: "/env", summary: "The generated env-var setup, coverage report and agent task list" })
      .input(z.object({ ...ProjectInput }))
      .output(EnvOutput),

    // Writing files is a separate, mutating procedure rather than a `--write` flag on the
    // read: `readOnlyHint` follows the HTTP method, so a GET that writes to the workspace
    // would hand agents a read-only-looking tool that edits their repo (07-issues-agent-loop.md).
    write: oc
      .route({ method: "POST", path: "/env/write", summary: "Write .env.mocktown and the AGENTS.md section" })
      .input(z.object({ ...ProjectInput }))
      .output(EnvOutput),
  },

  skills: {
    list: oc
      .route({ method: "GET", path: "/skills", summary: "The prompt packs shipped with Mocktown for the recurring agent jobs" })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ skills: z.array(z.object({ name: z.string(), version: z.string(), summary: z.string() })) })),

    get: oc
      .route({ method: "GET", path: "/skills/{name}", summary: "One prompt pack in full, including the house rules" })
      .input(z.object({ ...ProjectInput, name: z.string() }))
      .output(withProject({ skill: z.object({ name: z.string(), version: z.string(), summary: z.string(), body: z.string() }) })),
  },

  ekb: {
    list: oc
      .route({ method: "GET", path: "/ekb", summary: "Endpoint knowledge base: how clients get pointed at each service" })
      .input(z.object({ ...ProjectInput, service: z.string().optional() }))
      .output(withProject({ entries: z.array(EkbEntry) })),

    add: oc
      .route({ method: "PUT", path: "/ekb/{service}", summary: "Record a redirect recipe — every generated mock must add its own" })
      .input(z.object({
        ...ProjectInput, service: z.string(),
        rung: z.coerce.number().int().min(1).max(3),
        envVar: z.string().optional(), language: z.string().optional(),
        snippet: z.string().optional(), note: z.string().optional(),
      }))
      .output(withProject({ entry: EkbEntry })),
  },

  knobs: {
    get: oc
      .route({ method: "GET", path: "/knobs/{service}", summary: "Knob manifest and current values for a generated mock" })
      .input(z.object({ ...ProjectInput, service: z.string(), profile: z.string().optional() }))
      .output(withProject({ service: z.string(), knobs: z.array(KnobDescriptor) })),

    set: oc
      .route({ method: "PUT", path: "/knobs/{service}", summary: "Set knob values; the change is journaled so runs stay replayable" })
      .input(z.object({ ...ProjectInput, service: z.string(), values: z.record(z.string(), z.unknown()) }))
      .output(withProject({ service: z.string(), knobs: z.array(KnobDescriptor) })),
  },

  profiles: {
    list: oc
      .route({ method: "GET", path: "/profiles", summary: "The persona roster an agent picks a scenario from" })
      .input(z.object({ ...ProjectInput }))
      .output(withProject({ profiles: z.array(Profile) })),

    set: oc
      .route({ method: "PUT", path: "/profiles/{name}", summary: "Create or update an auth profile" })
      .input(z.object({
        ...ProjectInput, name: z.string(),
        description: z.string().describe("Must say how this persona differs from the others"),
        credentials: z.record(z.string(), z.string()).optional(),
        context: z.record(z.string(), z.string()).optional(),
        knobOverrides: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
        signIn: z.enum(["credentials", "consent-picker", "token-only"]).optional(),
      }))
      .output(withProject({ profile: Profile })),

    session: oc
      .route({ method: "POST", path: "/profiles/{name}/session", summary: "Mint a ready-made token for API-level testing, skipping the login UI" })
      .input(z.object({ ...ProjectInput, name: z.string() }))
      .output(withProject({ profile: z.string(), token: z.string(), header: z.string().describe("Ready-to-send Authorization header value") })),
  },

  state: {
    get: oc
      .route({ method: "GET", path: "/state/{service}", summary: "Provider state introspection — backs the GUI panels" })
      .input(z.object({ ...ProjectInput, service: z.string(), profile: z.string().optional(), collection: z.string().optional() }))
      .output(withProject({
        service: z.string(),
        collections: z.array(z.object({ name: z.string(), count: z.number().int(), entries: z.array(z.object({ key: z.string(), profile: z.string(), seeded: z.boolean(), value: z.unknown() })) })),
        note: z.string().nullable().describe("Set when introspection is best-effort, e.g. an emulate-backed service"),
      })),

    reset: oc
      .route({ method: "POST", path: "/state/reset", summary: "Drop mutable state and re-apply seeds; closes the session and starts a new one" })
      .input(z.object({ ...ProjectInput, service: z.string().optional(), profile: z.string().optional() }))
      .output(withProject({ reset: z.array(z.string()), session: z.string(), restarted: z.array(z.string()) })),
  },
};

export type Contract = typeof contract;
