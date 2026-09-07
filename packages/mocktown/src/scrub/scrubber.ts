/**
 * The scrubber — 10-security.md, "table stakes, phase 1". Verified against a real
 * captured corpus in spike 05 (14/14).
 *
 * Two passes, deliberately overlapping, because either alone leaks:
 *
 *   1. STRUCTURAL — parse headers, query strings, JSON and form bodies, and redact by
 *      *location*: this header is an auth header, this field name matches a deny pattern.
 *      Catches secrets that look like ordinary strings ("hunter2", a short API key).
 *   2. VALUE — scan every remaining string for things that look like credentials by
 *      *shape*: JWTs, vendor key prefixes, long high-entropy runs. Catches secrets in
 *      places nobody thought to name — a token in a redirect URL, a key echoed in an error.
 *
 * The overlap is a tested property, not luck: no single rule deletion may leak a
 * credential. Redaction is structured rather than destructive — values become
 * `{{secret:<kind>#<n>}}`, consistent within a session, so a generated mock can assert
 * "a Stripe secret key was required here" and `reinject()` can put a well-formed fake
 * back for replay, without a real secret ever reaching disk.
 */
import { DEFAULT_RULES, type ScrubRule } from '#src/scrub/rules.ts';

/** Shannon entropy per character, for the backstop below. */
export function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HIGH_ENTROPY_MIN_LENGTH = 24;
const HIGH_ENTROPY_MIN_BITS = 3.6;
/** Words that reach the entropy bar but are structural, not secret. */
const ENTROPY_ALLOWLIST = /^(?:[A-Za-z]+[-_][A-Za-z]+)+$/;

export function looksHighEntropy(value: string): boolean {
  if (value.length < HIGH_ENTROPY_MIN_LENGTH) return false;
  if (/\s/.test(value)) return false; // prose, not a credential
  if (ENTROPY_ALLOWLIST.test(value)) return false;

  // Long pure hex is a digest, a session id or a key — never business data. Shannon
  // entropy alone misses these: hex tops out at 4 bits/char and a real 48-char session
  // id measures ~3.59, just under any threshold loose enough to exclude timestamps.
  if (value.length >= 32 && /^[0-9a-f]+$/i.test(value)) return true;

  if (!/[0-9]/.test(value) || !/[A-Za-z]/.test(value)) return false; // needs mixed classes
  return entropy(value) >= HIGH_ENTROPY_MIN_BITS;
}

/**
 * Luhn is a checksum, not a classifier: roughly one bare integer in ten passes it by
 * chance, so on its own it turns the card rule into a generator of false positives. On one
 * recorded corpus it flagged 284 values and every single one was ordinary numeric data.
 *
 * This is the second guard, applied after the pattern's own lookarounds (see
 * `card-number` in rules.ts, which refuses a run that is part of a longer number — a
 * float's fractional digits are exactly that). It refuses a *bare* epoch timestamp, which
 * is what the rest of that corpus was: `"timestamp":1788789099537`, and later
 * `"time_unix_nano":1788789099537123456` in OTel trace data.
 *
 * Every precision has to be here, not just milliseconds. A timestamp is 13 digits in
 * milliseconds, 16 in microseconds and 19 in nanoseconds, and all three sit inside the
 * card rule's 13-to-19 range — 16 being the commonest card length of all. At each of those
 * lengths the epoch window for 2001 to 2033 is exactly "that many digits, leading 1", so
 * the test needs no arithmetic, which also keeps 19 digits away from
 * `Number.MAX_SAFE_INTEGER`.
 *
 * Nothing real is lost: no card issuer's IIN begins with 1 at these lengths — 13-digit
 * cards are legacy Visa (4), 16-digit are Visa, Mastercard, Discover and JCB (4, 5, 6, 3),
 * 19-digit are extended Visa and Discover (4, 6). The one card family that does begin with
 * 1, UATP, is 15 digits and therefore untouched here.
 *
 * Under-redacting is the dangerous direction, so the exception stays narrow: three exact
 * lengths, one leading digit, no separators.
 */
const EPOCH_DIGIT_LENGTHS = new Set([13, 16, 19]); // milli, micro, nano

