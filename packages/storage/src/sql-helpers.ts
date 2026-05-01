import { sql, type RawBuilder, type Expression } from 'kysely';
import type { Dialect } from './migrations/run.js';

// Cross-dialect SQL bits that Kysely's query builder doesn't abstract.
// Kept here so the storage class doesn't need a dialect-conditional in
// every query.

/**
 * Extract a JSON property as text. Used to filter/order by a field
 * inside the JSON-encoded `entry_versions.content`.
 *
 * SQLite:    json_extract(col, '$.field')
 * MySQL:     JSON_UNQUOTE(JSON_EXTRACT(col, '$.field'))
 * Postgres:  col::jsonb ->> 'field'
 *
 * `path` is a single top-level field name. We don't currently support
 * nested paths, and validating the field name keeps SQL injection
 * surface zero — see the regex below.
 */
export function jsonExtractText(
  dialect: Dialect,
  column: Expression<unknown>,
  field: string
): RawBuilder<string | null> {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new Error(`jsonExtractText: invalid field name "${field}"`);
  }
  switch (dialect) {
    case 'sqlite':
      return sql<string | null>`json_extract(${column}, ${'$.' + field})`;
    case 'mysql':
      return sql<string | null>`JSON_UNQUOTE(JSON_EXTRACT(${column}, ${'$.' + field}))`;
    case 'postgres':
      return sql<string | null>`(${column})::jsonb ->> ${field}`;
  }
}

/**
 * Case-insensitive ORDER BY expression. SQLite supports `COLLATE NOCASE`
 * but other dialects don't, so we standardize on `LOWER(col)` which is
 * universal.
 */
export function caseInsensitive(column: Expression<unknown>): RawBuilder<string> {
  return sql<string>`LOWER(${column})`;
}
