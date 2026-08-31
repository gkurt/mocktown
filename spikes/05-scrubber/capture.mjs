/**
 * Captures a realistic corpus to scrub.
 *
 * Runs under Node because the front door is a Node sidecar (spike 01). Real vendor SDKs
 * talk over real TLS to real hostnames (`api.stripe.com`, `api.github.com`); the proxy
 * MITMs and forwards to emulate — the actual Mocktown architecture, so the recorded
 * exchanges carry genuine SDK shapes, headers and auth material rather than hand-written
 * fixtures.
 *
 * NOTE: this writes RAW, UNSCRUBBED exchanges to corpus.raw.json. The product never does
 * this — 10-security.md requires scrubbing before disk. It exists only so the spike has
 * something to scrub, and a ground truth to check its work against. It is gitignored.
 */
import * as mockttp from "mockttp";
import { spawn, spawnSync } from "node:child_process";
import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import https from "node:https";
import net from "node:net";
import Stripe from "stripe";
import { Octokit } from "@octokit/rest";
import { HttpsProxyAgent } from "https-proxy-agent";

// ── Stage 1: generate the CA, then re-exec ourselves with it trusted ─────────
// This is `mocktown record -- <cmd>` in miniature (03-capture.md rung 1): the CA has to
// be in the environment before the runtime starts, so the wrapper generates it and
// launches the child with NODE_EXTRA_CA_CERTS set. Setting it from inside is too late.
if (!process.env.MOCKTOWN_SPIKE_CHILD) {
  mkdirSync("out", { recursive: true });
  const rootCa = await mockttp.generateCACertificate({ subject: { commonName: "Mocktown Spike CA" } });
  writeFileSync("out/ca.pem", rootCa.cert);
  writeFileSync("out/ca.key", rootCa.key, { mode: 0o600 });
  const child = spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
    stdio: "inherit",
    env: {
      ...process.env,
      MOCKTOWN_SPIKE_CHILD: "1",
      NODE_EXTRA_CA_CERTS: "out/ca.pem",
      // Node's global fetch (undici) honours these only with NODE_USE_ENV_PROXY set.
      HTTPS_PROXY: "http://127.0.0.1:8300",
      HTTP_PROXY: "http://127.0.0.1:8300",
      NODE_USE_ENV_PROXY: "1",
    },
  });
  process.exit(child.status ?? 1);
}

// ── emulate as the upstream, so nothing real is contacted ─────────────────────
const emu = spawn("bunx", ["emulate", "start", "-p", "4600", "-s", "stripe,github,google", "--seed", "seeds.yaml"],
  { stdio: ["ignore", "pipe", "pipe"] });
const urls = new Map();
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("emulate startup timeout")), 25000);
  const onData = (b) => {
    for (const [, svc, url] of b.toString().matchAll(/^\s*(\S+)\s+(https?:\/\/\S+)\s*$/gm)) {
      urls.set(svc, url.replace("//localhost:", "//127.0.0.1:"));
    }
    if (urls.has("stripe") && urls.has("github") && urls.has("google")) { clearTimeout(timer); resolve(); }
  };
  emu.stdout.on("data", onData);
  emu.stderr.on("data", onData);
});

