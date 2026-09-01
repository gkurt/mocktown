/**
 * The feed: what just happened in this project, as a bounded stream every surface can
 * read. It backs the GUI's live request feed (09-gui-plugins.md) and gives agents and
 * `curl` the same view.
 *
 * **Decision (phase 4): the feed is a cursor'd long poll, not SSE.** 09-gui-plugins.md
 * requires that everything visible in the GUI come through the public daemon API, and
 * that panels — single-file HTML with no build step — talk to that same API. A plain
 * `GET /feed?since=<seq>&waitMs=<n>` that returns as soon as there is an event satisfies
 * both: it is push-shaped in practice, it is one `fetch` in a panel, it renders in the
 * CLI, and it is a normal procedure on all three surfaces so the contract's house rules
 * (`--json`, a renderer, `readOnlyHint` from the method) still apply to it.
 * *Rejected:* an oRPC event iterator over SSE — the transport is nicer, but an async
 * iterator is not a value the CLI can render or an MCP tool can return, so the feed would
 * have become the one capability that exists on one surface only.
 *
 * The feed carries **no bodies**. A one-line summary of an exchange is enough to watch
 * traffic go by, and the corpus is where payloads live — already scrubbed. Paths still go
 * through the scrubber before they reach an event, because a credential in a path segment
 * is a real pattern (10-security.md).
 */
export type FeedEventKind = 'exchange' | 'wall-hit' | 'issue' | 'provider' | 'session' | 'socket' | 'drift';

export interface FeedEvent {
  /** Monotonic within a daemon lifetime. This is the cursor clients pass back as `since`. */
  seq: number;
  at: string;
  kind: FeedEventKind;
  service: string | null;
  method: string | null;
  /** Templated and scrubbed — `/orders/{orderId}`, never a raw query string. */
  path: string | null;
  statusCode: number | null;
  /** Which front-door mode served it: record, mock, passthrough, deny. */
  mode: string | null;
  durationMs: number | null;
  /** One line, safe to render as text. Untrusted in origin — never treated as markup. */
  summary: string;
  /** A recording id, issue id or provider name, so a client can go read the detail. */
  ref: string | null;
}

export type FeedInput = Omit<FeedEvent, 'seq' | 'at'>;

/**
 * The feed is a window, not a log — the corpus and the issue queue are the durable
 * record. A client that falls this far behind gets a gap, and is told so by the cursor.
 */
const RING_CAPACITY = 500;

/** Longest a long poll may park. Kept under the usual 30s proxy/browser idle timeouts. */
export const MAX_FEED_WAIT_MS = 25_000;

export class FeedBus {
  private ring: FeedEvent[] = [];
  private nextSeq = 1;
  private waiters: (() => void)[] = [];

  /** The oldest event still in the window: a client whose cursor predates it missed some. */
  get oldestSeq(): number {
    return this.ring[0]?.seq ?? this.nextSeq;
  }

  get cursor(): number {
    return this.nextSeq - 1;
  }

  publish(input: FeedInput): FeedEvent {
    const event: FeedEvent = { seq: this.nextSeq++, at: new Date().toISOString(), ...input };
    this.ring.push(event);
    if (this.ring.length > RING_CAPACITY) this.ring.splice(0, this.ring.length - RING_CAPACITY);
    const woken = this.waiters;
    this.waiters = [];
    for (const wake of woken) wake();
    return event;
  }

  since(cursor: number, limit: number): FeedEvent[] {
    return this.ring.filter((event) => event.seq > cursor).slice(0, limit);
  }

  /**
   * Wait for the first event after `cursor`, or give up. Returning empty on timeout is
   * the normal case for a quiet project, and a client just polls again with the same
   * cursor — so a timeout is not an error anywhere in the stack.
   */
  async wait(cursor: number, waitMs: number): Promise<void> {
    if (this.cursor > cursor) return;
    const capped = Math.min(Math.max(waitMs, 0), MAX_FEED_WAIT_MS);
    if (capped === 0) return;
    await new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      timer = setTimeout(finish, capped);
      this.waiters.push(finish);
    });
  }
}

/** Summaries are written once, here, so the CLI, the GUI and a panel read the same words. */
export const summarize = {
  exchange: (mode: string, method: string, service: string, path: string, status: number) =>
    `${mode} ${method} ${service}${path} -> ${status}`,
  wallHit: (method: string, service: string, path: string, reason: string) => `DENIED ${method} ${service}${path} (${reason})`,
  issue: (type: string, service: string, status: string, occurrences: number) => {
    const seen = occurrences > 1 ? ` (seen ${occurrences} times)` : '';
    return status === 'open' ? `issue ${type} filed on ${service}${seen}` : `issue ${type} on ${service} -> ${status}${seen}`;
  },
};
