/**
 * Domain schemas shared by the API contract, the config files and the DB row types.
 * Zod v4 is the single schema language (02-architecture.md) — there is no second
 * validation library anywhere in this codebase.
 */
import * as z from 'zod/v4';
import { ProviderRef } from '#src/config/schema.ts';

export { ProviderRef };

export const Service = z.object({
  id: z.string().describe('Hostname or logical service id, e.g. api.stripe.com'),
  provider: ProviderRef,
  seed: z.string().nullable().describe('Path to a seed file, relative to the repo root'),
  aliases: z.array(z.string()).describe('Other hostnames routed to this same service, sharing its provider, mock and corpus'),
  discovered: z.boolean().describe('Added from observed traffic rather than mocktown.json'),
  lastSeenAt: z.string().nullable().describe('When traffic for this service was last observed'),
});
export type Service = z.infer<typeof Service>;

export const Recording = z.object({
  id: z.string(),
  sessionId: z.string(),
  service: z.string(),
  method: z.string(),
  path: z.string(),
  pathTemplate: z.string().describe('Path with ids replaced, e.g. /orders/{orderId}'),
  query: z.record(z.string(), z.string()),
  statusCode: z.number().int(),
  requestHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  responseHeaders: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  requestBody: z.string().nullable(),
  responseBody: z.string().nullable(),
  requestBlob: z.string().nullable().describe('Hash of a large body stored under blobs/'),
  responseBlob: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  kind: z.enum(['http', 'websocket', 'grpc']).describe('`websocket` rows own a set of frames; `grpc` rows are opaque HTTP/2'),
  requestEncoding: z.enum(['text', 'base64']).describe('`base64` when that body is not valid UTF-8 and could not be scrubbed by pattern'),
  responseEncoding: z.enum(['text', 'base64']),
  socketClose: z
    .object({ code: z.number().int(), reason: z.string(), by: z.enum(['client', 'upstream']) })
    .nullable()
    .describe('WebSocket only: how the connection ended'),
  scrubSummary: z
    .array(z.object({ kind: z.string(), count: z.number().int() }))
    .describe('Kinds and counts only, never values. `unscrubbable-binary` marks a body the pattern rules could not see into'),
  source: z.enum(['front-door', 'har']),
  recordedAt: z.string(),
});
export type Recording = z.infer<typeof Recording>;

/** One WebSocket message, from the client's point of view (03-capture.md). */
export const SocketFrame = z.object({
  ordinal: z.number().int().describe('Order within the connection — the wire gives a frame no other identity'),
  direction: z.enum(['sent', 'received']).describe('As the client sees it: `sent` is client -> service'),
  encoding: z.enum(['text', 'base64']),
  body: z.string(),
  atMs: z.number().int().describe('Milliseconds since the socket opened, so a mock can reproduce the cadence'),
});
export type SocketFrame = z.infer<typeof SocketFrame>;

export const IssueType = z
  .enum([
    'unknown-service',
    'unmatched-request',
    'handler-error',
    'state-violation',
    'redirect-gap',
    'pinned-client',
    'provider-drift',
    'undeclared-service',
  ])
  .describe('The issue taxonomy from 07-issues-agent-loop.md');

export const IssueStatus = z.enum(['open', 'resolved', 'verifying', 'reopened']);

