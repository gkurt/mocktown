/**
 * Client-runtime noise — the requests a *browser* makes because it is a browser, not
 * because the app under test asked for anything.
 *
 * Rung 2 ([03-capture.md](../../../../docs/design/03-capture.md)) records everything the
 * launched window does, and a real browser talks constantly to its own vendor: component
 * updates, Safe Browsing lists, sign-in probes, new-tab-page furniture, telemetry. Measured
 * on one attended session against a staging app, 17 of the 22 discovered services were
 * Chrome's own and 5 were the app's. That corpus is not wrong, it is unusable — and
 * every one of those hosts also became a service row, an issue, and a line in the feed.
 *
 * Two mechanisms, in this order:
 *
 *  1. **Do not make the request.** `browserArgs` passes the flags that switch this traffic
 *     off at the source, which is strictly better than filtering it afterwards. Measured on
 *     Chrome 152 headless: the flags took the attempted hosts from 7 to 5 and, with
 *     `about:blank` in place of the new tab page, the attempts from 23 to 11.
 *  2. **This filter,** for the rest. The flags do not cover everything, they are Chrome's
 *     alone, and the other capture rungs never see them at all.
 *
 * What this filter does *not* do is let anything out. A match is dropped from the corpus and
 * from the issue queue; it is not promoted to passthrough. In serve mode an ignored request
 * still hits the deny wall, it just does not file an issue for it — because the front door's
 * one inviolable rule is that nothing reaches a real upstream silently
 * ([02-architecture.md](../../../../docs/design/02-architecture.md)).
 *
 * **A host is only ignored wholesale when it serves nothing but client infrastructure.**
 * Otherwise the pattern is path-scoped, because these hostnames are shared with things an
 * app genuinely depends on: the same recording that produced this list also contained
 * `fonts.googleapis.com/css2` (the app's web font) and `accounts.google.com` is where a real
 * OAuth flow lives. A blanket `*.googleapis.com` would have silently eaten both, which is a
 * worse failure than the noise it cleaned up.
 */

export interface NoisePattern {
  /** Exact hostname, or `*.suffix` for a family. */
  host: string;
  /**
   * Path prefixes this applies to. Absent means the whole host, which is only correct for a
   * hostname that serves client infrastructure and nothing else.
   */
  paths?: string[];
  /** Why this is the client's own traffic. Shown when the counts are reported. */
  why: string;
}

/**
 * The defaults. Every Chrome entry below was observed in a real attended recording, and the
 * path-scoped ones are scoped because that host also carried app traffic in the same session.
 */
export const DEFAULT_NOISE: NoisePattern[] = [
  // ── Chrome's component updater and the CDN it pulls from ───────────────────────────────
  // By volume this is nearly all of it: the payloads are multi-megabyte CRX files.
  { host: 'update.googleapis.com', why: "Chrome's component updater" },
  { host: 'clientservices.googleapis.com', why: "Chrome's variations seed" },
  { host: 'clients2.googleusercontent.com', why: 'Chrome component payloads' },
  { host: '*.gvt1.com', why: "Google's binary CDN — Chrome component and extension payloads" },
  { host: 'clients2.google.com', paths: ['/service/update2/', '/time/'], why: "Chrome's component updater and time sync" },
  { host: 'www.googleapis.com', paths: ['/chromewebstore/'], why: "Chrome's extension store" },

  // ── The features that phone home on their own schedule ─────────────────────────────────
  { host: 'safebrowsing.googleapis.com', why: 'Safe Browsing list updates' },
  { host: 'sb-ssl.google.com', why: 'Safe Browsing' },
  { host: 'optimizationguide-pa.googleapis.com', why: "Chrome's optimization hints and on-device models" },
  { host: 'content-autofill.googleapis.com', why: "Chrome's autofill server" },
  { host: 'android.clients.google.com', paths: ['/c2dm/', '/checkin'], why: 'Chrome push registration (GCM)' },
  // The captive-portal probe, observed on a headless Chromium driven by agent-browser — where
  // it was the only thing the session recorded. It rotates across hosts; the two it shares
  // with real content are path-scoped in the block below.
  { host: 'connectivitycheck.gstatic.com', why: "Chrome's captive-portal probe" },

  // ── Shared hostnames: path-scoped, because the app uses these too ──────────────────────
  { host: 'www.google.com', paths: ['/async/', '/complete/search', '/gen_204'], why: 'new tab page and omnibox suggestions' },
  {
    host: 'accounts.google.com',
    paths: ['/ListAccounts'],
    why: "Chrome's sign-in probe — a real OAuth flow on this host is still recorded",
  },
  { host: 'www.gstatic.com', paths: ['/og/', '/chrome/', '/ohttp_gateway/', '/images/branding/'], why: 'Chrome UI assets' },
  // The two hosts the captive-portal probe shares with real content, scoped to its own path.
  { host: 'www.gstatic.com', paths: ['/generate_204'], why: "Chrome's captive-portal probe" },
  { host: 'clients3.google.com', paths: ['/generate_204'], why: "Chrome's captive-portal probe" },
  { host: 'play.google.com', paths: ['/log'], why: 'Chrome telemetry' },

  // ── Other clients, for the same reason ─────────────────────────────────────────────────
  // Not measured here, unlike the Chrome entries above — included because each of these
  // hostnames exists for exactly one purpose and can never be an app dependency.
  { host: 'detectportal.firefox.com', why: "Firefox's captive-portal probe" },
  { host: 'incoming.telemetry.mozilla.org', why: 'Firefox telemetry' },
  { host: 'push.services.mozilla.com', why: 'Firefox push' },
  { host: 'captive.apple.com', why: "macOS's captive-portal probe" },
  { host: 'www.msftconnecttest.com', why: "Windows's connectivity probe" },
];

