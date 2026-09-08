/**
 * Zod is the single schema language (02-architecture.md), so the config files are
 * validated by the same library the API contract is written in.
 */
import * as z from 'zod/v4';

/** How the front door routes one hostname (03-capture.md's mode table). */
export const ProviderRef = z
  .union([
    z.templateLiteral(['emulator:', z.string()]),
    z.templateLiteral(['generated:', z.string()]),
    z.literal('passthrough'),
    z.literal('record'),
    z.literal('deny'),
  ])
  .describe('How the front door routes this hostname (03-capture.md)');
export type ProviderRef = z.infer<typeof ProviderRef>;

export const ServiceConfig = z.object({
  provider: ProviderRef,
  seed: z.string().optional().describe('Path to a seed file, relative to the repo root'),
});

/** `mocktown.json` — committed, so project identity travels with the code. */
export const ProjectFile = z.object({
  project: z.string().min(1).describe('Project name'),
  services: z.record(z.string(), ServiceConfig).default({}),
  /**
   * Hosts the app reaches without the front door — its own local services, typically. It
   * is the counterweight to dropping the blanket `localhost` bypass: with a `.localhost`
   * service registered, `localhost:3000` is proxied like anything else unless it is named
   * here. Every entry is a hole, and a host listed here can never be recorded.
   */
  noProxy: z
    .array(z.string())
    .default([])
    .describe('Hosts the app reaches directly, bypassing the front door. Every entry is a hole — a host listed here cannot be recorded'),
  /**
   * What the corpus refuses to hold. A recorded browser talks to its own vendor constantly,
   * and none of it is evidence about a dependency — see `capture/noise.ts` for the list and
   * for why most entries are path-scoped rather than whole-host.
   */
  capture: z
    .object({
      ignoreNoise: z
        .boolean()
        .default(true)
        .describe("Drop the client runtime's own traffic — browser updates, telemetry, captive-portal probes"),
      ignore: z
        .array(z.string())
        .default([])
        .describe('Extra noise patterns, as "host" or "host/path-prefix". Matches are not recorded and file no issue'),
      keep: z
        .array(z.string())
        .default([])
        .describe('Patterns to record even though a default covers them — e.g. "accounts.google.com" for a real OAuth flow'),
    })
    .default({ ignoreNoise: true, ignore: [], keep: [] }),
  sandbox: z
    .object({
      image: z.string().default('auto').describe('Base image the sandbox layer is built on; `auto` picks a sane default'),
      /** 04-sandbox.md: an agent testing a web app must browse *inside* the boundary. */
      browser: z.boolean().default(true).describe('Ship headless Chromium in the sandbox image'),
      ports: z.array(z.string()).default([]).describe('Host port publications for the sandbox, e.g. "3000:3000"'),
    })
    .default({ image: 'auto', browser: true, ports: [] }),
  /** The flows a seal run exercises. A seal is only as good as this list (05-redirection.md). */
  seal: z
    .object({
      flows: z
        .array(z.string())
        .default([])
        .describe('Commands a seal run executes inside the boundary. A seal proves only what these exercise'),
    })
    .default({ flows: [] }),
  /**
   * Drift watch (07-issues-agent-loop.md). **Off by default, and it must stay that way:** a
   * drift run re-records against the *real* services, so it spends real quota and real
   * money and needs the app's real credentials. Nothing about a mocking tool should start
   * calling production on a timer because a config default said so.
   */
  drift: z
    .object({
      enabled: z.boolean().default(false).describe('Run on a schedule. A drift run calls the real services'),
      intervalHours: z.number().int().min(1).default(24).describe('Hours between drift runs, when drift is enabled'),
      services: z.array(z.string()).default([]).describe('Services to judge; empty means every service with a running provider'),
      flows: z.array(z.string()).default([]).describe('Commands that exercise the real dependencies; falls back to seal.flows when empty'),
    })
    .default({ enabled: false, intervalHours: 24, services: [], flows: [] }),
  /**
   * Where the app under test is reachable while mocktown is serving. Nothing dispatches on
   * it and nothing breaks without it — it is the one URL every screen wants to link to and
   * that mocktown cannot derive, because the app is the developer's process, not ours.
   */
  app: z
    .object({
      url: z.string().nullable().default(null).describe('The app under test, e.g. http://localhost:5173'),
    })
    .default({ url: null }),
  /**
   * What `env write` is allowed to touch. `.env.mocktown` is gitignored and mocktown's own
   * file, so writing it is unremarkable. `AGENTS.md` is neither: it is committed, hand-written
   * and shared, and mocktown appending a generated section to it turns every `env write` into
   * an unrequested diff on a tracked file. Off by default — editing a repo's own documentation
   * is a decision someone makes once, not a side effect of regenerating an env file.
   */
  env: z
    .object({
      agentsFile: z
        .boolean()
        .default(false)
        .describe(
          'Let `env write` add its section to the workspace AGENTS.md. That file is committed; mocktown does not edit it uninvited',
        ),
    })
    .default({ agentsFile: false }),
  /**
   * portless stable names (05-redirection.md). Off by default like drift, for a different
   * reason: portless binds 443 with sudo, edits `/etc/hosts` and puts a CA in the system
   * trust store. Opting into that is a person's decision, not a config default's.
   */
  portless: z
    .object({
      enabled: z.boolean().default(false).describe('Give each service a stable `<service>.<project>.<tld>` name'),
      tld: z.string().default('localhost').describe('Preferred TLD; the running proxy overrides it'),
      port: z.number().int().default(443).describe('Preferred proxy port; the running proxy overrides it'),
      tls: z.boolean().default(true).describe('Preferred scheme; whichever the running proxy answers on wins'),
    })
    .default({ enabled: false, tld: 'localhost', port: 443, tls: true }),
  scrub: z
    .object({
      /** Extra project rules, appended to the defaults in 10-security.md. */
      rules: z
        .array(
          z.object({
            kind: z.string(),
            headers: z.array(z.string()).optional(),
            fields: z.array(z.string()).optional(),
            pattern: z.string().optional().describe('JavaScript regular expression source'),
          }),
        )
        .default([]),
      /** The entropy heuristic from 10-security.md. On by default; off is a project decision. */
      entropyBackstop: z
        .boolean()
        .default(true)
        .describe('Redact high-entropy strings no named rule caught. Off trades a safety net for fewer false positives'),
      /** Emails are load-bearing for mock fidelity, so redacting them is opt-in (spike 05). */
      redactEmails: z
        .boolean()
        .default(false)
        .describe('Redact email addresses too. Off by default because they are load-bearing for mock fidelity'),
    })
    .default({ rules: [], entropyBackstop: true, redactEmails: false }),
});
export type ProjectFile = z.infer<typeof ProjectFile>;

/** `.mocktown/config.local.json` — machine-specific, gitignored. */
export const LocalConfig = z.object({
  frontDoorPort: z.number().int().optional(),
  daemonPort: z.number().int().optional(),
  passthrough: z.array(z.string()).default([]).describe('Extra hostnames allowed straight out'),
});
export type LocalConfig = z.infer<typeof LocalConfig>;

/** `~/.config/mocktown/config.json` — the global registry and preferences. */
export const GlobalConfig = z.object({
  defaultProject: z.string().default('main'),
  projects: z.record(z.string(), z.object({ dataDir: z.string(), workspace: z.string().nullable().default(null) })).default({}),
  telemetry: z.boolean().default(false),
});
export type GlobalConfig = z.infer<typeof GlobalConfig>;
