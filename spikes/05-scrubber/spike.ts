/**
 * Phase 0 / Spike 05 — the scrubber, over a real recorded corpus.
 *
 * Question ([11-roadmap.md](../../docs/design/11-roadmap.md)): "Scrubber prototype over
 * real recorded traffic."
 *
 * The corpus (`corpus.raw.json`, built by `capture.mjs`) is genuine SDK traffic — Stripe
 * and Octokit over real TLS to real hostnames, MITM'd and forwarded to emulate — carrying
 * real auth headers, a real signed JWT, cookies, an OAuth client_secret and access_token,
 * plus one request shaped like a signup carrying the PII the deny-pattern list targets.
 *
 *   bun run spike.ts
 */
import { Scrubber, DEFAULT_RULES, looksHighEntropy, entropy, type Exchange } from "./scrubber.ts";
import { readFileSync, existsSync } from "node:fs";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

if (!existsSync("corpus.raw.json")) {
  console.error("  corpus.raw.json missing — run `node capture.mjs` first");
  process.exit(1);
}
const corpus: Exchange[] = JSON.parse(readFileSync("corpus.raw.json", "utf8"));
const SECRETS: Record<string, string> = JSON.parse(readFileSync("secrets.json", "utf8"));

const scrubber = new Scrubber();
const scrubbed = corpus.map((e) => scrubber.scrub(e));
const serialised = JSON.stringify(scrubbed);

// ── 1. THE test: no known secret survives anywhere in what would hit disk ─────
// 10-security.md: "Scrub at capture time, before disk. The raw exchange never persists."
{
  const leaked = Object.entries(SECRETS).filter(([, value]) => serialised.includes(value));
  check("No known secret survives scrubbing", leaked.length === 0,
    leaked.length ? `LEAKED: ${leaked.map(([k]) => k).join(", ")}` : `${Object.keys(SECRETS).length} known secrets, none present`);
}

// ── 2. Secrets the harness didn't plant: server-issued tokens ────────────────
// The OAuth access_token and the signed id_token were minted at capture time, so they
// aren't in secrets.json. They must be redacted anyway.
{
  const rawJoined = JSON.stringify(corpus);
  const issued = [
    ...rawJoined.matchAll(/gho_[A-Za-z0-9]{20,}/g),
    ...rawJoined.matchAll(/eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g),
  ].map((m) => m[0]);
  const survivors = issued.filter((token) => serialised.includes(token));
  check("Server-issued tokens redacted too", issued.length > 0 && survivors.length === 0,
    `${issued.length} issued credentials found in the raw corpus, ${survivors.length} survived`);
}

