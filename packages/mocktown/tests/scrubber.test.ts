/**
 * The scrubber's contract, over the real captured corpus from spike 05 — genuine SDK
 * traffic (Stripe, Octokit, a Google OIDC exchange) MITM'd through the front door,
 * carrying real auth headers, a signed JWT, cookies and planted PII.
 *
 * These are the properties 10-security.md asks for. The two easiest to lose in a
 * refactor are the last ones: **no single rule deletion may leak a credential**, and the
 * entropy backstop must not fire on ordinary identifiers.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_RULES, rulesFromConfig } from '#src/scrub/rules.ts';
import { type Exchange, looksHighEntropy, Scrubber } from '#src/scrub/scrubber.ts';

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', name), 'utf8'));
const corpus: Exchange[] = fixture('corpus.raw.json');
const SECRETS: Record<string, string> = fixture('secrets.json');

const scrubber = new Scrubber();
const scrubbed = corpus.map((e) => scrubber.scrub(e));
const serialised = JSON.stringify(scrubbed);

describe('scrubbing before disk', () => {
  test('no known secret survives', () => {
    const leaked = Object.entries(SECRETS).filter(([, value]) => serialised.includes(value));
    expect(leaked.map(([k]) => k)).toEqual([]);
  });

  test('server-issued tokens are redacted too', () => {
    // The OAuth access_token and signed id_token were minted at capture time, so they
    // are not in secrets.json — shape has to catch them.
    const raw = JSON.stringify(corpus);
    const issued = [
      ...raw.matchAll(/gho_[A-Za-z0-9]{20,}/g),
      ...raw.matchAll(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g),
    ].map((m) => m[0]);
    expect(issued.length).toBeGreaterThan(0);
    expect(issued.filter((t) => serialised.includes(t))).toEqual([]);
  });

  test('the same secret gets the same placeholder within a session', () => {
    const ordinals = [...serialised.matchAll(/\{\{secret:stripe-secret-key#(\d+)\}\}/g)].map((m) => m[1]);
    expect(ordinals.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ordinals).size).toBe(1);
  });

  test('distinct secret kinds stay distinguishable', () => {
    const kinds = new Set([...serialised.matchAll(/\{\{secret:([a-z0-9-]+)#\d+\}\}/g)].map((m) => m[1]));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect([...kinds]).toContain('stripe-secret-key');
  });
});

describe('the corpus stays agent-legible', () => {
  test('JSON bodies remain valid JSON', () => {
    let bodies = 0;
    for (const e of scrubbed) {
      for (const [body, headers] of [
        [e.requestBody, e.requestHeaders],
        [e.responseBody, e.responseHeaders],
      ] as const) {
        if (!body || !String(headers['content-type'] ?? '').includes('json')) continue;
        bodies++;
        expect(() => JSON.parse(body)).not.toThrow();
      }
    }
    expect(bodies).toBeGreaterThan(0);
  });

  test('non-secret data survives intact', () => {
    // The capture deliberately includes a product called "Token Ring Adapter"; a
    // field-name rule that matches `token` too eagerly would destroy it.
    expect(serialised).toContain('Token Ring Adapter');
    expect(serialised).toContain('grace@example.com');
    expect(serialised).toMatch(/cus_[A-Za-z0-9_]+/);
  });

  test('numbers survive the round-trip exactly', () => {
    // Scrubbing a JSON body means parsing and re-serialising it, and that is not the
    // identity: every number becomes a double, so an integer past 2^53 comes back changed.
    // An OpenTelemetry `time_unix_nano` is 19 digits, so a real corpus is full of them, and
    // nothing announces the corruption — the recording still looks like a recording.
    const body = (text: string) =>
      new Scrubber().scrub({
        id: 'e1',
        method: 'GET',
        url: 'https://example.test/x',
        statusCode: 200,
        requestHeaders: {},
        requestBody: '',
        responseHeaders: { 'content-type': 'application/json' },
        responseBody: text,
      }).responseBody;

    for (const exact of [
      '{"time_unix_nano":1788789099537123456}',
      '{"id":9007199254740993}', // 2^53 + 1: the smallest integer a double cannot hold
      '{"big":-12345678901234567890}',
      '{"precise":0.1000000000000000055511151231257827}',
      '{"nested":[{"t":1788793359178000001}]}',
    ])
      expect(body(exact)).toBe(exact);

    // Ordinary numbers stay numbers, so the field rules still see one where the document
    // had one rather than a wrapper object.
    expect(body('{"count":3,"ratio":0.5}')).toBe('{"count":3,"ratio":0.5}');
    expect(body('{"card_number":4242424242424242}')).toContain('{{secret:card-number#');
  });

  test('auth scheme kept, credential replaced', () => {
    const auths = scrubbed.map((e) => String(e.requestHeaders.authorization ?? '')).filter(Boolean);
    expect(auths.length).toBeGreaterThanOrEqual(2);
    for (const a of auths) expect(a).toMatch(/^(Bearer|token|Basic) \{\{secret:/);
  });

  test('cookie names and attributes kept, values redacted', () => {
    const setCookies = scrubbed.flatMap((e) => {
      const v = e.responseHeaders['set-cookie'];
      return v ? (Array.isArray(v) ? v : [v]) : [];
    });
    expect(setCookies.length).toBeGreaterThan(0);
    for (const c of setCookies) {
      expect(c).toMatch(/^[^=]+=\{\{secret:cookie#\d+\}\}/);
      expect(c).toMatch(/Path=/i);
    }
  });
});

describe('replay and audit', () => {
  test('re-injection produces well-formed fakes and no real secrets', () => {
    const replayed = scrubber.reinject(serialised);
    expect(replayed).toMatch(/sk_test_mocktown\d{16}/);
    expect(replayed).toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(replayed).not.toContain('{{secret:');
    for (const value of Object.values(SECRETS)) expect(replayed).not.toContain(value);
  });

  test('audit finds no residue in a correctly scrubbed corpus', () => {
    expect(scrubber.audit(scrubbed)).toEqual([]);
  });
});

describe('defence in depth is a property, not luck', () => {
  test('the entropy backstop covers a removed vendor rule', () => {
    const withoutGithub = DEFAULT_RULES.filter((r) => r.kind !== 'github-token' && r.kind !== 'token');
    const covered = JSON.stringify(corpus.map((e) => new Scrubber(withoutGithub, true).scrub(e)));
    expect(covered).not.toContain(SECRETS.githubPat!);
  });

  test('audit reports the leak once every covering layer is gone', () => {
    // Three independent layers cover the PAT: its vendor pattern, the `authorization`
    // header rule, and the entropy backstop. Only removing all three lets it through.
    const stripped = DEFAULT_RULES.filter((r) => !['github-token', 'token', 'auth-header'].includes(r.kind));
    const naked = corpus.map((e) => new Scrubber(stripped, false).scrub(e));
    expect(JSON.stringify(naked)).toContain(SECRETS.githubPat!);
    expect(new Scrubber().audit(naked).some((f) => f.kind === 'github-token')).toBe(true);
  });

  test('the entropy backstop is conservative', () => {
    // A false positive silently corrupts the corpus mocks are generated from, and shows
    // up much later as a mock that doesn't match reality.
    for (const ordinary of [
      'application/x-www-form-urlencoded',
      'hello-world-repository-name',
      '2026-08-31T14:22:19.284Z',
      'payment_intents.succeeded.webhook',
      'cus_MR7dlLEfqZuUiAwY',
      'repository_dispatch_workflow_run',
    ])
      expect(looksHighEntropy(ordinary)).toBe(false);

    for (const secret of [
      '8f14e45fceea167a5a36dedd4bea2543deadbeefcafef00d', // 48 hex chars: 3.59 bits/char
      'xapi_live_9f8e7d6c5b4a3928170612345678',
    ])
      expect(looksHighEntropy(secret)).toBe(true);
  });

  test('the card rule is conservative', () => {
    // Luhn passes one bare integer in ten, so on a real corpus the rule flagged 284 values
    // and every one was ordinary numeric data: epoch-millisecond timestamps, and the
    // fractional digits of similarity scores, which `\b` matched happily after the `.`.
    // Both directions matter — a redacted score corrupts the mock, a missed card leaks.
    const body = (text: string) =>
      new Scrubber().scrub({
        id: 'e1',
        method: 'GET',
        url: 'https://example.test/x',
        statusCode: 200,
        requestHeaders: {},
        requestBody: '',
        responseHeaders: {},
        responseBody: text,
      }).responseBody;

    for (const ordinary of [
      '{"timestamp":1788789099537}',
      '{"score":0.5904425485364132}', // a float's fractional digits
      '{"r":0.515021887150724}',
      '{"uid":"6b932522-6836-460d-be23-1075e247664e"}', // a digit-and-dash slice of a UUID
      '{"padding":"0000000000000"}', // sums to zero, so Luhn loves it
      '{"time_unix_micro":1788789099537123}', // 16 digits — the commonest card length
      '{"time_unix_nano":1788789099537123456}', // 19 digits, past MAX_SAFE_INTEGER
    ])
      expect(body(ordinary)).toBe(ordinary);

    for (const card of [
      '{"pan":"4242424242424242"}', // Visa, 16
      '{"pan":"378282246310005"}', // Amex, 15
      '{"pan":"4222222222222"}', // legacy Visa, 13 — the length the epoch guard covers
      '{"pan":"4111 1111 1111 1111"}', // separators still match
      '{"pan":"4111-1111-1111-1111"}',
    ])
      expect(body(card)).toContain('{{secret:card-number#');
  });

  test('the email rule matches addresses, not strings containing an @', () => {
    // Off by default, so the rule has to be asked for. Every negative below is a real
    // string from a recorded corpus: an `@` is ordinary in metric queries, facet paths,
    // image digests and package specs, and the card rule is the standing lesson in what a
    // pattern that is merely `@`-shaped costs.
    const rules = rulesFromConfig({ redactEmails: true });
    const body = (text: string, r = rules) =>
      new Scrubber(r).scrub({
        id: 'e1',
        method: 'GET',
        url: 'https://example.test/x',
        statusCode: 200,
        requestHeaders: {},
        requestBody: '',
        responseHeaders: {},
        responseBody: text,
      }).responseBody;

    for (const address of [
      '{"creator":"dana@example.com"}',
      '{"creator":"sam.rivera@example.com"}',
      '{"creator":"alex+rbactest@example.com"}', // plus-addressing
      '{"creator":"bot@users.noreply.github.com"}', // multi-label domain
      '{"prose":"write to support@example.com."}', // trailing sentence period
      // A git trailer inside a GitHub API response: JSON escapes the angle brackets, so
      // the address abuts `\\u003c` with no ordinary delimiter in front of it.
      String.raw`{"msg":"Co-authored-by: A Name \u003cbot@example.com\u003e"}`,
    ])
      expect(body(address)).toContain('{{secret:email#');

    for (const ordinary of [
      '{"q":"sum:app.assistant.memories.created{*} by {@ai.agent.id}"}', // no local part
      '{"path":"@ai.thread.state"}',
      '{"keys":"RELEVANT_KEYS\\n@event.type\\n@item.type"}', // the `n` of an escape
      '{"facet":"-@message.httpRequest.country"}', // a lone `-` is not a local part
      '{"image":"registry.io/app@sha256:abc123def456"}',
      '{"spec":"example.com/mod@v1.2.3"}', // a numeric TLD is not a TLD
      '{"version":"@scope/pkg@1.2.3"}',
      '{"malformed":"user@example.com2"}', // must not match a prefix of itself
    ])
      expect(body(ordinary), ordinary).toBe(ordinary);

    // And none of it happens unless the project asks.
    expect(body('{"creator":"dana@example.com"}', DEFAULT_RULES)).toContain('dana@example.com');
  });

  test('field rules do not depend on the client naming its content type', () => {
    // `fetch(url, { body: JSON.stringify(x) })` with no explicit header sends
    // `text/plain;charset=UTF-8`. A real login body reached a corpus that way with its
    // password in the clear: the JSON branch never ran, and a password has no shape for
    // pass 2 to recognise. The format has to be decided by the body, not the header.
    const scrub = (body: string, contentType: string) =>
      new Scrubber().scrub({
        id: 'e1',
        method: 'POST',
        url: 'https://example.test/auth/login',
        statusCode: 200,
        requestHeaders: { 'content-type': contentType },
        requestBody: body,
        responseHeaders: {},
        responseBody: '',
      }).requestBody;

    const login = '{"username":"ada@example.com","password":"hunter2-correct-horse","state":"abc"}';
    for (const contentType of ['text/plain;charset=UTF-8', 'application/json', '']) {
      const out = scrub(login, contentType);
      expect(out, contentType).not.toContain('hunter2-correct-horse');
      expect(out, contentType).toContain('{{secret:password#');
      // Structure survives, so the corpus is still a legible example of the contract.
      expect(JSON.parse(out).username).toBe('ada@example.com');
    }

    // A body that only looks like it might be JSON still goes through the shape rules
    // rather than being dropped on the floor by a failed parse.
    expect(scrub('{not json at all sk_test_abcdefghij', 'text/plain')).toContain('{{secret:stripe-secret-key#');
  });

  test('summary records kinds and counts, never values', () => {
    const summary = scrubber.summary();
    expect(summary.length).toBeGreaterThan(0);
    for (const s of summary) expect(s.count).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain('sk_test');
  });
});
