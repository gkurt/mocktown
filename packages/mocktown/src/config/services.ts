/**
 * Writing one registry entry back to `mocktown.json`.
 *
 * `services set` used to write only the daemon's database, which made the command a lie in
 * the one place it is most often reached from: an `undeclared-service` issue says "commit
 * it, so the next machine inherits the decision instead of recording the host again", and
 * the decision stayed on the machine that made it. A registry entry is the most portable
 * thing in the project — it is the whole point of the file being committed.
 *
 * The round trip is `settings.ts`'s: re-read the raw file rather than re-serialise a parsed
 * config, so keys this version does not know about survive an edit by it.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { ProjectFile, type ProviderRef } from '#src/config/schema.ts';

export interface ServiceEntry {
  provider: ProviderRef;
  seed?: string | undefined;
  aliases?: string[] | undefined;
}

/**
 * Merges rather than replaces: `--provider` alone must not silently drop the aliases or the
 * seed already committed for that service, which is the same rule the database write follows.
 */
export function writeService(projectFile: string, id: string, entry: ServiceEntry): void {
  const raw = existsSync(projectFile) ? JSON.parse(readFileSync(projectFile, 'utf8')) : {};
  const services = (raw.services ??= {});
  const existing = services[id] ?? {};

  services[id] = {
    ...existing,
    provider: entry.provider,
    ...(entry.seed === undefined ? {} : { seed: entry.seed }),
    ...(entry.aliases === undefined ? {} : { aliases: entry.aliases }),
  };
  if (services[id].seed === undefined) delete services[id].seed;

  const parsed = ProjectFile.safeParse(raw);
  if (!parsed.success) throw new Error(`${id} rejected: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`);

  writeFileSync(projectFile, `${JSON.stringify(raw, null, 2)}\n`);
}
