/**
 * The determinism contract from 12-scenario-controls.md: **same seed + same knob values
 * + same profile + same request sequence -> byte-identical responses.**
 *
 * That is only achievable if randomness is addressed rather than sequential. A single
 * global stream would make every response depend on request *ordering* elsewhere in the
 * app, so the stream key is
 *
 *     hash(sessionSeed, service, endpoint, profile, stableRequestIdentity)
 *
 * and the same GET for the same profile in the same session always lands on the same
 * value, however much other traffic interleaves.
 */

/** mulberry32: small, fast, deterministic, and good enough for mock data. */
export class Prng {
  private state: number;

  constructor(seedText: string) {
    // FNV-1a over the stream key gives a well-distributed 32-bit starting state.
    let h = 0x811c9dc5;
    for (let i = 0; i < seedText.length; i++) {
      h ^= seedText.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this.state = h || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(min: number, max: number): number {
    if (max < min) [min, max] = [max, min];
    return min + Math.floor(this.next() * (max - min + 1));
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error("pick() needs a non-empty list");
    return items[this.int(0, items.length - 1)]!;
  }

  bool(trueProbability = 0.5): boolean {
    return this.next() < trueProbability;
  }

  /** A stable id of the requested shape — mock data that survives a re-run unchanged. */
  id(prefix = "mck"): string {
    let out = "";
    for (let i = 0; i < 16; i++) out += "0123456789abcdefghijklmnopqrstuvwxyz"[this.int(0, 35)];
    return `${prefix}_${out}`;
  }
}

/**
 * The stream key. `requestIdentity` deliberately excludes volatile parts of a request
 * (timestamps, request ids) — including them would make every replay diverge, which the
 * verify harness would then report as drift.
 */
export function streamKey(parts: {
  sessionSeed: string;
  service: string;
  endpoint: string;
  profile: string;
  requestIdentity: string;
}): string {
  return [parts.sessionSeed, parts.service, parts.endpoint, parts.profile, parts.requestIdentity].join(" ");
}
