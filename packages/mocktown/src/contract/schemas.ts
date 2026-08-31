/**
 * Domain schemas shared by the API contract, the config files and the DB row types.
 * Zod v4 is the single schema language (02-architecture.md) — there is no second
 * validation library anywhere in this codebase.
 */
import { z } from "zod";
import { ProviderRef } from "../config/schema.ts";

export { ProviderRef };

export const Service = z.object({
  id: z.string().describe("Hostname or logical service id, e.g. api.stripe.com"),
  provider: ProviderRef,
  seed: z.string().nullable().describe("Path to a seed file, relative to the repo root"),
  discovered: z.boolean().describe("Added from observed traffic rather than mocktown.json"),
  lastSeenAt: z.string().nullable().describe("When traffic for this service was last observed"),
});
export type Service = z.infer<typeof Service>;

export const Recording = z.object({
  id: z.string(),
  sessionId: z.string(),
  service: z.string(),
  method: z.string(),
  path: z.string(),
  pathTemplate: z.string().describe("Path with ids replaced, e.g. /orders/{orderId}"),
  query: z.record(z.string(), z.string()),
  statusCode: z.number().int(),
  requestHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  responseHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  requestBody: z.string().nullable(),
  responseBody: z.string().nullable(),
  requestBlob: z.string().nullable().describe("Hash of a large body stored under blobs/"),
  responseBlob: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  scrubSummary: z.array(z.object({ kind: z.string(), count: z.number().int() })),
  source: z.enum(["front-door", "har"]),
  recordedAt: z.string(),
});
export type Recording = z.infer<typeof Recording>;

export const IssueType = z.enum([
  "unknown-service", "unmatched-request", "near-miss", "state-violation",
  "redirect-gap", "pinned-client", "provider-drift",
]).describe("The issue taxonomy from 07-issues-agent-loop.md");

export const IssueStatus = z.enum(["open", "resolved", "verifying", "reopened"]);

export const Issue = z.object({
  id: z.string(),
  type: IssueType,
  status: IssueStatus,
  service: z.string(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  pathTemplate: z.string().nullable(),
  batchId: z.string().nullable().describe("Issues from one run, so an agent fixes a coherent set"),
  sessionId: z.string().nullable(),
  request: z.unknown().describe("The full scrubbed request that triggered this issue"),
  diagnosis: z.unknown().describe("Nearest existing behavior and why it did not match"),
  suggestedResolution: z.string().nullable(),
  links: z.array(z.string()).describe("Corpus rows and files needed to resolve this issue"),
  occurrences: z.number().int(),
  resolutionNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const EkbEntry = z.object({
  id: z.string(),
  service: z.string(),
  rung: z.number().int().min(1).max(3).describe("1 = env var, 2 = SDK constructor option, 3 = code patch"),
  envVar: z.string().nullable(),
  language: z.string().nullable(),
  snippet: z.string().nullable(),
  note: z.string().nullable(),
  source: z.string(),
});
export type EkbEntry = z.infer<typeof EkbEntry>;

export const Profile = z.object({
  name: z.string(),
  description: z.string().describe("REQUIRED, and must say how this persona differs from the others"),
  credentials: z.record(z.string(), z.string()),
  context: z.record(z.string(), z.string()),
  knobOverrides: z.record(z.string(), z.record(z.string(), z.unknown())),
  signIn: z.enum(["credentials", "consent-picker", "token-only"])
    .describe("How this persona signs in: emulate-backed services offer a consent picker, not a credential exchange"),
});
export type Profile = z.infer<typeof Profile>;

export const KnobDescriptor = z.object({
  key: z.string(),
  description: z.string(),
  jsonSchema: z.unknown().describe("JSON Schema derived from the mock's Zod knob schema; the GUI renders the form from this"),
  default: z.unknown(),
  value: z.unknown().describe("Current effective value, including any profile override"),
});

export const ProviderStatus = z.object({
  name: z.string(),
  kind: z.enum(["emulator", "generated", "passthrough"]),
  services: z.array(z.string()),
  running: z.boolean(),
  baseUrls: z.record(z.string(), z.string()),
  /** Non-loopback exposure has to be visible: emulate binds every interface (spike 03). */
  warnings: z.array(z.string()),
});

export const VerifyResult = z.object({
  service: z.string(),
  total: z.number().int(),
  passed: z.number().int(),
  failed: z.number().int(),
  failures: z.array(z.object({
    recordingId: z.string(),
    method: z.string(),
    path: z.string(),
    reason: z.string(),
    expectedStatus: z.number().int().nullable(),
    actualStatus: z.number().int().nullable(),
    diff: z.array(z.string()),
  })),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/** Every response carries the resolved project: misdirection must be visible. */
export const withProject = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ project: z.string(), ...shape });

/** Every request names the project it means. The CLI fills this from its resolution. */
export const ProjectInput = { project: z.string().describe("Resolved project name (08-projects-config.md)") };
