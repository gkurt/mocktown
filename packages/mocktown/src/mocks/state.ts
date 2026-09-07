/**
 * Generated-mock state, backed by the project's SQLite (06-emulation.md: "state backed
 * by project SQLite when the recordings show create/read coupling").
 *
 * Rows are namespaced by (service, profile, collection), which is what makes
 * `mocktown state reset` a drop + re-seed cheap enough to run between test cases —
 * the thing emulator-backed services cannot do, since they reset by process restart
 * (12-scenario-controls.md, spike 03).
 */
import { and, eq } from 'drizzle-orm';
import type { Db } from '#src/db/client.ts';
import { schema } from '#src/db/client.ts';
import type { StateStore } from '#src/mocks/types.ts';

export class SqliteStateStore implements StateStore {
  private readonly db: Db;
  private readonly service: string;
  private readonly profile: string;
  /** Ids handed out but not yet written, so `nextId` can be called before `set`. */
  private readonly issued = new Map<string, number>();

  constructor(db: Db, service: string, profile: string) {
    this.db = db;
    this.service = service;
    this.profile = profile;
  }

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
      .where(
        and(
          eq(schema.mockState.service, this.service),
          eq(schema.mockState.profile, this.profile),
          eq(schema.mockState.collection, collection),
        ),
      )
      .all()
      .map((row) => ({ key: row.key, value: row.value as T }));
  }

  count(collection: string): number {
    return this.list(collection).length;
  }

  /**
   * Sequential rather than random, on purpose: an id an agent can predict makes a failing
   * replay readable, and the determinism contract holds without consuming a PRNG stream.
   *
   * It also has to be monotonic *within* a pass, not only across them. Deriving it from
   * `count` alone meant three calls before the first `set` all returned `x_000001`, so a
   * seed that built its rows before storing them wrote each one over the last and ended
   * with a single entry — no error, just two thirds of the data missing, discovered when
   * a list came back short. Ids already handed out are remembered here, and `count` still
   * sets the floor so a store built over existing rows never reissues one.
   */
  nextId(collection: string, prefix = 'id'): string {
    const next = Math.max(this.count(collection), this.issued.get(collection) ?? 0) + 1;
    this.issued.set(collection, next);
    return `${prefix}_${String(next).padStart(6, '0')}`;
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
  else
    db.delete(schema.mockState)
      .where(and(...filters))
      .run();
}