function isEpochTimestamp(value: string): boolean {
  if (!/^\d+$/.test(value)) return false;
  if (!EPOCH_DIGIT_LENGTHS.has(value.length)) return false;
  return value[0] === '1';
}

/** The card rule's full test: shape guards first, then the checksum. */
export function isLikelyCardNumber(value: string): boolean {
  const trimmed = value.trim();
  if (isEpochTimestamp(trimmed)) return false;
  // A run of one repeated digit is padding, never a card. `0000000000000` sums to zero and
  // so passes Luhn perfectly.
  if (/^(\d)\1*$/.test(trimmed)) return false;
  return passesLuhn(trimmed);
}

export function passesLuhn(value: string): boolean {
  const digits = value.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0,
    double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * A redacted number, still a number.
 *
 * Redaction used to be `placeholderFor`, which returns a string, so a JSON number that
 * tripped a rule came back as `"{{secret:token#1}}"`. Scrubbing runs before disk, so the
 * original is gone and the corpus is left asserting a type the API never had — and
 * everything downstream believes it. `totalTokens` reached one corpus that way, the shape
 * inferred from it said `string`, and the mock built to match handed the client strings to
 * add up.
 *
 * The value is still redacted, because a PIN or a card can be written as a number and
 * under-redacting is the dangerous direction. What changes is that the redaction keeps the
 * type, the sign, the digit count either side of the point, and — through the registry —
 * its identity within the session. The result is deliberately never Luhn-valid, so
 * redacting a card can never emit a usable one.
 */
export function numberStub(literal: string, ordinal: number): string {
  const negative = literal.startsWith('-');
  const [whole = '', fraction] = literal.replace(/^-/, '').split('.');

  const run = (length: number, seed: number): string => {
    if (length <= 0) return '';
    const tail = String(seed);
    return tail.length >= length ? tail.slice(-length) : tail.padStart(length, '0');
  };

  // A stub that starts with 0 is a shorter number than the one it replaced, and the digit
  // count is the part a mock author reads to judge what the field was.
  let out = run(whole.length, ordinal);
  out = out.length === 0 ? '' : `9${out.slice(1)}`;
  if (passesLuhn(out)) out = `${out.slice(0, -1)}${(Number(out.at(-1)) + 1) % 10}`;

  const digits = fraction === undefined ? out : `${out}.${run(fraction.length, ordinal)}`;
  return negative ? `-${digits}` : digits;
}

/** One numeric field the scrubber redacted, for the mock author to rule on. */
export interface NumericRedaction {
  field: string;
  kind: string;
  digits: number;
}

export interface Exchange {
  id: string;
  method: string;
  url: string;
  statusCode: number;
  requestHeaders: Record<string, string | string[]>;
  requestBody: string;
  responseHeaders: Record<string, string | string[]>;
  responseBody: string;
}

export interface AuditFinding {
  exchangeId: string;
  where: string;
  kind: string;
  sample: string;
}

/**
 * One scrubber per recording session. The placeholder registry is session-scoped, which
 * is what makes `{{secret:stripe-secret-key#1}}` mean "the same key you saw earlier in
 * this session" — the property generated mocks rely on to correlate a credential across
 * requests without ever seeing it.
 */
/**
 * `JSON.rawJSON` / `JSON.isRawJSON` are ES2025 and implemented by both JavaScriptCore and
 * V8, but TypeScript 7's `lib.esnext` has not caught up. Declared here rather than widened
 * to `any` at the call sites, so the compiler still checks how they are used.
 */
declare global {
  interface JSON {
    rawJSON(text: string): { readonly rawJSON: string };
    isRawJSON(value: unknown): boolean;
  }
}

/**
 * `JSON.parse` then `JSON.stringify` is not the identity on a JSON document. Every number
 * becomes an IEEE double on the way in, so an integer past 2^53 comes back changed:
 * `1788789099537123456` is written out as `1788789099537123300`. Real corpora are full of
 * these — an OpenTelemetry `time_unix_nano` is exactly 19 digits — and the corruption is
 * silent, which makes it worse than a crash: the recording still looks like a recording,
 * and a mock generated from it returns a timestamp that was never sent.
 *
 * The reviver's `source` is the literal as written. Wrapping only the literals that would
 * actually change keeps ordinary numbers as numbers, so the field rules downstream still
 * see a number where the document had one.
 */
function parsePreservingNumbers(text: string): unknown {
  return JSON.parse(text, function reviveExactly(_key, value, context?: { source?: string }) {
    const source = context?.source;
    if (typeof value === 'number' && source !== undefined && String(value) !== source) return JSON.rawJSON(source);
    return value;
  });
}

export class Scrubber {
  private readonly registry = new Map<string, string>(); // secret value -> placeholder
  private readonly numbers = new Map<string, string>(); // numeric literal -> numeric stub
  private readonly numeric: NumericRedaction[] = [];
  private readonly kindCounts = new Map<string, number>();
  readonly rules: ScrubRule[];
  private readonly entropyBackstop: boolean;

  /**
   * @param entropyBackstop the heuristic catch-all from 10-security.md. Switchable so its
   * contribution stays measurable — with it off, removing a vendor rule leaks; with it on,
   * the same removal is covered. Defence in depth should be demonstrable, not assumed.
   */
  constructor(rules: ScrubRule[] = DEFAULT_RULES, entropyBackstop = true) {
    this.rules = rules;
    this.entropyBackstop = entropyBackstop;
  }

  /**
   * Shape wins over location: a Stripe key in an Authorization header is
   * `stripe-secret-key`, not `auth-header`. Location-based rules supply the kind only
   * when nothing recognises the value's shape.
   */
  private classify(value: string, fallbackKind: string): string {
    const trimmed = value.trim();
    for (const rule of this.rules) {
      if (!rule.pattern) continue;
      if (new RegExp(`^(?:${rule.pattern.source})$`).test(trimmed)) {
        if (rule.kind === 'card-number' && !isLikelyCardNumber(trimmed)) continue;
        return rule.kind;
      }
    }
    return fallbackKind;
  }

  private placeholderFor(value: string, kind: string): string {
    const existing = this.registry.get(value);
    if (existing) return existing;
    const ordinal = (this.kindCounts.get(kind) ?? 0) + 1;
    this.kindCounts.set(kind, ordinal);
    const placeholder = `{{secret:${kind}#${ordinal}}}`;
    this.registry.set(value, placeholder);
    return placeholder;
  }

  /**
   * Redact a numeric literal without changing its type.
   *
   * The kind comes from the field name alone — no `classify`. Shape classification exists
   * to say "this string is a Stripe key wherever it turned up", and on a bare integer it
   * has almost nothing to go on: `48211234567890123` passes Luhn and lands on
   * `card-number`, which is how a token count became a credit card. A number's only honest
   * evidence is the name of the field holding it.
   */
  private redactNumber(literal: string, kind: string, field: string): string {
    const existing = this.numbers.get(literal);
    if (existing) return existing;
    const ordinal = (this.kindCounts.get(kind) ?? 0) + 1;
    this.kindCounts.set(kind, ordinal);
    const stub = numberStub(literal, ordinal);
    this.numbers.set(literal, stub);
    this.numeric.push({ field, kind, digits: literal.replace(/[^0-9]/g, '').length });
    return stub;
  }

  /** Pass 2: redact by shape, anywhere in a string. */
  private scrubValue(value: string): string {
    let out = value;
    for (const rule of this.rules) {
      if (!rule.pattern) continue;
      out = out.replace(rule.pattern, (match) => {
        if (match.startsWith('{{secret:')) return match;
        if (rule.kind === 'card-number' && !isLikelyCardNumber(match)) return match;
        return this.placeholderFor(match, rule.kind);
      });
    }
    if (!this.entropyBackstop) return out;
    out = out.replace(/[A-Za-z0-9_\-.]{24,}/g, (token) => {
      if (token.startsWith('{{secret:')) return token;
      const known = this.registry.get(token);
      if (known) return known;
      return looksHighEntropy(token) ? this.placeholderFor(token, 'high-entropy') : token;
    });
    return out;
  }

  /** Pass 1 for headers: whole-value redaction by header name. */
  private scrubHeaders(headers: Record<string, string | string[]>): Record<string, string | string[]> {
    const out: Record<string, string | string[]> = {};
    for (const [name, raw] of Object.entries(headers)) {
      const lower = name.toLowerCase();
      const rule = this.rules.find((r) => r.headers?.includes(lower));
      const scrubOne = (v: string) => {
        if (!rule) return this.scrubValue(v);
        // Keep the scheme ("Bearer", "token") — it is protocol shape, not a secret, and a
        // generated mock needs it to reproduce the auth challenge.
        const scheme = /^(Bearer|Basic|token|Digest)\s+/i.exec(v);
        if (scheme) {
          const credential = v.slice(scheme[0]!.length);
          return `${scheme[1]} ${this.placeholderFor(credential, this.classify(credential, rule.kind))}`;
        }
        if (lower === 'cookie' || lower === 'set-cookie') {
          return scrubCookie(v, (secret) => this.placeholderFor(secret, this.classify(secret, rule.kind)));
        }
        return this.placeholderFor(v, this.classify(v, rule.kind));
      };
      out[name] = Array.isArray(raw) ? raw.map(scrubOne) : scrubOne(raw);
    }
    return out;
  }

  /**
   * The rule that would redact a field with this name, if any.
   *
   * Public because it is the only honest way to annotate a generated schema. Matching is a
   * pure function of the field name against the rule set, so schema generation can ask the
   * same question after the fact and get the same answer the recorder got — no need to
   * persist a per-field audit trail, and it works on a corpus recorded before this existed.
   * The match is a substring, so `totalTokens` trips the `token` rule: weak evidence, which
   * is exactly why the schema says so rather than deciding.
   */
  fieldRule(name: string): ScrubRule | undefined {
    const lower = name.toLowerCase();
    return this.rules.find((r) => r.fields?.some((f) => lower === f || lower.includes(f)));
  }

  private scrubField(name: string, value: string): string {
    const rule = this.fieldRule(name);
    if (rule && value) return this.placeholderFor(value, this.classify(value, rule.kind));
    return this.scrubValue(value);
  }

  private scrubJson(node: unknown, keyName = ''): unknown {
    if (typeof node === 'string') return this.scrubField(keyName, node);
    // A number too precise to survive the round-trip arrives wrapped (see
    // `parsePreservingNumbers`). It is still a number to the field rules, and it is not an
    // object, so this has to come before the object branch below or the wrapper is
    // destructured into `{ rawJSON: … }`.
    if (JSON.isRawJSON(node)) {
      const literal = (node as { rawJSON: string }).rawJSON;
      const rule = this.fieldRule(keyName);
      // Back out as rawJSON too: a 19-digit stub written as a JS number would lose the
      // last digits, which is the corruption `parsePreservingNumbers` exists to prevent.
      return rule ? JSON.rawJSON(this.redactNumber(literal, rule.kind, keyName)) : node;
    }
    if (typeof node === 'number') {
      const rule = this.fieldRule(keyName);
      if (rule) return JSON.rawJSON(this.redactNumber(String(node), rule.kind, keyName));
    }
    if (Array.isArray(node)) return node.map((item) => this.scrubJson(item, keyName));
    if (node && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, this.scrubJson(v, k)]));
    }
    return node;
  }

  /**
   * Pass 2 on a bare string, for the places that are neither a header nor a body: a feed
   * summary, a drift diff line, a path segment. Placeholders stay consistent with the rest
   * of the session because the registry is shared.
   */
  scrubText(text: string): string {
    return this.scrubValue(text);
  }

  /**
   * Pass 1 for bodies: redact by field name, keeping the document's structure intact.
   *
   * The format is decided by **what the body is**, not by what the `content-type` claims.
   * Field-name rules are the only layer that can catch a secret with no shape of its own —
   * a password is just a word — so gating them on a header the client chose is gating the
   * strongest layer on the least trustworthy input. `fetch(url, { body: JSON.stringify(x) })`
   * with no explicit header sends `text/plain;charset=UTF-8`, which is how a real login
   * body reached the corpus with its `password` field in the clear: the JSON branch never
   * ran, and pass 2 has no field names to reason about. Parsing is the test — a body that
   * is not JSON throws and falls through, costing one failed parse per non-JSON body.
   */
  scrubBody(body: string, contentType: string): string {
    if (!body) return body;
    // A JSON document starts with `{` or `[` after whitespace; anything else cannot parse,
    // so this only skips the attempt, never a real document.
    if (contentType.includes('json') || /^\s*[{[]/.test(body)) {
      try {
        return JSON.stringify(this.scrubJson(parsePreservingNumbers(body)));
      } catch {
        // Not valid JSON after all — fall through to the shape rules.
      }
    }
    if (contentType.includes('x-www-form-urlencoded')) {
      const out = new URLSearchParams();
      for (const [key, value] of new URLSearchParams(body)) out.append(key, this.scrubField(key, value));
      return out.toString();
    }
    return this.scrubValue(body);
  }

  scrub(exchange: Exchange): Exchange {
    const reqType = String(exchange.requestHeaders['content-type'] ?? '');
    const resType = String(exchange.responseHeaders['content-type'] ?? '');
    const url = new URL(exchange.url);
    for (const [key, value] of [...url.searchParams]) url.searchParams.set(key, this.scrubField(key, value));

    return {
      ...exchange,
      url: url.toString(),
      requestHeaders: this.scrubHeaders(exchange.requestHeaders),
      responseHeaders: this.scrubHeaders(exchange.responseHeaders),
      requestBody: this.scrubBody(exchange.requestBody, reqType),
      responseBody: this.scrubBody(exchange.responseBody, resType),
    };
  }

  /**
   * Replay: put a well-formed *fake* credential back where each placeholder sits, so a
   * mock can be exercised against traffic with the right shape while no real secret
   * exists anywhere.
   */
  reinject(text: string): string {
    return text.replace(/\{\{secret:([a-z0-9-]+)#(\d+)\}\}/gi, (_match, kind: string, ordinal: string) => {
      const rule = this.rules.find((r) => r.kind === kind);
      return rule?.fake ? rule.fake(Number(ordinal)) : `mocktown-${kind}-${ordinal}`;
    });
  }

  /** Backs `mocktown scrub audit`: re-scan already-scrubbed material for anything missed. */
  audit(corpus: Exchange[]): AuditFinding[] {
    const findings: AuditFinding[] = [];
    for (const exchange of corpus) {
      const places: [string, string][] = [
        ['url', exchange.url],
        ['requestHeaders', JSON.stringify(exchange.requestHeaders)],
        ['responseHeaders', JSON.stringify(exchange.responseHeaders)],
        ['requestBody', exchange.requestBody],
        ['responseBody', exchange.responseBody],
      ];
      for (const [where, text] of places) {
        if (!text) continue;
        for (const rule of this.rules) {
          if (!rule.pattern) continue;
          for (const match of text.matchAll(rule.pattern)) {
            if (rule.kind === 'card-number' && !isLikelyCardNumber(match[0])) continue;
            findings.push({ exchangeId: exchange.id, where, kind: rule.kind, sample: match[0].slice(0, 24) });
          }
        }
      }
    }
    return findings;
  }

  /** What was found, for the recording's metadata. Values are never included. */
  summary(): { kind: string; count: number }[] {
    return [...this.kindCounts].map(([kind, count]) => ({ kind, count })).sort((a, b) => a.kind.localeCompare(b.kind));
  }

  /**
   * Numeric fields this session redacted, for a mock author to overrule.
   *
   * A field name is weak evidence — `totalTokens` matches the `token` rule and is a
   * counter — so the scrubber redacts, says so, and leaves the call to whoever can read
   * the client. Names, never values.
   */
  numericRedactions(): NumericRedaction[] {
    return [...this.numeric];
  }
}

function scrubCookie(value: string, redact: (secret: string) => string): string {
  return value
    .split(/;\s*/)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 1) return part; // flags like HttpOnly, Secure
      const name = part.slice(0, eq);
      if (/^(Path|Domain|Expires|Max-Age|SameSite|Priority|Version)$/i.test(name)) return part;
      return `${name}=${redact(part.slice(eq + 1))}`;
    })
    .join('; ');
}
