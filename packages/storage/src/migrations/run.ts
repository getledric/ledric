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
// Split a multi-statement SQL blob on top-level semicolons. Aware of:
//   line comments  (-- ... terminated by newline)
//   block comments (slash-star ... star-slash, no nesting)
//   single-quoted string literals (with '' as the embedded-quote escape)
// A ';' inside any of those is part of the literal/comment, not a
// statement separator. Trailing whitespace and comment-only chunks
// are stripped so we never hand sqlite an empty statement.
function splitStatements(sqlBlob: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sqlBlob.length;
  while (i < n) {
    const c = sqlBlob[i]!;
    const next = i + 1 < n ? sqlBlob[i + 1] : '';

    if (c === '-' && next === '-') {
      // line comment: consume through end-of-line (keep in buf so the
      // statement chunk still has it for readability when surfacing
      // errors; sqlite tolerates leading comments)
      const eol = sqlBlob.indexOf('\n', i);
      const end = eol === -1 ? n : eol + 1;
      buf += sqlBlob.slice(i, end);
      i = end;
      continue;
    }
    if (c === '/' && next === '*') {
      const close = sqlBlob.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      buf += sqlBlob.slice(i, end);
      i = end;
      continue;
    }
    if (c === "'") {
      // single-quoted literal; '' is the escape for an embedded quote.
      buf += c;
      i += 1;
      while (i < n) {
        const ch = sqlBlob[i]!;
        buf += ch;
        if (ch === "'") {
          if (sqlBlob[i + 1] === "'") {
            buf += sqlBlob[i + 1];
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (c === ';') {
      const stripped = stripComments(buf).trim();
      if (stripped.length > 0) out.push(buf.trim());
      buf = '';
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  const tail = stripComments(buf).trim();
  if (tail.length > 0) out.push(buf.trim());
  return out;
}

// Strip line and block comments from a SQL fragment. Used only to decide
// whether a chunk has any executable content — the version we hand sqlite
// keeps the comments intact so stack traces stay legible.
function stripComments(s: string): string {
  return s
    .replace(/--[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}
