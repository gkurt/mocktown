/**
 * Drift watch — 07-issues-agent-loop.md's last loop mechanic, and the one every
 * record/replay tool skips:
 *
 *   "scheduled re-record runs against real APIs diff reality vs providers and file
 *    `provider-drift` issues — the 'mock rotted' problem"
 *
 * **A drift run is a re-record, not a replay.** The tempting implementation is to take the
 * stored requests and fire them at the real service, but the corpus contains no
 * credentials — the scrubber removed them before disk (10-security.md) — so every request
 * would come back 401 and the run would report the entire integration as drifted. The only
 * thing that can authenticate against a real API is the app itself, so a drift run works
 * the way the doc names it: run the project's own flows with the front door recording,
 * against the real services, using the app's own environment. Then replay that fresh
 * evidence against the providers and diff.
 *
 * Two consequences worth stating out loud, because they are what make this safe to ship:
 *
 * - **It costs real money and real quota**, so it is off by default and never enabled by a
 *   config default ([config/schema.ts](../config/schema.ts)).
 * - **It deliberately overrides the registry** for the services it judges, forcing them to
 *   `record` for the duration of the run. Without that the front door would deny a mocked
 *   service — correctly — and a drift check could never see reality. The override is
 *   scoped to the run and named in the run's report.
 */
import { and, eq, ne } from 'drizzle-orm';
import { launchCaptured } from '#src/capture/launch.ts';
import { routeKey } from '#src/capture/normalize.ts';
import type { Recording } from '#src/contract/schemas.ts';
import type { ProjectRuntime } from '#src/daemon/runtime.ts';
import { schema } from '#src/db/client.ts';
import { inflateRecording, recordingsForService } from '#src/mocks/corpus.ts';
import { shapeOf, verifyRecordings } from '#src/mocks/verify.ts';
import { id } from '#src/util/id.ts';

export interface DriftFlowResult {
  command: string;
  exitCode: number;
  durationMs: number;
  output: string;
}

export interface DriftFinding {
  service: string;
  method: string;
  pathTemplate: string;
  /**
   * `mock-behind` — the real service returns something the mock does not produce.
   * `mock-ahead` — the mock still produces a field the real service has stopped sending.
   */
  kind: 'mock-behind' | 'mock-ahead';
  detail: string;
  diff: string[];
  issueId: string | null;
}

export interface DriftRunResult {
  ok: boolean;
  trigger: 'manual' | 'scheduled';
  runId: string;
  session: string | null;
  services: string[];
  flows: DriftFlowResult[];
  checked: number;
  findings: DriftFinding[];
  reasons: string[];
  startedAt: string;
  finishedAt: string;
}

/** Long enough for a real integration flow, short enough that a hung flow is not forever. */
const FLOW_TIMEOUT_MS = 10 * 60_000;
const REPLAY_LIMIT = 200;

