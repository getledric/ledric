import type { Selectable } from 'kysely';

// Kysely table definitions for the ledric storage schema. The same shape
// works against SQLite, MySQL, and Postgres — what changes per-dialect is
// only the DDL in `src/migrations/<dialect>.ts` and a few function names
// (`json_extract` vs `JSON_EXTRACT` vs `->`), which are isolated in
// `src/sql-helpers.ts`.
//
// BLOB columns surface as `Buffer` because that's what every supported
// driver returns. Storage methods coerce to `Uint8Array` at the boundary
// for the public API.

export interface EnvsTable {
  id: Buffer;
  name: string;
  parent_id: Buffer | null;
  created_at: number;
}

export interface TypesTable {
  id: Buffer;
  env_id: Buffer;
  name: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface TypeVersionsTable {
  type_id: Buffer;
  version: number;
  definition: string;
  change_class: 'safe' | 'needs_backfill' | 'destructive';
  parent_version: number | null;
  author: string | null;
  created_at: number;
}

export interface EntriesTable {
  id: Buffer;
  env_id: Buffer;
  type_id: Buffer;
  slug: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface EntryVersionsTable {
  entry_id: Buffer;
  version: number;
  content: string;
  schema_version: number;
  content_hash: Buffer;
  parent_version: number | null;
  author: string | null;
  created_at: number;
}

export interface SlugHistoryTable {
  env_id: Buffer;
  slug: string;
  type_id: Buffer;
  entry_id: Buffer;
  retired_at: number;
  locale: string | null;
}

export interface EntriesSlugsTable {
  env_id: Buffer;
  type_id: Buffer;
  locale: string;
  slug: string;
  entry_id: Buffer;
}

export interface AssetsTable {
  id: Buffer;
  env_id: Buffer;
  kind: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface AssetVersionsTable {
  asset_id: Buffer;
  version: number;
  storage_ref: string;
  meta: string;
  parent_version: number | null;
  author: string | null;
  created_at: number;
  ref_key: Buffer;
}

export interface AssetBlobsTable {
  asset_id: Buffer;
  version: number;
  bytes: Buffer;
}

export interface ApiKeysTable {
  id: Buffer;
  env_id: Buffer;
  role: 'admin' | 'reader';
  label: string | null;
  key_hash: Buffer;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

/**
 * Single payload table for `oidc-provider`'s adapter interface. One
 * row per (model, id) covers all of the library's models — clients,
 * AuthorizationCode, AccessToken, RefreshToken, Grant, Interaction,
 * Session, Keys, ReplayDetection, etc. Populated only when
 * `mcp.public` is on. See `packages/oauth/src/adapter.ts` for the
 * adapter wiring this table to the library's expected shape.
 */
export interface OidcPayloadsTable {
  model: string;
  id: string;
  /** JSON-stringified `AdapterPayload` from oidc-provider. */
  payload: string;
  /** Set on AccessToken / RefreshToken / AuthorizationCode for revoke-by-grant. */
  grant_id: string | null;
  /** DeviceCode user_code lookup (we don't enable device flow but the column exists). */
  user_code: string | null;
  /** Session uid lookup. */
  uid: string | null;
  /**
   * Unix-seconds. Null for Client rows — oidc-provider doesn't pass
   * an `expiresIn` for those. The adapter's hydrate path treats null
   * as "no expiry" (the row is always live until destroy).
   */
  expires_at: number | null;
  /** Set on AuthorizationCode consume to enforce single-use. */
  consumed_at: number | null;
}

/**
 * Persistent OAuth signing keys. Without these, oidc-provider falls
 * back to dev-mode auto-keys at boot — restarting `serve` would
 * silently invalidate every issued JWT (claude.ai connectors lose
 * their connection). One row per active key; multi-row layout is
 * for future rotation.
 */
export interface OidcSigningKeysTable {
  kid: string;
  /** JSON-stringified private JWK. */
  jwk: string;
  alg: string;
  /** Unix milliseconds. */
  created_at: number;
}

export interface TagsTable {
  id: Buffer;
  env_id: Buffer;
  slug: string;
  label: string;
  created_at: number;
}

export interface AssetTagsTable {
  env_id: Buffer;
  asset_id: Buffer;
  tag_id: Buffer;
}

export interface EntryTagsTable {
  env_id: Buffer;
  entry_id: Buffer;
  tag_id: Buffer;
}

export interface MigrationsTable {
  id: number;
  name: string;
  applied_at: number;
}

/**
 * Full-text search index. Populated for entry fields opted in via the
 * `searchable: true` schema option. One row per (entry, field, locale).
 *
 * Shape is identical across SQLite (FTS5 virtual table), Postgres
 * (regular table + generated tsvector + GIN), and MySQL (table +
 * FULLTEXT). Only the underlying index mechanism differs; the dialect-
 * specific WHERE clause is built ad-hoc per query in storage.ts.
 *
 * `locale` uses the empty string '' as "no specific locale" sentinel
 * (default-locale row plus every row of a non-localized field). Postgres
 * won't allow NULL in a primary key column, so the sentinel keeps the
 * write logic uniform across all three dialects.
 */
export interface FtsEntriesTable {
  entry_id: Buffer;
  type: string;
  field_name: string;
  locale: string;
  value: string;
}

export interface Database {
  envs: EnvsTable;
  types: TypesTable;
  type_versions: TypeVersionsTable;
  entries: EntriesTable;
  entry_versions: EntryVersionsTable;
  slug_history: SlugHistoryTable;
  entries_slugs: EntriesSlugsTable;
  assets: AssetsTable;
  asset_versions: AssetVersionsTable;
  asset_blobs: AssetBlobsTable;
  api_keys: ApiKeysTable;
  oidc_payloads: OidcPayloadsTable;
  oidc_signing_keys: OidcSigningKeysTable;
  tags: TagsTable;
  asset_tags: AssetTagsTable;
  entry_tags: EntryTagsTable;
  fts_entries: FtsEntriesTable;
  _migrations: MigrationsTable;
}

// Convenience exports — not used internally yet, but handy for adapters.
export type EnvRow = Selectable<EnvsTable>;
export type TypeRow = Selectable<TypesTable>;
export type EntryRow = Selectable<EntriesTable>;
export type AssetRow = Selectable<AssetsTable>;
