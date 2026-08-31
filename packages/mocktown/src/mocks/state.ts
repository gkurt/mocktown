/**
 * Generated-mock state, backed by the project's SQLite (06-emulation.md: "state backed
 * by project SQLite when the recordings show create/read coupling").
 *
 * Rows are namespaced by (service, profile, collection), which is what makes
 * `mocktown state reset` a drop + re-seed cheap enough to run between test cases —
 * the thing emulator-backed services cannot do, since they reset by process restart
 * (12-scenario-controls.md, spike 03).
 */
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { schema } from "../db/client.ts";
import type { StateStore } from "./types.ts";

export class SqliteStateStore implements StateStore {
  constructor(
    private readonly db: Db,
    private readonly service: string,
    private readonly profile: string,
  ) {}

  private scope(collection: string, key: string) {
    return and(
      eq(schema.mockState.service, this.service),
      eq(schema.mockState.profile, this.profile),
      eq(schema.mockState.collection, collection),
      eq(schema.mockState.key, key),
    );
  }

  get<T = unknown>(collection: string, key: string): T | undefined {
    const row = this.db.select().from(schema.mockState).where(this.scope(collection, key)).get();
    return row ? (row.value as T) : undefined;
  }

  set(collection: string, key: string, value: unknown, options: { seeded?: boolean } = {}): void {
    this.db
      .insert(schema.mockState)
      .values({ service: this.service, profile: this.profile, collection, key, value, seeded: options.seeded ?? false })
      .onConflictDoUpdate({
        target: [schema.mockState.service, schema.mockState.profile, schema.mockState.collection, schema.mockState.key],
        set: { value, updatedAt: new Date().toISOString() },
      })
      .run();
  }

  delete(collection: string, key: string): boolean {
    const existed = this.get(collection, key) !== undefined;
    this.db.delete(schema.mockState).where(this.scope(collection, key)).run();
    return existed;
  }

  list<T = unknown>(collection: string): { key: string; value: T }[] {
    return this.db
      .select()
      .from(schema.mockState)
      .where(and(
        eq(schema.mockState.service, this.service),
        eq(schema.mockState.profile, this.profile),
        eq(schema.mockState.collection, collection),
      ))
      .all()
      .map((row) => ({ key: row.key, value: row.value as T }));
  }

  count(collection: string): number {
    return this.list(collection).length;
  }

  /**
   * Sequential rather than random, on purpose: an id an agent can predict makes a failing
   * replay readable, and the determinism contract holds without consuming a PRNG stream.
   */
  nextId(collection: string, prefix = "id"): string {
    const next = this.count(collection) + 1;
    return `${prefix}_${String(next).padStart(6, "0")}`;
  }
}

export interface ResetScope {
  service?: string;
  profile?: string;
}

/** Drop mutable state for a scope. Seeded rows go too — re-seeding is the caller's job. */
export function dropState(db: Db, scope: ResetScope): void {
  const filters = [
    ...(scope.service ? [eq(schema.mockState.service, scope.service)] : []),
    ...(scope.profile ? [eq(schema.mockState.profile, scope.profile)] : []),
  ];
  if (filters.length === 0) db.delete(schema.mockState).run();
  else db.delete(schema.mockState).where(and(...filters)).run();
}
