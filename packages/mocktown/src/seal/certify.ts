/**
 * Seal certification — 05-redirection.md's loop:
 *
 *   apply env setup → run app flows with deny-on-unknown → zero wall-hits? → SEALED
 *
 * **The sandbox is the instrument, and there is no substitute for it.** Outside the
 * boundary, an SDK that ignores proxy variables reaches the real API without ever
 * touching the front door: the run records zero wall-hits and the seal comes back green
 * while the app talks to production. Inside the boundary there is no "direct" — every
 * hostname resolves to the front door — so an unredirected dependency shows up as a wall
 * hit instead of a silent escape. A run with no container engine is therefore reported
 * **unverifiable**, never sealed. That asymmetry is the whole value of the command.
 *
 * The flows run *unmodified*, with no Mocktown environment applied. Redirection coverage
 * is judged separately, from the endpoint knowledge base: every service the flows actually
 * exercised that `mocktown env` cannot point at a mock mechanically becomes a
 * `redirect-gap` issue, because that is exactly the dependency that would reach production
 * the moment the app ran outside the sandbox.
 */
import type { ProjectRuntime } from '#src/daemon/runtime.ts';
import { configHash, currentCommit, type SealStamp, writeStamp } from '#src/seal/stamp.ts';

export interface SealFlowResult {
  command: string;
  exitCode: number;
  durationMs: number;
  /** Tail of the combined output — enough to see why a flow failed, not a log dump. */
  output: string;
}

export interface SealWallHit {
  host: string;
  method: string;
  path: string;
  reason: string;
}

export interface SealGap {
  service: string;
  rung: number | null;
  instruction: string;
}

export interface SealRunResult {
  ok: boolean;
  sealed: boolean;
  /** `sandbox` is the only instrument that can certify; `none` means the run proved nothing. */
  instrument: 'sandbox' | 'none';
  commit: string | null;
  configHash: string;
  flows: SealFlowResult[];
  wallHits: SealWallHit[];
  gaps: SealGap[];
  servicesExercised: string[];
  /** Why the seal is not stamped, in the order a human should act on them. */
  reasons: string[];
  stamp: SealStamp | null;
}

const OUTPUT_TAIL = 2000;