export async function checkDrift(
  runtime: ProjectRuntime,
  options: { services?: string[]; flows?: string[]; trigger?: 'manual' | 'scheduled' } = {},
): Promise<DriftRunResult> {
  const trigger = options.trigger ?? 'manual';
  const runId = id('drift');
  const startedAt = new Date().toISOString();
  const config = runtime.resolved.file?.drift;

  const flows = options.flows?.length ? options.flows : config?.flows?.length ? config.flows : (runtime.resolved.file?.seal.flows ?? []);
  const services = options.services?.length ? options.services : config?.services?.length ? config.services : mockedServices(runtime);

  const give = (reasons: string[]): DriftRunResult => {
    const finishedAt = new Date().toISOString();
    persist(runtime, { runId, trigger, sessionId: null, services, flows, checked: 0, findings: [], reasons, startedAt, finishedAt });
    return { ok: false, trigger, runId, session: null, services, flows: [], checked: 0, findings: [], reasons, startedAt, finishedAt };
  };

  if (flows.length === 0) {
    return give([
      'No flows are configured, so there is nothing to re-record and this run proves nothing. Add the commands that ' +
        'exercise your real dependencies to `drift.flows` in mocktown.json (they fall back to `seal.flows`).',
    ]);
  }
  if (services.length === 0) {
    return give([
      'No service in the registry is backed by a provider, so there is no mock that could have rotted. ' +
        'Point a service at `emulator:<name>` or `generated:<host>` first.',
    ]);
  }

  // The mode we interrupted, so a developer's session is put back rather than silently
  // replaced by whatever the drift run left behind.
  const priorMode = runtime.mode.kind;
  const reasons: string[] = [];
  if (priorMode === 'record') {
    reasons.push('A recording session was already open and has been replaced: a drift run needs its own session to judge.');
  }

  // ── 1. Re-record against the real services ────────────────────────────────
  const started = await runtime.startRecord({ label: `drift:${runId}`, recordOverride: services });
  const flowResults: DriftFlowResult[] = [];
  for (const command of flows) {
    const at = Date.now();
    try {
      const result = await launchCaptured(command, started.env as Record<string, string>, {
        cwd: runtime.resolved.workspace ?? undefined,
        timeoutMs: FLOW_TIMEOUT_MS,
      });
      flowResults.push({ command, exitCode: result.exitCode, durationMs: Date.now() - at, output: result.output });
    } catch (error) {
      flowResults.push({
        command,
        exitCode: 1,
        durationMs: Date.now() - at,
        output: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const stopped = await runtime.stopRecord();
  const session = stopped.session;

  for (const flow of flowResults.filter((f) => f.exitCode !== 0)) {
    // A failed flow means the fresh evidence is partial. Saying so matters more than the
    // findings: "no drift" from a flow that never ran is the same lie as a green seal.
    reasons.push(`Flow \`${flow.command}\` exited ${flow.exitCode}, so the routes it was meant to exercise were not re-recorded.`);
  }

  if (!session || stopped.recorded === 0) {
    const finishedAt = new Date().toISOString();
    reasons.push(
      'The flows recorded nothing. Either they do not call the services being judged, or they are not going through ' +
        'the front door — check that they read HTTPS_PROXY (and NODE_USE_ENV_PROXY for fetch-based SDKs).',
    );
    persist(runtime, { runId, trigger, sessionId: session, services, flows, checked: 0, findings: [], reasons, startedAt, finishedAt });
    if (priorMode === 'serve') await runtime.startServe({ sealed: runtime.mode.sealed });
    return { ok: false, trigger, runId, session, services, flows: flowResults, checked: 0, findings: [], reasons, startedAt, finishedAt };
  }

  // ── 2. Replay the fresh evidence against the providers ────────────────────
  await runtime.startServe({ sealed: true });

  const findings: DriftFinding[] = [];
  let checked = 0;

  for (const service of services) {
    const fresh = recordingsForService(runtime.db, service, session, REPLAY_LIMIT).map((row) => inflateRecording(runtime.name, row));
    if (fresh.length === 0) {
      reasons.push(`No fresh recordings for ${service}: the flows did not call it, so its mock was not judged.`);
      continue;
    }
    const baseUrl = runtime.baseUrlFor(service);
    if (!baseUrl) {
      reasons.push(`No provider came up for ${service}, so its mock could not be compared against the ${fresh.length} fresh exchange(s).`);
      continue;
    }

    checked += fresh.length;
    const result = await verifyRecordings(fresh, { baseUrl, service }, runtime.currentScrubber);
    for (const failure of result.failures) {
      findings.push({
        service,
        method: failure.method,
        pathTemplate: templateFor(fresh, failure.recordingId, failure.path),
        kind: 'mock-behind',
        detail: failure.reason,
        diff: failure.diff,
        issueId: null,
      });
    }

    // The other direction: the real service dropped a field the mock still returns. Replay
    // will not catch it — an extra field in a mock response is legitimate — but it is the
    // clearest signal that a mock is describing an API that no longer exists.
    findings.push(...staleFields(runtime, service, session, fresh));
  }

  for (const finding of findings) finding.issueId = fileDriftIssue(runtime, finding, session);

  const finishedAt = new Date().toISOString();
  persist(runtime, { runId, trigger, sessionId: session, services, flows, checked, findings, reasons, startedAt, finishedAt });
  runtime.announceDrift(
    findings.length === 0
      ? `drift check: ${checked} exchange(s) re-recorded, no drift`
      : `drift check: ${findings.length} finding(s) across ${new Set(findings.map((f) => f.service)).size} service(s)`,
  );

  // Restore what we interrupted. Serve mode is left up when it was up before; an idle
  // project goes back to idle rather than being left holding a MITM proxy.
  if (priorMode === 'idle') await runtime.stopServe();

  return {
    // `ok: false` when anything drifted *or* when the run could not judge what it claimed
    // to — the CLI exits non-zero on either, which is what makes this usable in CI.
    ok: findings.length === 0 && reasons.length === 0,
    trigger,
    runId,
    session,
    services,
    flows: flowResults,
    checked,
    findings,
    reasons,
    startedAt,
    finishedAt,
  };
}

/** Services the registry points at a provider — the only ones that can have a rotted mock. */
function mockedServices(runtime: ProjectRuntime): string[] {
  return runtime
    .services()
    .filter((service) => service.provider.startsWith('emulator:') || service.provider.startsWith('generated:'))
    .map((service) => service.id);
}

/**
 * Fields the previous corpus had that the fresh recording does not. The mock was built
 * from the old corpus, so it very likely still returns them — which makes it a description
 * of an API that has moved on. Reported as `mock-ahead` and never auto-resolved: 07 says
 * humans review the drift diff.
 */
function staleFields(runtime: ProjectRuntime, service: string, freshSession: string, fresh: Recording[]): DriftFinding[] {
  const previous = runtime.db
    .select()
    .from(schema.recordings)
    .where(and(eq(schema.recordings.service, service), ne(schema.recordings.sessionId, freshSession)))
    .all();
  if (previous.length === 0) return [];

  const findings: DriftFinding[] = [];
  const byRoute = new Map<string, Recording>();
  for (const row of fresh) byRoute.set(routeKey(row.method, row.service, row.pathTemplate), row);

  const seen = new Set<string>();
  for (const old of previous) {
    const key = routeKey(old.method, old.service, old.pathTemplate);
    const now = byRoute.get(key);
    if (!now || seen.has(key)) continue;
    if (Math.floor(old.statusCode / 100) !== 2 || Math.floor(now.statusCode / 100) !== 2) continue;

    const before = parseJson(old.responseBody);
    const after = parseJson(now.responseBody);
    if (before === undefined || after === undefined) continue;

    const gone = shapeOf(before).filter((entry) => !new Set(shapeOf(after)).has(entry));
    if (gone.length === 0) continue;
    seen.add(key);
    findings.push({
      service,
      method: old.method,
      pathTemplate: old.pathTemplate,
      kind: 'mock-ahead',
      detail:
        `The real response no longer contains ${gone.length} field(s) the corpus this mock was generated from had. ` +
        'The mock probably still returns them, which makes it a description of an API that has moved on.',
      diff: gone.slice(0, 20).map((entry) => `no longer returned: ${entry}`),
      issueId: null,
    });
  }
  return findings;
}

function fileDriftIssue(runtime: ProjectRuntime, finding: DriftFinding, session: string): string {
  return runtime.issues.file({
    type: 'provider-drift',
    service: finding.service,
    method: finding.method,
    pathTemplate: finding.pathTemplate,
    sessionId: session,
    diagnosis: { kind: finding.kind, reason: finding.detail, diff: finding.diff },
    suggestedResolution:
      finding.kind === 'mock-behind'
        ? `The real ${finding.service} response has something the mock does not produce. Patch the ` +
          `\`${finding.method} ${finding.pathTemplate}\` handler to cover it, then \`mocktown mocks verify --service ${finding.service}\`. ` +
          'The diff above is against traffic re-recorded from the real service in this drift run.'
        : `The real ${finding.service} response has stopped returning fields the mock still produces. Removing them is a ` +
          'behaviour change for the app under test, so this one is for a human to look at before an agent edits anything.',
    links: [
      `mocktown recordings list --service ${finding.service} --session ${session}`,
      `mocktown corpus export --service ${finding.service}`,
    ],
  });
}

function persist(
  runtime: ProjectRuntime,
  row: {
    runId: string;
    trigger: 'manual' | 'scheduled';
    sessionId: string | null;
    services: string[];
    flows: string[];
    checked: number;
    findings: DriftFinding[];
    reasons: string[];
    startedAt: string;
    finishedAt: string;
  },
): void {
  runtime.db
    .insert(schema.driftRuns)
    .values({
      id: row.runId,
      sessionId: row.sessionId,
      trigger: row.trigger,
      services: row.services,
      flows: row.flows,
      checked: row.checked,
      drifted: row.findings.length,
      issues: row.findings.map((f) => f.issueId).filter((value): value is string => Boolean(value)),
      reasons: row.reasons,
      startedAt: row.startedAt,
      finishedAt: row.finishedAt,
    })
    .run();
}

/** The verify harness reports a concrete path; the issue key needs the template. */
function templateFor(recordings: Recording[], recordingId: string, fallback: string): string {
  return recordings.find((row) => row.id === recordingId)?.pathTemplate ?? fallback;
}

function parseJson(body: string | null): unknown {
  if (!body) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}
