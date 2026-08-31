/**
 * The scrubber's contract, over the real captured corpus from spike 05 — genuine SDK
 * traffic (Stripe, Octokit, a Google OIDC exchange) MITM'd through the front door,
 * carrying real auth headers, a signed JWT, cookies and planted PII.
 *
 * These are the properties 10-security.md asks for. The two easiest to lose in a
 * refactor are the last ones: **no single rule deletion may leak a credential**, and the
 * entropy backstop must not fire on ordinary identifiers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Scrubber, looksHighEntropy, type Exchange } from "../src/scrub/scrubber.ts";
import { DEFAULT_RULES } from "../src/scrub/rules.ts";

const fixture = (name: string) => JSON.parse(readFileSync(join(import.meta.dir, "fixtures", name), "utf8"));
const corpus: Exchange[] = fixture("corpus.raw.json");
const SECRETS: Record<string, string> = fixture("secrets.json");

const scrubber = new Scrubber();
const scrubbed = corpus.map((e) => scrubber.scrub(e));
const serialised = JSON.stringify(scrubbed);

describe("scrubbing before disk", () => {
  test("no known secret survives", () => {
    const leaked = Object.entries(SECRETS).filter(([, value]) => serialised.includes(value));
    expect(leaked.map(([k]) => k)).toEqual([]);
  });

  test("server-issued tokens are redacted too", () => {
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

  test("the same secret gets the same placeholder within a session", () => {
    const ordinals = [...serialised.matchAll(/\{\{secret:stripe-secret-key#(\d+)\}\}/g)].map((m) => m[1]);
    expect(ordinals.length).toBeGreaterThanOrEqual(3);
    expect(new Set(ordinals).size).toBe(1);
  });

  test("distinct secret kinds stay distinguishable", () => {
    const kinds = new Set([...serialised.matchAll(/\{\{secret:([a-z0-9-]+)#\d+\}\}/g)].map((m) => m[1]));
    expect(kinds.size).toBeGreaterThanOrEqual(4);
    expect([...kinds]).toContain("stripe-secret-key");
  });
});

describe("the corpus stays agent-legible", () => {
  test("JSON bodies remain valid JSON", () => {
    let bodies = 0;
    for (const e of scrubbed) {
      for (const [body, headers] of [[e.requestBody, e.requestHeaders], [e.responseBody, e.responseHeaders]] as const) {
        if (!body || !String(headers["content-type"] ?? "").includes("json")) continue;
        bodies++;
        expect(() => JSON.parse(body)).not.toThrow();
      }
    }
    expect(bodies).toBeGreaterThan(0);
  });

  test("non-secret data survives intact", () => {
    // The capture deliberately includes a product called "Token Ring Adapter"; a
    // field-name rule that matches `token` too eagerly would destroy it.
    expect(serialised).toContain("Token Ring Adapter");
    expect(serialised).toContain("grace@example.com");
    expect(serialised).toMatch(/cus_[A-Za-z0-9_]+/);
  });

  test("auth scheme kept, credential replaced", () => {
    const auths = scrubbed.map((e) => String(e.requestHeaders["authorization"] ?? "")).filter(Boolean);
    expect(auths.length).toBeGreaterThanOrEqual(2);
    for (const a of auths) expect(a).toMatch(/^(Bearer|token|Basic) \{\{secret:/);
  });

  test("cookie names and attributes kept, values redacted", () => {
    const setCookies = scrubbed.flatMap((e) => {
      const v = e.responseHeaders["set-cookie"];
      return v ? (Array.isArray(v) ? v : [v]) : [];
    });
    expect(setCookies.length).toBeGreaterThan(0);
    for (const c of setCookies) {
      expect(c).toMatch(/^[^=]+=\{\{secret:cookie#\d+\}\}/);
      expect(c).toMatch(/Path=/i);
    }
  });
});

describe("replay and audit", () => {
  test("re-injection produces well-formed fakes and no real secrets", () => {
    const replayed = scrubber.reinject(serialised);
    expect(replayed).toMatch(/sk_test_mocktown\d{16}/);
    expect(replayed).toMatch(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    expect(replayed).not.toContain("{{secret:");
    for (const value of Object.values(SECRETS)) expect(replayed).not.toContain(value);
  });

  test("audit finds no residue in a correctly scrubbed corpus", () => {
    expect(scrubber.audit(scrubbed)).toEqual([]);
  });
});

describe("defence in depth is a property, not luck", () => {
  test("the entropy backstop covers a removed vendor rule", () => {
    const withoutGithub = DEFAULT_RULES.filter((r) => r.kind !== "github-token" && r.kind !== "token");
    const covered = JSON.stringify(corpus.map((e) => new Scrubber(withoutGithub, true).scrub(e)));
    expect(covered).not.toContain(SECRETS.githubPat!);
  });

  test("audit reports the leak once every covering layer is gone", () => {
    // Three independent layers cover the PAT: its vendor pattern, the `authorization`
    // header rule, and the entropy backstop. Only removing all three lets it through.
    const stripped = DEFAULT_RULES.filter((r) => !["github-token", "token", "auth-header"].includes(r.kind));
    const naked = corpus.map((e) => new Scrubber(stripped, false).scrub(e));
    expect(JSON.stringify(naked)).toContain(SECRETS.githubPat!);
    expect(new Scrubber().audit(naked).some((f) => f.kind === "github-token")).toBe(true);
  });

  test("the entropy backstop is conservative", () => {
    // A false positive silently corrupts the corpus mocks are generated from, and shows
    // up much later as a mock that doesn't match reality.
    for (const ordinary of [
      "application/x-www-form-urlencoded", "hello-world-repository-name",
      "2026-08-31T14:22:19.284Z", "payment_intents.succeeded.webhook",
      "cus_MR7dlLEfqZuUiAwY", "repository_dispatch_workflow_run",
    ]) expect(looksHighEntropy(ordinary)).toBe(false);

    for (const secret of [
      "8f14e45fceea167a5a36dedd4bea2543deadbeefcafef00d",   // 48 hex chars: 3.59 bits/char
      "xapi_live_9f8e7d6c5b4a3928170612345678",
    ]) expect(looksHighEntropy(secret)).toBe(true);
  });

  test("summary records kinds and counts, never values", () => {
    const summary = scrubber.summary();
    expect(summary.length).toBeGreaterThan(0);
    for (const s of summary) expect(s.count).toBeGreaterThan(0);
    expect(JSON.stringify(summary)).not.toContain("sk_test");
  });
});
