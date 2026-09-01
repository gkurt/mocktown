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
  sandbox: z.object({ image: z.string().default('auto') }).default({ image: 'auto' }),
  seal: z.object({ flows: z.array(z.string()).default([]) }).default({ flows: [] }),
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