export interface NoiseConfig {
  /** Whether `DEFAULT_NOISE` applies at all. */
  ignoreNoise?: boolean;
  /** Extra patterns, as `host` or `host/path-prefix`. */
  ignore?: string[];
  /** Patterns to record despite a default matching them, same syntax. Wins over both lists. */
  keep?: string[];
}

/** `api.example.com/v1/` -> a one-path pattern; `api.example.com` -> a whole-host one. */
function parsePattern(entry: string, why: string): NoisePattern {
  const slash = entry.indexOf('/');
  if (slash === -1) return { host: entry, why };
  return { host: entry.slice(0, slash), paths: [entry.slice(slash)], why };
}

function hostMatches(pattern: string, host: string): boolean {
  if (!pattern.startsWith('*.')) return pattern === host;
  const suffix = pattern.slice(2);
  return host === suffix || host.endsWith(`.${suffix}`);
}

function patternMatches(pattern: NoisePattern, host: string, path: string): boolean {
  if (!hostMatches(pattern.host, host)) return false;
  return pattern.paths === undefined || pattern.paths.some((prefix) => path.startsWith(prefix));
}

export class NoiseFilter {
  private readonly patterns: NoisePattern[];
  private readonly keep: NoisePattern[];

  constructor(config: NoiseConfig = {}) {
    const defaults = config.ignoreNoise === false ? [] : DEFAULT_NOISE;
    this.patterns = [...defaults, ...(config.ignore ?? []).map((entry) => parsePattern(entry, 'ignored by mocktown.json'))];
    this.keep = (config.keep ?? []).map((entry) => parsePattern(entry, 'kept by mocktown.json'));
  }

  /** The pattern this URL is noise under, or `null` if it is evidence about a real service. */
  match(url: string): NoisePattern | null {
    let host: string;
    let path: string;
    try {
      const parsed = new URL(url);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      // An unparseable URL is not something to quietly drop.
      return null;
    }
    // `keep` is checked first so a project can always get a default back, per host or per path.
    if (this.keep.some((pattern) => patternMatches(pattern, host, path))) return null;
    return this.patterns.find((pattern) => patternMatches(pattern, host, path)) ?? null;
  }
}

/** What was dropped, for the report. Silence is the thing this feature must not add. */
export class NoiseTally {
  private readonly counts = new Map<string, { count: number; why: string }>();

  note(pattern: NoisePattern): void {
    const label = pattern.paths ? `${pattern.host}${pattern.paths[0]}` : pattern.host;
    const existing = this.counts.get(label);
    if (existing) existing.count++;
    else this.counts.set(label, { count: 1, why: pattern.why });
  }

  get total(): number {
    let sum = 0;
    for (const { count } of this.counts.values()) sum += count;
    return sum;
  }

  entries(): { pattern: string; count: number; why: string }[] {
    return [...this.counts.entries()]
      .map(([pattern, { count, why }]) => ({ pattern, count, why }))
      .sort((a, b) => b.count - a.count || a.pattern.localeCompare(b.pattern));
  }

  reset(): void {
    this.counts.clear();
  }
}