// emulate's banner is not a readiness signal — it announces every service's URL before
// they are all listening (see spikes/03-emulate/FINDINGS.md). Probe until each answers.
// A raw TCP connect, not fetch: this process runs with HTTPS_PROXY set, so fetch would be
// routed through a proxy that hasn't started yet.
await Promise.all([...urls].map(async ([service, url]) => {
  const { port } = new URL(url);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const up = await new Promise((resolve) => {
      const sock = net.connect({ port: Number(port), host: "127.0.0.1" });
      sock.setTimeout(1000);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error", () => resolve(false));
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`emulate announced ${service} at ${url} but it never listened`);
}));

// ── the front door ────────────────────────────────────────────────────────────
const ca = { cert: readFileSync("out/ca.pem", "utf8"), key: readFileSync("out/ca.key", "utf8") };
const proxy = mockttp.getLocal({ https: { cert: ca.cert, key: ca.key } });
await proxy.start(8300);

await proxy.forAnyRequest().forHost("api.stripe.com").always().thenForwardTo(urls.get("stripe"), { ignoreHostHttpsErrors: true });
await proxy.forAnyRequest().forHost("api.github.com").always().thenForwardTo(urls.get("github"), { ignoreHostHttpsErrors: true });
await proxy.forAnyRequest().forHost("github.com").always().thenForwardTo(urls.get("github"), { ignoreHostHttpsErrors: true });
await proxy.forAnyRequest().forHost("accounts.google.com").always().thenForwardTo(urls.get("google"), { ignoreHostHttpsErrors: true });
await proxy.forAnyRequest().forHost("oauth2.googleapis.com").always().thenForwardTo(urls.get("google"), { ignoreHostHttpsErrors: true });
// Anything not routed to emulate is denied rather than passed through: this harness must
// never touch a real API, and a silent fallthrough is how it would.
await proxy.forAnyRequest().always().thenCallback((req) => {
  console.log(`  DENIED (would have escaped): ${req.method} ${req.url}`);
  return { statusCode: 599, body: "denied by the capture harness" };
});

// Correlate request and response into one exchange, as the recorder does (03-capture.md).
const exchanges = [];
const pending = new Map();
proxy.on("request", async (req) => {
  pending.set(req.id, { method: req.method, url: req.url, headers: req.headers, body: (await req.body.getText()) ?? "" });
});
proxy.on("response", async (res) => {
  const req = pending.get(res.id);
  if (!req) return;
  pending.delete(res.id);
  exchanges.push({
    id: res.id, method: req.method, url: req.url, statusCode: res.statusCode,
    requestHeaders: req.headers, requestBody: req.body,
    responseHeaders: res.headers, responseBody: (await res.body.getText()) ?? "",
  });
});

console.log("  emulate upstreams:", JSON.stringify(Object.fromEntries(urls)));
proxy.on("request", (r) => console.log(`  -> ${r.method} ${r.url}`));
proxy.on("response", (r) => console.log(`  <- ${r.statusCode} (id ${r.id})`));

const agent = new HttpsProxyAgent("http://127.0.0.1:8300", { ca: ca.cert });

// The literal secrets used below are the ground truth: spike.ts asserts that none of
// them survives anywhere in the scrubbed corpus.
export const SECRETS = {
  stripeKey: "sk_test_51QxSpIkeRealLookingSecretKeyABCDEFGHIJKLMNOP",
  githubPat: "ghp_R3alL00k1ngPersonalAccessToken0123456789",
  oauthClientSecret: "mocktown_spike_secret",
  sessionCookie: "sid=8f14e45fceea167a5a36dedd4bea2543deadbeefcafef00d",
  cardNumber: "5555555555554444",   // deliberately NOT the scrubber's replay fake (4242…),
                                    // so a leak can be told apart from a correct re-injection
  ssn: "123-45-6789",
  password: "hunter2-correct-horse-battery",
};

const step = async (name, fn) => {
  try { await fn(); console.log(`  captured: ${name}`); }
  catch (e) { console.log(`  capture step failed (recorded anyway): ${name}: ${(e.message ?? e).toString().slice(0, 110)}`); }
};

// ── 1. Stripe SDK over real TLS to api.stripe.com ────────────────────────────
const stripe = new Stripe(SECRETS.stripeKey, { httpAgent: agent });
await step("stripe.customers.create + paymentIntents.create", async () => {
  const customer = await stripe.customers.create({ email: "ada@example.com", name: "Ada Lovelace" });
  await stripe.paymentIntents.create({ amount: 4200, currency: "usd", customer: customer.id });
});

// ── 2. Octokit over real TLS to api.github.com ───────────────────────────────
const octokit = new Octokit({ auth: SECRETS.githubPat }); // proxied via the environment, not an agent
await step("octokit.repos.get + issues.create", async () => {
  await octokit.repos.get({ owner: "octocat", repo: "hello-world" });
  await octokit.issues.create({ owner: "octocat", repo: "hello-world", title: "Captured by the spike", body: "hello" });
});

// ── 3. A real OAuth token exchange: client_secret in, RS256 access_token out ─
function request(options, body) {
  return new Promise((resolve, reject) => {
    const req = https.request({ agent, ...options }, (res) => {
      let b = ""; res.on("data", (d) => (b += d)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}
await step("oauth consent + token exchange", async () => {
const consent = await request({
  host: "github.com", path: "/login/oauth/callback", method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
}, new URLSearchParams({ login: "octocat", client_id: "Iv1.mocktown_spike", redirect_uri: "http://127.0.0.1:9999/cb", state: "s", scope: "repo" }).toString());
const code = new URL(consent.headers.location ?? "http://x/?code=none").searchParams.get("code");
await request({
  host: "github.com", path: "/login/oauth/access_token", method: "POST",
  headers: { "content-type": "application/json", accept: "application/json" },
}, JSON.stringify({ client_id: "Iv1.mocktown_spike", client_secret: SECRETS.oauthClientSecret, code, redirect_uri: "http://127.0.0.1:9999/cb" }));
});

// ── 4. An app request carrying the PII the deny-pattern list targets ─────────
// Shaped like a real signup/checkout call so the scrubber is tested on a body it will
// genuinely meet, not on a synthetic bag of keywords.
await step("app request carrying PII", async () => { await request({
  host: "api.stripe.com", path: "/v1/customers", method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: `Bearer ${SECRETS.stripeKey}`,
    cookie: SECRETS.sessionCookie,
    "x-api-key": "xapi_live_9f8e7d6c5b4a39281706",
  },
}, JSON.stringify({
  email: "grace@example.com",
  password: SECRETS.password,
  payment: { card: { number: SECRETS.cardNumber, cvc: "314", exp_month: 12, exp_year: 2030 } },
  applicant: { ssn: SECRETS.ssn, name: "Grace Hopper" },
  // A decoy: the word "token" in a harmless product description must survive intact.
  product: { name: "Token Ring Adapter", description: "A legacy token ring network adapter" },
})); });

// Give the proxy a moment to finish emitting response events before writing.
await new Promise((r) => setTimeout(r, 500));

// ── 5. A Google OIDC exchange, for a genuine RS256 JWT in the corpus ────────
// 10-security.md requires "JWT-shaped strings anywhere" to be redacted; testing that
// against a real signed id_token beats testing it against a hand-made string.
await step("google OIDC exchange (real RS256 id_token)", async () => {
  const consent = await request({
    host: "accounts.google.com", path: "/o/oauth2/v2/auth/callback", method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }, new URLSearchParams({
    email: "testuser@gmail.com", client_id: "example-client-id.apps.googleusercontent.com",
    redirect_uri: "http://127.0.0.1:9999/cb", scope: "openid email", state: "s", nonce: "", code_challenge: "",
  }).toString());
  const gcode = new URL(consent.headers.location ?? "http://x/?code=none").searchParams.get("code");
  await request({
    host: "oauth2.googleapis.com", path: "/oauth2/token", method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
  }, new URLSearchParams({
    code: gcode, client_id: "example-client-id.apps.googleusercontent.com",
    client_secret: "GOCSPX-example_secret", redirect_uri: "http://127.0.0.1:9999/cb", grant_type: "authorization_code",
  }).toString());
});

await new Promise((r) => setTimeout(r, 500));

writeFileSync("corpus.raw.json", JSON.stringify(exchanges, null, 2));
writeFileSync("secrets.json", JSON.stringify(SECRETS, null, 2));
console.log(`captured ${exchanges.length} exchanges -> corpus.raw.json`);

await proxy.stop();
emu.kill("SIGTERM");
process.exit(0);
