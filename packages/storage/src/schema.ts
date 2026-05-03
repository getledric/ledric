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

// OAuth provider tables. Populated only when mcp.public is on; sit
// empty otherwise. See packages/oauth/ for the business logic on top
// of these.

export interface OAuthClientsTable {
  id: Buffer;
  env_id: Buffer;
  /** Public client_id string — the value advertised to OAuth clients. */
  client_id: string;
  /** SHA-256 of the client_secret. Null for public PKCE-only clients. */
  secret_hash: Buffer | null;
  /** DCR-supplied display name. UNTRUSTED — show client_id alongside on UIs. */
  name: string;
  /** JSON array of pre-registered redirect URIs. Stringified at write. */
  redirect_uris: string;
  created_at: number;
  revoked_at: number | null;
}

export interface OAuthCodesTable {
  /** SHA-256 of the auth code. The plaintext is never stored. */
  code_hash: Buffer;
  env_id: Buffer;
  client_id: string;
  redirect_uri: string;
  /** PKCE S256 code_challenge (base64url, no padding). */
  code_challenge: string;
  /** Space-separated scope list. */
  scope: string;
  expires_at: number;
  /** Set when the code is exchanged for a token; second use is rejected. */
  consumed_at: number | null;
}

export interface OAuthRefreshTokensTable {
  /** SHA-256 of the refresh token. The plaintext is never stored. */
  token_hash: Buffer;
  env_id: Buffer;
  client_id: string;
  scope: string;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  /** Hash of the refresh token this one rotated from, for lineage tracing. */
  parent_token_hash: Buffer | null;
}

export interface OAuthKeysTable {
  /** Primary key — one row per env. */
  env_id: Buffer;
  /** Private signing key as a JWK (Ed25519). JSON-stringified. */
  private_jwk: string;
  /** Public verification key as a JWK. JSON-stringified. */
  public_jwk: string;
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
  oauth_clients: OAuthClientsTable;
  oauth_codes: OAuthCodesTable;
  oauth_refresh_tokens: OAuthRefreshTokensTable;
  oauth_keys: OAuthKeysTable;
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
