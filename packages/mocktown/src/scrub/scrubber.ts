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
export class Scrubber {
  private readonly registry = new Map<string, string>(); // secret value -> placeholder
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
        if (rule.kind === 'card-number' && !passesLuhn(trimmed)) continue;
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

  /** Pass 2: redact by shape, anywhere in a string. */
  private scrubValue(value: string): string {
    let out = value;
    for (const rule of this.rules) {
      if (!rule.pattern) continue;
      out = out.replace(rule.pattern, (match) => {
        if (match.startsWith('{{secret:')) return match;
        if (rule.kind === 'card-number' && !passesLuhn(match)) return match;
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

  private fieldRule(name: string): ScrubRule | undefined {
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
    if (typeof node === 'number') {
      const rule = this.fieldRule(keyName);
      if (rule) return this.placeholderFor(String(node), this.classify(String(node), rule.kind));
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

  /** Pass 1 for bodies: redact by field name, keeping the document's structure intact. */
  scrubBody(body: string, contentType: string): string {
    if (!body) return body;
    if (contentType.includes('json')) {
      try {
        return JSON.stringify(this.scrubJson(JSON.parse(body)));
      } catch {
        return this.scrubValue(body); // not valid JSON after all
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
            if (rule.kind === 'card-number' && !passesLuhn(match[0])) continue;
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
