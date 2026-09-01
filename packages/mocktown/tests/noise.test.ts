/**
 * The noise filter — the corpus's editorial line about what counts as evidence.
 *
 * Two properties matter more than any individual pattern. First, **a shared hostname is
 * never ignored wholesale**: the recording that motivated this filter contained both
 * `www.gstatic.com/og/` (Chrome's own UI) and `fonts.googleapis.com/css2` (the app's web
 * font), so a host-level rule would have quietly eaten a real dependency. Second, **an
 * ignore is not a passthrough** — the filter decides what is written down, never what is
 * allowed out.
 */
import { describe, expect, test } from 'bun:test';

const { DEFAULT_NOISE, NoiseFilter, NoiseTally } = await import('#src/capture/noise.ts');

const filter = new NoiseFilter();
const ignored = (url: string) => filter.match(url) !== null;

describe('what the default list drops', () => {
  test("drops the browser's own infrastructure", () => {
    for (const url of [
      'https://update.googleapis.com/service/update2/json',
      'https://edgedl.me.gvt1.com/edgedl/release2/chrome_component/abc/def.crx3',
      'https://r1---sn-u0g3oxu-pnuk.gvt1.com/edgedl/x',
      'https://redirector.gvt1.com/edgedl/chromewebstore/y/1.0.0.6_nmmhk.crx',
      'https://clientservices.googleapis.com/chrome-variations/seed',
      'https://safebrowsing.googleapis.com/v4/threatListUpdates:fetch',
      'https://optimizationguide-pa.googleapis.com/downloads',
      'https://content-autofill.googleapis.com/v1/pages/ChRDaHJvbWU',
      'https://clients2.google.com/service/update2/crx',
      'https://android.clients.google.com/c2dm/register3',
      'https://www.google.com/async/newtab_promos',
      'https://www.google.com/complete/search?q=a',
      'https://accounts.google.com/ListAccounts',
      'https://www.gstatic.com/og/_/js/k=og.qtm.en_US',
      'https://www.googleapis.com/chromewebstore/v1.1/items/verify',
      'https://play.google.com/log',
    ]) {
      expect(ignored(url)).toBe(true);
    }
  });

  test('never takes a whole hostname the app also uses', () => {
    // Every one of these was in the same session as the noise above.
    expect(ignored('https://fonts.googleapis.com/css2?family=Inter')).toBe(false);
    expect(ignored('https://fonts.gstatic.com/s/inter/v13/font.woff2')).toBe(false);
    expect(ignored('https://www.gstatic.com/my-app/logo.svg')).toBe(false);
    expect(ignored('https://www.googleapis.com/oauth2/v3/userinfo')).toBe(false);
    expect(ignored('https://www.google.com/maps/api/geocode/json')).toBe(false);
    expect(ignored('https://app-staging.example.com/api/v1/orgs')).toBe(false);
  });

  test('leaves a real OAuth flow on a host it otherwise filters', () => {
    // `accounts.google.com` is both Chrome's sign-in probe and where every Google OAuth
    // dance happens. Only the probe is noise.
    expect(ignored('https://accounts.google.com/ListAccounts')).toBe(true);
    expect(ignored('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')).toBe(false);
    expect(ignored('https://accounts.google.com/o/oauth2/token')).toBe(false);
  });

  test('every entry says why, because the report prints it', () => {
    for (const pattern of DEFAULT_NOISE) expect(pattern.why.length).toBeGreaterThan(8);
  });
});

describe('what a project can say about it', () => {
  test('keep wins over a default, per host or per path', () => {
    const host = new NoiseFilter({ keep: ['accounts.google.com'] });
    expect(host.match('https://accounts.google.com/ListAccounts')).toBeNull();

    const path = new NoiseFilter({ keep: ['www.google.com/async/ddljson'] });
    expect(path.match('https://www.google.com/async/ddljson')).toBeNull();
    // Scoped: the rest of the pattern it was carved out of still applies.
    expect(path.match('https://www.google.com/async/newtab_promos')).not.toBeNull();
  });

  test('ignore adds patterns, and ignoreNoise:false removes every default', () => {
    const extra = new NoiseFilter({ ignore: ['telemetry.example.com', 'api.example.com/health'] });
    expect(extra.match('https://telemetry.example.com/v1/events')).not.toBeNull();
    expect(extra.match('https://api.example.com/health')).not.toBeNull();
    expect(extra.match('https://api.example.com/v1/orders')).toBeNull();

    const off = new NoiseFilter({ ignoreNoise: false });
    expect(off.match('https://update.googleapis.com/service/update2/json')).toBeNull();
    // The project's own list is not a default, so it survives the switch.
    const offWithExtra = new NoiseFilter({ ignoreNoise: false, ignore: ['telemetry.example.com'] });
    expect(offWithExtra.match('https://telemetry.example.com/v1/events')).not.toBeNull();
  });

  test('an unparseable URL is never dropped', () => {
    // Silently discarding something we could not even read is the opposite of the point.
    expect(filter.match('not-a-url')).toBeNull();
  });
});

describe('the tally', () => {
  test('groups by pattern and orders by weight, carrying the reason', () => {
    const tally = new NoiseTally();
    const updater = DEFAULT_NOISE.find((p) => p.host === 'update.googleapis.com')!;
    const telemetry = DEFAULT_NOISE.find((p) => p.host === 'play.google.com')!;
    for (let i = 0; i < 5; i++) tally.note(updater);
    tally.note(telemetry);

    expect(tally.total).toBe(6);
    const entries = tally.entries();
    expect(entries[0]).toEqual({ pattern: 'update.googleapis.com', count: 5, why: updater.why });
    expect(entries[1]!.pattern).toBe('play.google.com/log');

    tally.reset();
    expect(tally.total).toBe(0);
  });
});
