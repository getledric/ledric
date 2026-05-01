import { sql, type Kysely } from 'kysely';
import type { Database } from '../schema.js';
import type { Migration } from './types.js';

export type Dialect = 'sqlite' | 'mysql' | 'postgres';

// Dialect-specific DDL for the bootstrap _migrations table. It needs to
// exist before we can read/write applied-migration ids, so it lives
// outside the consolidated init migration.
const BOOTSTRAP: Record<Dialect, string> = {
  sqlite: `
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE,
      applied_at INTEGER NOT NULL
    ) STRICT;
  `,
  mysql: `
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INT          PRIMARY KEY,
      name       VARCHAR(255) NOT NULL UNIQUE,
      applied_at BIGINT       NOT NULL
    );
  `,
  postgres: `
    CREATE TABLE IF NOT EXISTS _migrations (
      id         INTEGER PRIMARY KEY,
      name       TEXT    NOT NULL UNIQUE,
      applied_at BIGINT  NOT NULL
    );
  `
};

/**
 * Apply any unapplied migrations against the given Kysely instance.
 *
 * Each migration's `sql` may contain multiple statements separated by
 * semicolons. We split on semicolons and execute one at a time — most
 * drivers refuse multi-statement strings, and Kysely's `sql` template
 * is a single-statement primitive too.
 *
 * Migrations run inside a transaction per migration. If any statement
 * fails, the whole migration rolls back and the runner throws.
 */
export async function runMigrations(
  db: Kysely<Database>,
  dialect: Dialect,
  migrations: readonly Migration[]
): Promise<void> {
  await sql.raw(BOOTSTRAP[dialect]).execute(db);

  const applied = new Set<number>(
    (await db.selectFrom('_migrations').select('id').execute()).map((r) => r.id)
  );

  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    await db.transaction().execute(async (tx) => {
      for (const stmt of splitStatements(m.sql)) {
        await sql.raw(stmt).execute(tx);
      }
      await tx
        .insertInto('_migrations')
        .values({ id: m.id, name: m.name, applied_at: Date.now() })
        .execute();
    });
  }
}

/**
 * Split a SQL blob on top-level semicolons. Doesn't try to be a full SQL
 * lexer — it's enough for our hand-written DDL which has no embedded
 * literals containing semicolons. Comments are preserved (drivers accept
 * leading whitespace/comments on a statement).
 */
function splitStatements(sqlBlob: string): string[] {
  return sqlBlob
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
