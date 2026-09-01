/**
 * The "scheduled" half of scheduled re-record runs (07-issues-agent-loop.md). It is a
 * timer in the daemon and nothing more — no cron file, no launchd plist, no second
 * process. A drift run only means anything while the daemon is up anyway, because that is
 * what owns the front door the re-record goes through.
 *
 * Three rules this scheduler is built around, all of them about not surprising anyone:
 *
 * - **It starts nothing that was not asked for.** A project with `drift.enabled: false` —
 *   the default — is never touched, and a config edit that turns the schedule off takes
 *   effect on the next tick without a daemon restart.
 * - **It never runs two checks at once**, per project or across them. A drift check takes
 *   over the front door and replaces the recording session, so a second concurrent run
 *   would be judging traffic the first one caused.
 * - **It defers to a human.** If the project is mid-record or mid-serve when a tick fires,
 *   the tick is skipped rather than yanking the mode out from under whoever is working.
 *   The next tick will find the project idle soon enough; a drift check is a daily
 *   question, not an urgent one.
 */
import { desc } from 'drizzle-orm';
import { runtimeFor } from '#src/daemon/runtime.ts';
import { schema } from '#src/db/client.ts';
import { checkDrift } from '#src/drift/watch.ts';

/** How often the timer looks; the interval that matters is per project and in hours. */
const TICK_MS = 5 * 60_000;

export interface DriftSchedulerOptions {
  /** Projects to consider. The daemon passes the registry, so a new project needs no restart. */
  projects: () => string[];
  tickMs?: number;
  /** Overridable so the test suite does not have to wait five minutes to prove a skip. */
  now?: () => number;
}

export class DriftScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private readonly options: DriftSchedulerOptions;
  /** Reasons the last tick did nothing, so `daemon status` can say why (and tests can assert). */
  lastSkips: string[] = [];

  constructor(options: DriftSchedulerOptions) {
    this.options = options;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.tickMs ?? TICK_MS);
    // Timers must not keep the process alive on their own: the daemon's lifetime is the
    // server's, and a pending drift tick should never be the reason it will not exit.
    this.timer.unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Exposed so a test — and `drift check` — can drive one pass deterministically. */
  async tick(): Promise<{ ran: string[]; skipped: string[] }> {
    const ran: string[] = [];
    const skipped: string[] = [];
    if (this.running) {
      this.lastSkips = ['a drift check is already in progress'];
      return { ran, skipped: this.lastSkips };
    }

    this.running = true;
    try {
      for (const project of this.options.projects()) {
        const verdict = this.due(project);
        if (verdict.due === false) {
          if (verdict.reason) skipped.push(`${project}: ${verdict.reason}`);
          continue;
        }
        await checkDrift(runtimeFor(project), { trigger: 'scheduled' });
        ran.push(project);
      }
    } finally {
      this.running = false;
    }

    this.lastSkips = skipped;
    return { ran, skipped };
  }

  /**
   * Whether this project wants a run right now. `reason` is only set for a skip worth
   * reporting — a project that simply has the schedule off is not a skip, it is a project
   * that never opted in.
   */
  private due(project: string): { due: boolean; reason?: string } {
    const runtime = runtimeFor(project);
    const config = runtime.resolved.file?.drift;
    if (!config?.enabled) return { due: false };

    if (runtime.mode.kind !== 'idle') {
      return { due: false, reason: `${runtime.mode.kind} mode is active, so the tick deferred to whoever is using it` };
    }

    const last = runtime.db.select().from(schema.driftRuns).orderBy(desc(schema.driftRuns.startedAt)).limit(1).get();
    if (!last) return { due: true };
    const elapsedHours = ((this.options.now?.() ?? Date.now()) - new Date(last.startedAt).getTime()) / 3600_000;
    return elapsedHours >= config.intervalHours ? { due: true } : { due: false };
  }
}
