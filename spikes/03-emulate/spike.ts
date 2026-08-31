/**
 * Phase 0 / Spike 03 — emulate driven as child processes.
 *
 * Question (docs/design/11-roadmap.md): "emulate driven as child processes: start/stop/seed
 * Stripe + GitHub, point real SDKs at them, confirm OAuth flow works end-to-end."
 *
 * The real subject here is `provider.ts` — the wrapper 06-emulation.md insists on
 * ("emulate is wrapped, never load-bearing"). These tests only ever talk to that wrapper
 * and to real vendor SDKs, never to emulate directly.
 *
 *   bun run spike.ts
 */
import { EmulateProvider } from "./provider.ts";
import Stripe from "stripe";
import { Octokit } from "@octokit/rest";
import { networkInterfaces } from "node:os";

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });

const provider = new EmulateProvider({ services: ["stripe", "github"], seedFile: "seeds.yaml" });

// ── 1. Start as a managed child process ───────────────────────────────────────
let urls: Map<string, string>;
try {
  urls = await provider.start();
  check("Provider starts emulate + reports base URLs",
    urls.has("stripe") && urls.has("github") && provider.isRunning,
    [...urls].map(([s, u]) => `${s}=${u}`).join(" "));
} catch (e: any) {
  check("Provider starts emulate + reports base URLs", false, e.message?.slice(0, 200));
  console.log(results.map((r) => `  FAIL  ${r.name}  ${r.detail}`).join("\n"));
  process.exit(1);
}

const stripeUrl = new URL(provider.baseUrlFor("stripe"));
const githubUrl = provider.baseUrlFor("github");

// ── 2. Seed data from project config is applied ───────────────────────────────
{
  const customers: any = await (await fetch(`${stripeUrl.origin}/v1/customers`, { headers: { authorization: "Bearer sk_test_x" } })).json();
  const repo: any = await (await fetch(`${githubUrl}/repos/octocat/hello-world`, { headers: { authorization: "Bearer test_token_admin" } })).json();
  const seededCustomer = customers.data?.some((c: any) => c.email === "ada@example.com");
  check("Seed file applied to both services",
    seededCustomer && repo.description === "Seeded by Mocktown",
    `stripe customer=${seededCustomer} github repo=${repo.full_name}`);
}

// ── 3. The real Stripe SDK, pointed at the emulator by its own knobs ──────────
// 05-redirection.md lists this exact recipe as the service's EKB entry:
// Stripe has host/port/protocol constructor options, so no code patch is needed.
{
  try {
    const stripe = new Stripe("sk_test_mocktown", {
      host: stripeUrl.hostname,
      port: Number(stripeUrl.port),
      protocol: "http",
    });
    const customer = await stripe.customers.create({ email: "grace@example.com", name: "Grace Hopper" });
    const fetched = await stripe.customers.retrieve(customer.id);
    const intent = await stripe.paymentIntents.create({ amount: 4200, currency: "usd", customer: customer.id });
    check("Real Stripe SDK against the emulator",
      customer.id.startsWith("cus_") && (fetched as any).email === "grace@example.com" && intent.amount === 4200,
      `customer=${customer.id} intent=${intent.id} status=${intent.status}`);
  } catch (e: any) { check("Real Stripe SDK against the emulator", false, (e.message ?? String(e)).slice(0, 160)); }
}

// ── 4. The real Octokit, pointed at the emulator by baseUrl ──────────────────
{
  try {
    const octokit = new Octokit({ auth: "test_token_admin", baseUrl: githubUrl });
    const { data: repo } = await octokit.repos.get({ owner: "octocat", repo: "hello-world" });
    const { data: issue } = await octokit.issues.create({ owner: "octocat", repo: "hello-world", title: "Filed by the spike", body: "hello" });
    const { data: issues } = await octokit.issues.listForRepo({ owner: "octocat", repo: "hello-world" });
    check("Real Octokit against the emulator",
      repo.full_name === "octocat/hello-world" && issue.number > 0 && issues.some((i) => i.number === issue.number),
      `repo=${repo.full_name} issue=#${issue.number} listed=${issues.length}`);
  } catch (e: any) { check("Real Octokit against the emulator", false, (e.message ?? String(e)).slice(0, 160)); }
}

