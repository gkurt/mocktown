/**
 * Auth profiles — 12-scenario-controls.md's primary axis for scenario variation.
 *
 * "What does this app look like for a brand-new user vs. a power user" is a profile
 * switch, not a knob flip. So every project starts with at least `default` (typical data)
 * and `empty-org` (zero everything) — the empty-state scenario teams most often cannot
 * test — plus `anonymous`, which is what an unauthenticated request maps to.
 *
 * Credentials are always synthetic (`*.test` domains, generated passwords) and never
 * derived from recorded real credentials (10-security.md).
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import { id } from "../util/id.ts";

export interface BuiltinProfile {
  name: string;
  description: string;
  credentials: Record<string, string>;
  context: Record<string, string>;
  signIn: "credentials" | "consent-picker" | "token-only";
}

export const BUILTIN_PROFILES: BuiltinProfile[] = [
  {
    name: "anonymous",
    description: "No credentials at all. Every unauthenticated request maps here; use it to test what a signed-out visitor sees and which endpoints correctly refuse.",
    credentials: {},
    context: {},
    signIn: "token-only",
  },
  {
    name: "default",
    description: "The typical signed-in user: populated data, verified email, a normal-sized organisation. This is the persona recorded traffic informs, and the baseline other profiles are described against.",
    credentials: { email: "default@mocktown.test", password: "mock-default-1" },
    context: { orgId: "org_default01", projectId: "prj_default01" },
    signIn: "credentials",
  },
  {
    name: "empty-org",
    description: "Brand-new signup: zero items, no teammates, unverified email. Differs from `default` by having no data at all — use it to test every empty state.",
    credentials: { email: "empty@mocktown.test", password: "mock-empty-1" },
    context: { orgId: "org_empty01", projectId: "prj_empty01" },
    signIn: "credentials",
  },
];

export function ensureDefaultProfiles(db: Db): void {
  for (const profile of BUILTIN_PROFILES) {
    db.insert(schema.profiles)
      .values({
        name: profile.name,
        description: profile.description,
        credentials: profile.credentials,
        context: profile.context,
        knobOverrides: {},
        signIn: profile.signIn,
      })
      .onConflictDoNothing()
      .run();
  }
}

export function listProfiles(db: Db) {
  return db.select().from(schema.profiles).all();
}

/**
 * `POST /profiles/<name>/session` mints a ready-made token for API-level testing that
 * skips the login UI (12-scenario-controls.md). The token is tagged to the session, so a
 * `state reset` — which starts a new session — invalidates nothing accidentally but does
 * make the audit trail readable.
 */
export function mintProfileSession(db: Db, profile: string, sessionId: string): { token: string; header: string } {
  const exists = db.select().from(schema.profiles).where(eq(schema.profiles.name, profile)).get();
  if (!exists) throw new Error(`no profile named "${profile}" — run \`mocktown profiles list\` to see the roster`);

  const token = `mtk_${id("p").slice(2)}`;
  db.insert(schema.profileSessions).values({ token, profile, sessionId }).run();
  return { token, header: `Bearer ${token}` };
}