export async function certifySeal(runtime: ProjectRuntime, options: { flows?: string[]; rebuild?: boolean } = {}): Promise<SealRunResult> {
  const flows = options.flows?.length ? options.flows : (runtime.resolved.file?.seal.flows ?? []);
  const commit = currentCommit(runtime.resolved.workspace);
  const artifacts = runtime.envArtifacts();
  const fingerprint = {
    services: Object.fromEntries(runtime.services().map((s) => [s.id, s.provider])),
    envVars: Object.keys(artifacts.variables),
    flows,
  };
  const hash = configHash(fingerprint);
  const base = {
    commit,
    configHash: hash,
    flows: [] as SealFlowResult[],
    wallHits: [] as SealWallHit[],
    gaps: [] as SealGap[],
    servicesExercised: [] as string[],
    stamp: null as SealStamp | null,
  };

  if (flows.length === 0) {
    return {
      ...base,
      ok: false,
      sealed: false,
      instrument: 'none',
      reasons: [
        'No flows are configured, and a seal with no flows certifies nothing. Add the commands that exercise ' +
          'your integrations to `seal.flows` in mocktown.json — they run inside the sandbox.',
      ],
    };
  }

  // Serving with deny-on-unknown is what turns an unserved request into evidence. A
  // recording run forwards unknown hosts to the real upstream, which is the opposite.
  if (runtime.mode.kind !== 'serve' || !runtime.mode.sealed) await runtime.startServe({ sealed: true });
  const frontDoorPort = runtime.frontDoorStatus().port;
  if (!frontDoorPort) {
    return {
      ...base,
      ok: false,
      sealed: false,
      instrument: 'none',
      reasons: ['The front door is not running, so nothing can be certified.'],
    };
  }

  try {
    // A sealed sandbox already pointed at this front door is the same instrument, so it
    // is reused: tearing down a boundary a developer is working in, to build an identical
    // one, would make `seal verify` hostile to run locally.
    const existing = await runtime.sandboxStatus();
    const reusable = existing.running && existing.mode === 'sealed' && existing.frontDoorPort === frontDoorPort && !options.rebuild;
    if (!reusable) await runtime.sandboxUp({ mode: 'sealed', frontDoorPort, rebuild: options.rebuild });
  } catch (error) {
    return {
      ...base,
      ok: false,
      sealed: false,
      instrument: 'none',
      reasons: [
        `The sandbox could not be started, so this run proves nothing: ${error instanceof Error ? error.message : String(error)}`,
        'Certification runs inside the sandbox on purpose: outside it, an SDK that ignores proxy variables reaches ' +
          'the real API without touching the front door, and the seal would come back green while the app talked to production.',
      ],
    };
  }

  runtime.beginObservation();
  const flowResults: SealFlowResult[] = [];
  for (const command of flows) {
    const startedAt = Date.now();
    const result = await runtime.sandboxExec(command);
    flowResults.push({
      command,
      exitCode: result.exitCode,
      durationMs: Date.now() - startedAt,
      output: `${result.stdout}${result.stderr}`.slice(-OUTPUT_TAIL),
    });
  }
  const observed = runtime.endObservation();

  const gaps = redirectGaps(runtime, observed.services);
  for (const gap of gaps) {
    runtime.issues.file({
      type: 'redirect-gap',
      service: gap.service,
      sessionId: runtime.session,
      diagnosis: {
        reason:
          `A seal run exercised ${gap.service}, but nothing in the endpoint knowledge base points its client at the mock ` +
          'from the environment. Inside the sandbox the request still reaches the front door; outside it, it reaches the real service.',
      },
      suggestedResolution: gap.instruction,
      links: [`mocktown ekb list --service ${gap.service}`, 'mocktown env'],
    });
  }

  const failedFlows = flowResults.filter((flow) => flow.exitCode !== 0);
  const reasons = [
    ...failedFlows.map(
      (flow) => `Flow \`${flow.command}\` exited ${flow.exitCode}, so the coverage it was supposed to exercise cannot be claimed.`,
    ),
    ...observed.wallHits.map((hit) => `${hit.method} https://${hit.host}${hit.path} hit the deny wall (${hit.reason}).`),
    ...gaps.map((gap) => `${gap.service} has no mechanical redirect, so it would reach the real service outside the sandbox.`),
  ];

  const sealed = reasons.length === 0;
  const stamp = writeStamp(runtime.db, {
    commit,
    configHash: hash,
    sealed,
    flows,
    wallHits: observed.wallHits.length,
  });

  return {
    ok: sealed,
    sealed,
    instrument: 'sandbox',
    commit,
    configHash: hash,
    flows: flowResults,
    wallHits: observed.wallHits,
    gaps,
    servicesExercised: [...observed.services].sort(),
    reasons,
    stamp,
  };
}

/**
 * A gap is a service the flows *used* that `mocktown env` reports as not mechanically
 * covered. Judging un-exercised services would fail seals over dependencies the flows
 * never touch; judging only wall hits would pass a seal whose SDKs happen to be
 * proxy-aware today and stop being so after a bump.
 */
function redirectGaps(runtime: ProjectRuntime, exercised: Set<string>): SealGap[] {
  const artifacts = runtime.envArtifacts();
  return artifacts.report
    .filter((row) => !row.covered && exercised.has(row.service))
    .map((row) => ({
      service: row.service,
      rung: row.rung,
      instruction:
        artifacts.agentTasks.find((task) => task.service === row.service)?.instruction ??
        `Record how ${row.service}'s client is pointed at a mock: \`mocktown ekb add --service ${row.service} --rung <1|2|3> …\`.`,
    }));
}
