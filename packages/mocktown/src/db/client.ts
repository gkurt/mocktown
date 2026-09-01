/**
 * Opening a project database. WAL mode, and the daemon is the only writer
 * (02-architecture.md) — everything else reads through the API.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type BunSQLiteDatabase, drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { projectPaths } from '#src/config/paths.ts';
import * as schema from '#src/db/schema.ts';

export type Db = BunSQLiteDatabase<typeof schema>;

const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

const open = new Map<string, Db>();

export function openProjectDb(project: string): Db {
  const cached = open.get(project);
  if (cached) return cached;

  const paths = projectPaths(project);
  mkdirSync(paths.root, { recursive: true });
  mkdirSync(paths.blobs, { recursive: true });

  const sqlite = new Database(paths.db, { create: true });
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  // A recording session writes one row per exchange; NORMAL is the right durability
  // trade for a local corpus that can always be re-recorded.
  sqlite.exec('PRAGMA synchronous = NORMAL;');
  sqlite.exec('PRAGMA busy_timeout = 5000;');

  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  open.set(project, db);
  return db;
}

/** Read-only handle for clients that must not write (Studio, panels, tests). */
export function openProjectDbReadOnly(project: string): Db {
  const sqlite = new Database(projectPaths(project).db, { readonly: true });
  return drizzle(sqlite, { schema });
}

export function closeProjectDb(project: string): void {
  open.delete(project);
}

export { schema };
