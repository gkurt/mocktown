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
  sandbox: z
    .object({
      image: z.string().default('auto').describe('Base image the sandbox layer is built on; `auto` picks a sane default'),
      /** 04-sandbox.md: an agent testing a web app must browse *inside* the boundary. */
      browser: z.boolean().default(true).describe('Ship headless Chromium in the sandbox image'),
      ports: z.array(z.string()).default([]).describe('Host port publications for the sandbox, e.g. "3000:3000"'),
    })
    .default({ image: 'auto', browser: true, ports: [] }),
  /** The flows a seal run exercises. A seal is only as good as this list (05-redirection.md). */
  seal: z.object({ flows: z.array(z.string()).default([]) }).default({ flows: [] }),
  /**
   * Drift watch (07-issues-agent-loop.md). **Off by default, and it must stay that way:** a
   * drift run re-records against the *real* services, so it spends real quota and real
   * money and needs the app's real credentials. Nothing about a mocking tool should start
   * calling production on a timer because a config default said so.
   */
  drift: z
    .object({
      enabled: z.boolean().default(false).describe('Run on a schedule. A drift run calls the real services'),
      intervalHours: z.number().int().min(1).default(24),
      services: z.array(z.string()).default([]).describe('Services to judge; empty means every service with a running provider'),
      flows: z.array(z.string()).default([]).describe('Commands that exercise the real dependencies; falls back to seal.flows when empty'),
    })
    .default({ enabled: false, intervalHours: 24, services: [], flows: [] }),
  /**
   * portless stable names (05-redirection.md). Off by default like drift, for a different
   * reason: portless binds 443 with sudo, edits `/etc/hosts` and puts a CA in the system
   * trust store. Opting into that is a person's decision, not a config default's.
   */
  portless: z
    .object({
      enabled: z.boolean().default(false).describe('Give each service a stable `<service>.<project>.<tld>` name'),
      tld: z.string().default('localhost').describe('portless TLD; must match the running proxy'),
      port: z.number().int().default(443).describe('Port the portless proxy listens on'),
      tls: z.boolean().default(true).describe('Whether that proxy terminates TLS — false only if it was started with --no-tls'),
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
      entropyBackstop: z.boolean().default(true),
      /** Emails are load-bearing for mock fidelity, so redacting them is opt-in (spike 05). */
      redactEmails: z.boolean().default(false),
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
