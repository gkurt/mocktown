/**
 * Scrub rules — 10-security.md's defaults, plus whatever a project adds. Rules are
 * policy, not secrets, so they live in the committed `mocktown.json`.
 *
 * Ordering matters: shape-recognised vendor credentials come first, so a Stripe key in
 * an Authorization header is labelled `stripe-secret-key` and not `auth-header`. The
 * label is the part a generated mock reasons about, and the part that lets replay
 * re-inject a correctly-shaped fake (spike 05).
 */
export interface ScrubRule {
  /** Stable identifier, and the `kind` that appears in the placeholder. */
  kind: string;
  /** Header names (lowercase) whose entire value is a secret. */
  headers?: string[];
  /** Body/query field names that hold secrets. Matched case-insensitively as substrings. */
  fields?: string[];
  /** Values matching this look like a secret wherever they appear. */
  pattern?: RegExp;
  /** How to build a fake replacement of the same shape for replay. */
  fake?: (ordinal: number) => string;
}

function fakeJwt(n: number): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: `mocktown-${n}`, iss: 'mocktown', iat: 0 })}.mocktownsignature${n}`;
}

export const DEFAULT_RULES: ScrubRule[] = [
  // ── Shape-recognised vendor credentials.
  {
    kind: 'stripe-secret-key',
    pattern: /\bsk_(?:test|live)_[A-Za-z0-9]{8,}/g,
    fake: (n) => `sk_test_mocktown${String(n).padStart(16, '0')}`,
  },
  {
    kind: 'stripe-publishable-key',
    pattern: /\bpk_(?:test|live)_[A-Za-z0-9]{8,}/g,
    fake: (n) => `pk_test_mocktown${String(n).padStart(16, '0')}`,
  },
  { kind: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/g, fake: (n) => `ghp_mocktown${String(n).padStart(28, '0')}` },
  { kind: 'google-client-secret', pattern: /\bGOCSPX-[A-Za-z0-9_-]{5,}/g, fake: (n) => `GOCSPX-mocktown${n}` },
  { kind: 'aws-access-key-id', pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, fake: (n) => `AKIAMOCKTOWN${String(n).padStart(8, '0')}` },
  { kind: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, fake: (n) => `xoxb-mocktown-${n}` },
  { kind: 'openai-key', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, fake: (n) => `sk-mocktown${String(n).padStart(20, '0')}` },
  { kind: 'npm-token', pattern: /\bnpm_[A-Za-z0-9]{30,}/g, fake: (n) => `npm_mocktown${String(n).padStart(24, '0')}` },
  {
    kind: 'private-key-block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g,
    fake: () => '-----BEGIN PRIVATE KEY-----\nmocktown\n-----END PRIVATE KEY-----',
  },

  // ── JWTs anywhere, per 10-security.md. Three base64url segments.
  { kind: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g, fake: fakeJwt },

  // ── PII with recognisable shapes. Luhn, not length, decides a card (spike 05) — and
  // Luhn alone is not enough, so the shape is guarded here and the value in
  // `isLikelyCardNumber`.
  //
  // The lookarounds refuse a run that is part of a longer token. `\b` does not, and both
  // ways it fails were live on a real corpus: it sits between the `.` and the `5` of
  // `"score":0.5904425485364132`, so a float's fractional digits matched, and it sits
  // between the hex letters of `6b932522-6836-460d-…`, so a slice of a UUID matched. Each
  // then passed Luhn one time in ten. Rejecting an adjacent word character, `.` or `-`
  // costs nothing: a card is never written flush against another token.
  {
    kind: 'card-number',
    pattern: /(?<![\w.-])\d(?:[ -]?\d){12,18}(?![\w.-])/g,
    fake: () => '4242424242424242',
  },
  { kind: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g, fake: (n) => `900-00-${String(1000 + (n % 9000))}` },

  // ── Location-based: whole-value auth headers.
  {
    kind: 'auth-header',
    headers: [
      'authorization',
      'proxy-authorization',
      'x-api-key',
      'x-auth-token',
      'x-amz-security-token',
      'api-key',
      'x-goog-api-key',
      'x-stripe-signature',
      'x-hub-signature',
      'x-hub-signature-256',
    ],
    fake: (n) => `mocktown-credential-${n}`,
  },
  { kind: 'cookie', headers: ['cookie', 'set-cookie'], fake: (n) => `mocktown-cookie-${n}` },

  // ── Location-based: deny-pattern field names in bodies and query strings.
  { kind: 'password', fields: ['password', 'passwd', 'pwd'], fake: (n) => `mocktown-password-${n}` },
  { kind: 'secret', fields: ['secret', 'client_secret', 'private_key', 'signing_key'], fake: (n) => `mocktown-secret-${n}` },
  {
    kind: 'token',
    fields: ['token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey'],
    fake: (n) => `mocktown-token-${n}`,
  },
  { kind: 'card', fields: ['card', 'cardnumber', 'card_number', 'cvc', 'cvv'], fake: () => '4242424242424242' },
  { kind: 'ssn-field', fields: ['ssn', 'social_security', 'tax_id'], fake: (n) => `900-00-${String(1000 + (n % 9000))}` },
];

/**
 * Emails are load-bearing for mock fidelity — they are the identity most APIs key on —
 * so redacting them is a project decision rather than a default (spike 05's open item).
 *
 * An `@` is common in API data, and this has to match an address rather than merely a
 * string containing one — the mistake the card rule made, where a loose `\b` turned a
 * float and a slice of a UUID into credit cards. Measured against a 37MB recorded corpus,
 * every clause below is here because something real needed it:
 *
 *   - The lookbehind refuses a start mid-token, a second `@` (`a@b@c.d`), and a start
 *     immediately after a backslash — without which the `n` of an escaped newline becomes
 *     a local part, and the facet list `…\n@event.type` reads as mail for `event.type`.
 *     Its second arm then puts back the one case that guard was too broad for: a completed
 *     `\uXXXX` escape *is* a delimiter, so an address may begin right after one. JSON
 *     escapes the `<` of a git trailer, so a commit message inside a GitHub API response
 *     arrives as `Co-authored-by: Name <name@example.com>`. Without this arm the
 *     run `u003cname` is unbreakable — every position inside it follows an alphanumeric,
 *     and the `u` follows the backslash — so nothing matches and the address survives in
 *     the clear. It cost three real addresses on a recorded corpus.
 *   - The local part must begin and end alphanumeric, inside the RFC's 64 characters.
 *     Without that, the faceted field paths `-@identity.arn` and
 *     `-@message.httpRequest.country` are addresses with a local part of `-`.
 *   - Each domain label must begin and end alphanumeric, rejecting the empty label of
 *     `user@.com`, a leading hyphen, and `..`.
 *   - The TLD is letters only, so version specs (`pkg@1.2.3`, `mod@v1.2.3`) are not
 *     addresses.
 *   - The lookahead refuses stopping mid-domain, so `user@example.com2` matches nothing
 *     rather than a prefix of itself. A trailing `.` still passes: an address at the end
 *     of a sentence is an address.
 *
 * Metric queries (`by {@ai.agent.id}`), facet paths (`@ai.thread.state`) and image digests
 * (`img@sha256:…`) never had a local part to begin with, so they never matched.
 *
 * Two shapes are knowingly still caught, and both are left caught on purpose. A patch spec
 * (`jose@5.1.0.patch`) has an all-numeric domain and a letters-only suffix; excluding it
 * would mean demanding a letter in the domain, which would then miss a real address at
 * `123.com`. And `event.type@ai.user.id` reads as a mailbox at a `.id` domain — no pattern
 * can say otherwise. Redacting a lockfile string costs a little fidelity; missing an
 * address costs a person's data, so the rule errs toward redaction. On a 37MB corpus that
 * trade cost two strings out of 126 matches.
 */
export const EMAIL_RULE: ScrubRule = {
  kind: 'email',
  pattern:
    /(?:(?<![A-Za-z0-9._%+@\\-])|(?<=\\u[0-9a-fA-F]{4}))[A-Za-z0-9](?:[A-Za-z0-9._%+-]{0,62}[A-Za-z0-9])?@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![A-Za-z0-9@-])/g,
  fake: (n) => `person${n}@mocktown.test`,
};

export interface ScrubConfig {
  rules?: { kind: string; headers?: string[]; fields?: string[]; pattern?: string }[];
  entropyBackstop?: boolean;
  redactEmails?: boolean;
}

/** Project rules are appended, so a project can add coverage but never silently drop it. */
export function rulesFromConfig(config: ScrubConfig = {}): ScrubRule[] {
  const extra: ScrubRule[] = (config.rules ?? []).map((r) => ({
    kind: r.kind,
    headers: r.headers?.map((h) => h.toLowerCase()),
    fields: r.fields,
    pattern: r.pattern ? new RegExp(r.pattern, 'g') : undefined,
    fake: (n) => `mocktown-${r.kind}-${n}`,
  }));
  // Project patterns go first so a team's own vendor shapes out-label the generic rules.
  return [
    ...extra.filter((r) => r.pattern),
    ...DEFAULT_RULES,
    ...(config.redactEmails ? [EMAIL_RULE] : []),
    ...extra.filter((r) => !r.pattern),
  ];
}