// ── 3. Placeholders are consistent within a session ───────────────────────────
// The same Stripe key appears in three exchanges; a generated mock correlates them by
// placeholder, so they must all carry the same one.
{
  const placeholders = [...serialised.matchAll(/\{\{secret:stripe-secret-key#(\d+)\}\}/g)].map((m) => m[1]);
  const distinctKeys = new Set(placeholders);
  check("Same secret → same placeholder in a session",
    placeholders.length >= 3 && distinctKeys.size === 1,
    `${placeholders.length} occurrences, ${distinctKeys.size} distinct ordinal(s)`);
}

// ── 4. Different secrets get different placeholders ───────────────────────────
{
  const kinds = new Map<string, Set<string>>();
  for (const [, kind, ord] of serialised.matchAll(/\{\{secret:([a-z0-9-]+)#(\d+)\}\}/g)) {
    (kinds.get(kind) ?? kinds.set(kind, new Set()).get(kind)!).add(ord);
  }
  const distinctKinds = [...kinds.keys()].sort();
  check("Distinct secrets are distinguishable", distinctKinds.length >= 4,
    `kinds=[${distinctKinds.join(", ")}]`);
}

// ── 5. Structure survives — the corpus must stay agent-legible ────────────────
// 03-capture.md: normalisation happens at write time "so the corpus is immediately
// agent-legible". A scrubber that corrupts JSON destroys the thing mocks are built from.
{
  let jsonBodies = 0, parsed = 0;
  for (const e of scrubbed) {
    for (const [body, headers] of [[e.requestBody, e.requestHeaders], [e.responseBody, e.responseHeaders]] as const) {
      if (!body || !String(headers["content-type"] ?? "").includes("json")) continue;
      jsonBodies++;
      try { JSON.parse(body); parsed++; } catch {}
    }
  }
  check("JSON bodies remain valid JSON", jsonBodies > 0 && parsed === jsonBodies, `${parsed}/${jsonBodies} parsed`);
}

// ── 6. Non-secrets survive intact — false positives corrupt the corpus ────────
// The capture deliberately includes a product called "Token Ring Adapter"; a field-name
// scrubber that matches "token" too eagerly would destroy it.
{
  const decoyIntact = serialised.includes("Token Ring Adapter") && serialised.includes("legacy token ring network adapter");
  const emailsIntact = serialised.includes("grace@example.com") && serialised.includes("ada@example.com");
  const idsIntact = /cus_[A-Za-z0-9_]+/.test(serialised);
  check("Non-secret data survives intact", decoyIntact && emailsIntact && idsIntact,
    `decoy=${decoyIntact} emails=${emailsIntact} resourceIds=${idsIntact}`);
}

// ── 7. Auth scheme preserved, credential removed ──────────────────────────────
// A mock has to reproduce the auth challenge, which means knowing it was `Bearer` —
// the scheme is protocol shape, not a secret.
{
  const auths = scrubbed.map((e) => String(e.requestHeaders["authorization"] ?? "")).filter(Boolean);
  const schemesKept = auths.every((a) => /^(Bearer|token|Basic) \{\{secret:/.test(a));
  check("Auth scheme kept, credential replaced", auths.length >= 2 && schemesKept,
    auths.length ? auths[0].slice(0, 52) : "none");
}

// ── 8. Cookie names kept, values redacted ─────────────────────────────────────
{
  const setCookies = scrubbed.flatMap((e) => {
    const v = e.responseHeaders["set-cookie"];
    return v ? (Array.isArray(v) ? v : [v]) : [];
  });
  const ok = setCookies.length > 0 && setCookies.every((c) => /^[^=]+=\{\{secret:cookie#\d+\}\}/.test(c) && /Path=/i.test(c));
  check("Cookie names + attributes kept, values redacted", ok, setCookies[0]?.slice(0, 62) ?? "none");
}

// ── 9. Re-injection produces credentials of the right shape ───────────────────
// 10-security.md: mocks "re-inject fake credentials on replay".
{
  const replayed = scrubber.reinject(serialised);
  const stripeShaped = /sk_test_mocktown\d{16}/.test(replayed);
  const jwtShaped = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(replayed);
  const noRealSecrets = !Object.values(SECRETS).some((v) => replayed.includes(v));
  const noPlaceholdersLeft = !replayed.includes("{{secret:");
  check("Replay re-injects well-formed fakes",
    stripeShaped && jwtShaped && noRealSecrets && noPlaceholdersLeft,
    `stripeShape=${stripeShaped} jwtShape=${jwtShaped} noRealSecrets=${noRealSecrets} allPlaceholdersFilled=${noPlaceholdersLeft}`);
}

// ── 10. `scrub audit` finds nothing in a correctly scrubbed corpus ────────────
{
  const findings = scrubber.audit(scrubbed);
  check("Audit finds no residue in the scrubbed corpus", findings.length === 0,
    findings.length ? `${findings.length} residual: ${findings.slice(0, 2).map((f) => `${f.kind}@${f.where}`).join(", ")}` : "clean");
}

// ── 11. The entropy backstop covers a removed vendor rule ─────────────────────
// Defence in depth, demonstrated rather than assumed: drop the GitHub and token rules and
// the PAT is still caught, by shape alone.
{
  const withoutGithubRules = DEFAULT_RULES.filter((r) => r.kind !== "github-token" && r.kind !== "token");
  const covered = JSON.stringify(corpus.map((e) => new Scrubber(withoutGithubRules, true).scrub(e)));
  check("Entropy backstop covers a removed vendor rule", !covered.includes(SECRETS.githubPat),
    `PAT still redacted with its own rule removed = ${!covered.includes(SECRETS.githubPat)}`);
}

// ── 12. …and the audit has teeth once every covering layer is gone ───────────
// It takes removing THREE independent layers before the GitHub PAT survives: its own
// vendor pattern, the `authorization` header rule that redacts the whole value regardless
// of shape, and the entropy backstop. That overlap is the point of the two-pass design —
// and once it is gone, `mocktown scrub audit` must report the leak.
{
  const stripped = DEFAULT_RULES.filter((r) => !["github-token", "token", "auth-header"].includes(r.kind));
  const naked = new Scrubber(stripped, false);
  const nakedCorpus = corpus.map((e) => naked.scrub(e));
  const leaks = JSON.stringify(nakedCorpus).includes(SECRETS.githubPat);
  const findings = new Scrubber().audit(nakedCorpus);
  check("Audit reports what a stripped rule set leaves behind",
    leaks && findings.some((f) => f.kind === "github-token"),
    `leaked=${leaks} auditFindings=${findings.length} kinds=[${[...new Set(findings.map((f) => f.kind))].join(", ")}]`);
}

// ── 13. The entropy backstop is conservative ──────────────────────────────────
// A backstop that fires on ordinary identifiers would quietly wreck the corpus.
{
  // These are token-level inputs, matching how the backstop is actually applied — it runs
  // over `[A-Za-z0-9_\-.]{24,}` runs, never over whole URLs or header lines.
  const shouldNotFire = [
    "application/x-www-form-urlencoded", "hello-world-repository-name",
    "2026-08-31T14:22:19.284Z", "payment_intents.succeeded.webhook",
    "cus_MR7dlLEfqZuUiAwY", "repository_dispatch_workflow_run",
  ];
  const shouldFire = [
    "8f14e45fceea167a5a36dedd4bea2543deadbeefcafef00d",
    "xapi_live_9f8e7d6c5b4a3928170612345678",
  ];
  const falsePositives = shouldNotFire.filter(looksHighEntropy);
  const missed = shouldFire.filter((v) => !looksHighEntropy(v));
  check("Entropy backstop: no false positives", falsePositives.length === 0 && missed.length === 0,
    `falsePositives=[${falsePositives.join(", ")}] missed=[${missed.join(", ")}]`);
}

// ── 14. Redaction metadata is recorded without values ─────────────────────────
{
  const summary = scrubber.summary();
  const hasCounts = summary.length > 0 && summary.every((s) => s.count > 0);
  const noValues = !JSON.stringify(summary).includes("sk_test");
  check("Summary records kinds and counts, never values", hasCounts && noValues,
    summary.map((s) => `${s.kind}×${s.count}`).join(" "));
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n  runtime: bun ${Bun.version} · corpus: ${corpus.length} real exchanges`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(48)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