// ── 5. OAuth end to end: authorize -> consent -> code -> token -> API call ────
{
  try {
    const authorize = new URL(`${githubUrl}/login/oauth/authorize`);
    authorize.search = new URLSearchParams({
      client_id: "Iv1.mocktown_spike",
      redirect_uri: "http://127.0.0.1:9999/callback",
      state: "mocktown-state",
      scope: "repo",
    }).toString();

    // The consent screen is a user picker; pick the seeded octocat.
    const consent = await fetch(authorize);
    const consentHtml = await consent.text();
    if (!consentHtml.includes('value="octocat"')) throw new Error("seeded user not offered on the consent screen");

    const callback = await fetch(`${githubUrl}/login/oauth/callback`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        login: "octocat", client_id: "Iv1.mocktown_spike",
        redirect_uri: "http://127.0.0.1:9999/callback", state: "mocktown-state", scope: "repo",
      }),
      redirect: "manual",
    });
    const location = new URL(callback.headers.get("location") ?? "");
    const code = location.searchParams.get("code");
    const stateEchoed = location.searchParams.get("state") === "mocktown-state";
    if (!code) throw new Error(`no code in redirect: ${location}`);

    const tokenRes = await fetch(`${githubUrl}/login/oauth/access_token`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: "Iv1.mocktown_spike", client_secret: "mocktown_spike_secret",
        code, redirect_uri: "http://127.0.0.1:9999/callback",
      }),
    });
    const token: any = await tokenRes.json();
    if (!token.access_token) throw new Error(`no access_token: ${JSON.stringify(token).slice(0, 120)}`);

    // The issued token must actually authenticate a real SDK call.
    const asUser = new Octokit({ auth: token.access_token, baseUrl: githubUrl });
    const { data: me } = await asUser.users.getAuthenticated();

    check("OAuth end-to-end, token authenticates an SDK call",
      stateEchoed && me.login === "octocat",
      `state echoed=${stateEchoed} token=${String(token.access_token).slice(0, 12)}… authenticated as ${me.login}`);
  } catch (e: any) { check("OAuth end-to-end, token authenticates an SDK call", false, (e.message ?? String(e)).slice(0, 180)); }
}

// ── 6. emulate binds every interface, not just loopback ───────────────────────
// Recorded as a finding, not a wish: 10-security.md wants loopback only, so the front
// door must be the only thing that can reach provider ports.
{
  const lan = Object.values(networkInterfaces()).flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  let reachableOffLoopback = false;
  if (lan) {
    try {
      const res = await fetch(`http://${lan}:${stripeUrl.port}/v1/customers`, {
        headers: { authorization: "Bearer sk_test_x" }, signal: AbortSignal.timeout(3000),
      });
      reachableOffLoopback = res.ok;
    } catch { reachableOffLoopback = false; }
  }
  check("emulate ports are loopback-only", !reachableOffLoopback,
    lan ? `reachable on ${lan}:${stripeUrl.port} = ${reachableOffLoopback}` : "no non-loopback interface to test from");
}

// ── 7. Stop terminates the child cleanly ──────────────────────────────────────
{
  await provider.stop();
  let stillServing = true;
  try {
    await fetch(`${stripeUrl.origin}/v1/customers`, { signal: AbortSignal.timeout(2000) });
  } catch { stillServing = false; }
  check("stop() terminates the child and frees the port", !provider.isRunning && !stillServing,
    `isRunning=${provider.isRunning} portStillServing=${stillServing}`);
}

// ── 8. Restart with the same seed is reproducible ─────────────────────────────
// 06-emulation.md: "Seed data … is part of project config so sandbox runs are reproducible."
{
  try {
    const second = new EmulateProvider({ services: ["stripe"], seedFile: "seeds.yaml" });
    const restarted = await second.start();
    const customers: any = await (await fetch(`${restarted.get("stripe")}/v1/customers`, { headers: { authorization: "Bearer sk_test_x" } })).json();
    const emails: string[] = customers.data.map((c: any) => c.email).sort();
    // Grace was created at runtime in test 3 and must NOT survive; Ada is seeded and must.
    check("Restart is reproducible from the seed",
      emails.includes("ada@example.com") && !emails.includes("grace@example.com"),
      `customers=[${emails.join(", ")}]`);
    await second.stop();
  } catch (e: any) { check("Restart is reproducible from the seed", false, (e.message ?? String(e)).slice(0, 160)); }
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log(`\n  runtime: bun ${Bun.version} · emulate 0.10.0`);
for (const r of results) console.log(`  ${r.ok ? "PASS" : "FAIL"}  ${r.name.padEnd(46)} ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
