/**
 * Seal stamps — 05-redirection.md.
 *
 * > A seal is only as good as the flows that were exercised; the stamp records which ones.
 *
 * So a stamp is never just a boolean. It carries the commit, a hash of the configuration
 * the run was made against, and the flow list, which is what lets `mocktown seal verify`
 * in CI distinguish three different situations that all look alike from a distance:
 * sealed, broken, and *stale* — sealed once, against a configuration that has since
 * changed. Only the first is trustworthy, and treating the third as the first is how a
 * new dependency reaches production behind a green check.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { desc } from 'drizzle-orm';
import type { Db } from '#src/db/client.ts';
import { schema } from '#src/db/client.ts';
import { id } from '#src/util/id.ts';

export interface SealStamp {
  id: string;
  commit: string | null;
  configHash: string;
  sealed: boolean;
  flows: string[];
  wallHits: number;
  createdAt: string;
}

export interface ConfigFingerprint {
  /** service id -> provider ref. A service that changes provider changes the seal. */
  services: Record<string, string>;
  /** Variable *names* only: the values embed machine-local ports and would churn. */
  envVars: string[];
  flows: string[];
}

export function configHash(fingerprint: ConfigFingerprint): string {
  const canonical = JSON.stringify({
    services: Object.fromEntries(Object.entries(fingerprint.services).sort(([a], [b]) => a.localeCompare(b))),
    envVars: [...fingerprint.envVars].sort(),
    flows: fingerprint.flows,
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** The commit the seal is stamped for, or null outside a git checkout. */
export function currentCommit(workspace: string | null): string | null {
  if (!workspace) return null;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function writeStamp(db: Db, stamp: Omit<SealStamp, 'id' | 'createdAt'>): SealStamp {
  const row = { id: id('seal'), ...stamp };
  db.insert(schema.sealStamps).values(row).run();
  return db.select().from(schema.sealStamps).orderBy(desc(schema.sealStamps.createdAt)).limit(1).all()[0]!;
}

export function latestStamp(db: Db): SealStamp | null {
  return db.select().from(schema.sealStamps).orderBy(desc(schema.sealStamps.createdAt)).limit(1).all()[0] ?? null;
}

/** Why a stamp cannot be trusted right now, or an empty list if it can. */
export function stalenessOf(stamp: SealStamp | null, current: { commit: string | null; configHash: string }): string[] {
  if (!stamp) return ['No seal run has been recorded for this project yet.'];
  const reasons: string[] = [];
  if (stamp.configHash !== current.configHash) {
    reasons.push('The service registry, the generated environment or the flow list has changed since this stamp — re-run the seal.');
  }
  if (stamp.commit && current.commit && stamp.commit !== current.commit) {
    reasons.push(`Stamped for commit ${stamp.commit.slice(0, 8)}, working tree is at ${current.commit.slice(0, 8)}.`);
  }
  return reasons;
}