export const Issue = z.object({
  id: z.string(),
  type: IssueType,
  status: IssueStatus,
  service: z.string(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  pathTemplate: z.string().nullable(),
  batchId: z.string().nullable().describe('Issues from one run, so an agent fixes a coherent set'),
  sessionId: z.string().nullable(),
  request: z.unknown().describe('The full scrubbed request that triggered this issue'),
  diagnosis: z.unknown().describe('Nearest existing behavior and why it did not match'),
  suggestedResolution: z.string().nullable(),
  links: z.array(z.string()).describe('Corpus rows and files needed to resolve this issue'),
  occurrences: z.number().int(),
  resolutionNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Issue = z.infer<typeof Issue>;

export const EkbEntry = z.object({
  id: z.string(),
  service: z.string(),
  rung: z.number().int().min(1).max(3).describe('1 = env var, 2 = SDK constructor option, 3 = code patch'),
  envVar: z.string().nullable(),
  language: z.string().nullable(),
  snippet: z.string().nullable(),
  note: z.string().nullable(),
  source: z.string(),
});
export type EkbEntry = z.infer<typeof EkbEntry>;

export const Profile = z.object({
  name: z.string(),
  description: z.string().describe('REQUIRED, and must say how this persona differs from the others'),
  credentials: z.record(z.string(), z.string()),
  context: z.record(z.string(), z.string()),
  knobOverrides: z.record(z.string(), z.record(z.string(), z.unknown())),
  signIn: z
    .enum(['credentials', 'consent-picker', 'token-only'])
    .describe('How this persona signs in: emulate-backed services offer a consent picker, not a credential exchange'),
});
export type Profile = z.infer<typeof Profile>;

export const KnobDescriptor = z.object({
  key: z.string(),
  description: z.string(),
  jsonSchema: z.unknown().describe("JSON Schema derived from the mock's Zod knob schema; the GUI renders the form from this"),
  default: z.unknown(),
  value: z.unknown().describe('Current effective value, including any profile override'),
});

/** One editable `mocktown.json` knob. Derived from the schema, so this list maintains itself. */
export const Setting = z.object({
  key: z.string().describe('Dotted path into mocktown.json'),
  type: z.enum(['boolean', 'number', 'string', 'string[]']),
  description: z.string(),
  value: z.string().describe('Current value as JSON text'),
  default: z.string().describe('Schema default as JSON text'),
  choices: z.array(z.string()).describe('The literal forms a union accepts; empty when the value is free'),
});

export const ProviderStatus = z.object({
  name: z.string(),
  kind: z.enum(['emulator', 'generated', 'passthrough']),
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
  skipped: z.number().int().describe('Recordings replay cannot exercise — a socket session is not a request and a response'),
  schemaChecked: z.number().int().describe('Exchanges checked against the checked-in Zod schema rather than a single recorded body'),
  restated: z
    .array(
      z.object({
        recordingId: z.string(),
        method: z.string(),
        pathTemplate: z.string(),
        recordedStatus: z.number().int(),
        actualStatus: z.number().int(),
      }),
    )
    .default([])
    .describe('Passes where the mock answered with a status its schema declares, but not the one the recording caught'),
  failures: z.array(
    z.object({
      recordingId: z.string(),
      method: z.string(),
      path: z.string(),
      pathTemplate: z.string(),
      reason: z.string(),
      expectedStatus: z.number().int().nullable(),
      actualStatus: z.number().int().nullable(),
      diff: z.array(z.string()),
    }),
  ),
});
export type VerifyResult = z.infer<typeof VerifyResult>;

/** The sealed boundary's runtime state (04-sandbox.md). */
export const SandboxStatus = z.object({
  engine: z.string().nullable().describe('Container engine in use, or null when none is installed'),
  running: z.boolean(),
  mode: z.enum(['sealed', 'record']).nullable(),
  container: z.string().nullable().describe('Name of the app container — what `sandbox exec` runs in'),
  network: z.string().nullable(),
  relayIp: z.string().nullable().describe('The relay: every hostname inside the sandbox resolves here'),
  frontDoorPort: z.number().int().nullable(),
  image: z.string().nullable(),
  browser: z.boolean().describe('Whether the image ships headless Chromium'),
  workspace: z.string().nullable(),
  warnings: z.array(z.string()),
});

/**
 * A certification check. `inconclusive` is a first-class outcome, not a rounding error:
 * an IPv6 attempt blocked on a host with no IPv6 egress proves nothing (spike 04).
 */
export const SealCheck = z.object({
  name: z.string(),
  status: z.enum(['pass', 'fail', 'inconclusive', 'skipped']),
  detail: z.string(),
});

export const SealStamp = z.object({
  id: z.string(),
  commit: z.string().nullable(),
  configHash: z.string().describe('Registry, generated env and flow list — a change makes the stamp stale'),
  sealed: z.boolean(),
  flows: z.array(z.string()).describe('The flows exercised; a seal is only as good as these'),
  wallHits: z.number().int(),
  createdAt: z.string(),
});

/**
 * One line of the live feed (09-gui-plugins.md). Deliberately body-free: the feed says
 * *that* something happened, the corpus and the issue queue say what was in it.
 */
export const FeedEvent = z.object({
  seq: z.number().int().describe('Monotonic cursor — pass the highest one back as `since`'),
  at: z.string(),
  kind: z.enum(['exchange', 'wall-hit', 'issue', 'provider', 'session', 'socket', 'drift']),
  service: z.string().nullable(),
  method: z.string().nullable(),
  path: z.string().nullable().describe('Templated and scrubbed, never a raw query string'),
  statusCode: z.number().int().nullable(),
  mode: z.string().nullable().describe('Front-door mode that served it: record, mock, passthrough, deny'),
  durationMs: z.number().int().nullable(),
  summary: z.string().describe('One line. Untrusted in origin — render it as text, never as markup'),
  ref: z.string().nullable().describe('Recording or issue id, or a provider name, to go read the detail'),
});
export type FeedEvent = z.infer<typeof FeedEvent>;

/** A provider's introspectable state, service by service (06-emulation.md). */
export const StateCollection = z.object({
  name: z.string(),
  count: z.number().int(),
  entries: z.array(z.object({ key: z.string(), profile: z.string(), seeded: z.boolean(), value: z.unknown() })),
});

/** portless stable-name status (05-redirection.md). `reason` is populated either way. */
export const PortlessStatus = z.object({
  enabled: z.boolean(),
  available: z.boolean().describe('Proven end to end — a name was registered and fetched back through the proxy'),
  reason: z.string().describe('How availability was proven, or exactly what stopped it'),
  binary: z.string().nullable(),
  caBundle: z.string().nullable().describe("PEM holding the project CA and portless's, for NODE_EXTRA_CA_CERTS"),
  names: z.array(z.object({ service: z.string(), name: z.string(), url: z.string() })),
});
export type PortlessStatus = z.infer<typeof PortlessStatus>;

/**
 * One divergence between a mock and the real service it stands for
 * (07-issues-agent-loop.md's `provider-drift`).
 */
export const DriftFinding = z.object({
  service: z.string(),
  method: z.string(),
  pathTemplate: z.string(),
  kind: z
    .enum(['mock-behind', 'mock-ahead'])
    .describe('`mock-behind`: the real service returns something the mock does not. `mock-ahead`: the mock still returns a dropped field'),
  detail: z.string(),
  diff: z.array(z.string()),
  issueId: z.string().nullable(),
});
export type DriftFinding = z.infer<typeof DriftFinding>;

export const DriftRun = z.object({
  id: z.string(),
  sessionId: z.string().nullable(),
  trigger: z.enum(['manual', 'scheduled']),
  services: z.array(z.string()),
  flows: z.array(z.string()),
  checked: z.number().int(),
  drifted: z.number().int(),
  issues: z.array(z.string()),
  reasons: z.array(z.string()),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
});
export type DriftRun = z.infer<typeof DriftRun>;

/** A single-file HTML panel the GUI shell iframes (09-gui-plugins.md). */
export const Panel = z.object({
  name: z.string(),
  service: z.string().nullable().describe('The service this panel is about, when it is about one'),
  entry: z.string().describe('HTML file, relative to the panel directory'),
  url: z.string().describe('Where the daemon serves it, for the shell to iframe'),
  source: z.enum(['workspace', 'builtin']),
  file: z.string().describe('Absolute path on disk, so a human can edit it'),
});
export type Panel = z.infer<typeof Panel>;

/** Every response carries the resolved project: misdirection must be visible. */
export const withProject = <T extends z.ZodRawShape>(shape: T) => z.object({ project: z.string(), ...shape });

/** Every request names the project it means. The CLI fills this from its resolution. */
export const ProjectInput = { project: z.string().describe('Resolved project name (08-projects-config.md)') };
