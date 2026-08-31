/**
 * The endpoint knowledge base, seeded for emulate-backed services (05-redirection.md).
 *
 * Rungs, in the doc's order of preference:
 *   1. a standard env var the SDK already reads
 *   2. an SDK constructor option, with a per-language snippet
 *   3. a code-patch recipe an agent applies
 *
 * Two rules this table follows deliberately:
 *
 * - **A recipe we have not verified is rung 3 with an honest note, never a rung-1 guess.**
 *   A wrong env var is worse than no env var: `mocktown env` would report the service
 *   covered, the seal would pass, and the SDK would quietly keep talking to production.
 * - **Every emulate-backed OAuth service documents the consent POST.** emulate's consent
 *   screen is a user picker, not a login form — you proceed by POSTing `login=<user>` to
 *   the callback (spike 03). Without that in the recipe, an unattended agent run hangs on
 *   an HTML page.
 */
import type { EndpointRecipe } from "../mocks/types.ts";

const CONSENT_NOTE =
  "OAuth on this emulator is a consent *picker* over seeded users, not a credential exchange: " +
  "drive it by POSTing `login=<user>` to the authorize callback rather than filling a login form. " +
  "An unattended run that expects a password prompt will hang on the HTML page.";

export const EMULATE_RECIPES: Record<string, EndpointRecipe[]> = {
  github: [
    { rung: 1, envVar: "GITHUB_API_URL", note: "Read by the gh CLI and by GitHub Actions toolkit clients." },
    {
      rung: 2,
      language: "typescript",
      snippet: `new Octokit({ auth: token, baseUrl: process.env.GITHUB_API_URL })`,
      note: "Octokit v22 uses fetch, so an http.Agent is ignored — set the baseUrl, and NODE_USE_ENV_PROXY=1 when relying on the proxy instead.",
    },
    { rung: 3, note: CONSENT_NOTE },
  ],

  stripe: [
    {
      rung: 2,
      language: "typescript",
      snippet: `new Stripe(key, { host: "127.0.0.1", port: PORT, protocol: "http" })`,
      note: "Stripe's SDKs expose host/port/protocol rather than a single base-URL env var; this is the recipe spike 03 exercised.",
    },
    { rung: 3, note: "For SDKs in other languages, set the equivalent api_base / ApiBase configuration to the emulator's base URL." },
  ],

  aws: [
    { rung: 1, envVar: "AWS_ENDPOINT_URL", note: "The cross-service endpoint override honoured by current AWS SDKs and the CLI." },
    { rung: 1, envVar: "AWS_ENDPOINT_URL_S3", note: "Per-service override; set alongside the general one when only S3 is emulated." },
  ],

  s3: [
    { rung: 1, envVar: "AWS_ENDPOINT_URL_S3" },
    {
      rung: 2,
      language: "typescript",
      snippet: `new S3Client({ endpoint: process.env.AWS_ENDPOINT_URL_S3, forcePathStyle: true })`,
      note: "forcePathStyle is required: virtual-host addressing would resolve bucket.<host> instead of the emulator.",
    },
  ],

  slack: [
    {
      rung: 2,
      language: "typescript",
      snippet: `new WebClient(token, { slackApiUrl: process.env.SLACK_API_URL })`,
      note: "Slack's Node SDK takes slackApiUrl; confirm the option name for other languages before relying on it.",
    },
    { rung: 3, note: CONSENT_NOTE },
  ],

  okta: [
    { rung: 3, note: `Point the app's Okta issuer/org URL at the emulator's base URL. ${CONSENT_NOTE}` },
  ],

  clerk: [
    { rung: 3, note: `Point the Clerk client's API base at the emulator's base URL. ${CONSENT_NOTE}` },
  ],

  google: [
    { rung: 3, note: `Google SDKs resolve endpoints per API; override the discovery/base URL for the specific API in use. ${CONSENT_NOTE}` },
  ],

  vercel: [
    { rung: 3, note: "Set the Vercel SDK's server URL option to the emulator's base URL; there is no standard env var." },
  ],

  linear: [
    { rung: 3, note: "Point the Linear client's GraphQL endpoint at the emulator's base URL." },
  ],

  twilio: [
    { rung: 3, note: "Twilio's SDKs build absolute URLs internally; redirect via the front door proxy rather than an endpoint option." },
  ],

  resend: [
    { rung: 3, note: "Set the Resend client's base URL option if the installed version exposes one; otherwise use the front door proxy." },
  ],

  apple: [{ rung: 3, note: `Override the OIDC issuer for the emulator. ${CONSENT_NOTE}` }],
  microsoft: [{ rung: 3, note: `Override the OIDC authority for the emulator. ${CONSENT_NOTE}` }],
  "mongodb-atlas": [{ rung: 3, note: "Point the Atlas Admin API base URL at the emulator; the data-plane driver connection string is separate." }],
};

/** Well-known service hostnames, so `emulator:stripe` knows which host it is answering for. */
export const EMULATE_HOSTNAMES: Record<string, string> = {
  github: "api.github.com",
  stripe: "api.stripe.com",
  slack: "slack.com",
  google: "www.googleapis.com",
  aws: "aws.amazon.com",
  s3: "s3.amazonaws.com",
  okta: "okta.com",
  clerk: "api.clerk.com",
  vercel: "api.vercel.com",
  linear: "api.linear.app",
  twilio: "api.twilio.com",
  resend: "api.resend.com",
  apple: "appleid.apple.com",
  microsoft: "login.microsoftonline.com",
  "mongodb-atlas": "cloud.mongodb.com",
};
