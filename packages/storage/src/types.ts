import type { TypeDef } from '@ledric/schema';

export type ChangeClass = 'safe' | 'needs_backfill' | 'destructive';

export interface TypeSummary {
  id: Uint8Array;
  name: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface TypeDetail extends TypeSummary {
  definition: TypeDef;
  schema_version: number;
}

export interface CreateTypeInput {
  definition: TypeDef;
  author?: string;
}

export interface CreateTypeResult {
  id: Uint8Array;
  name: string;
  version: number;
}

export interface AlterTypeInput {
  name: string;
  parent_version: number;
  definition: TypeDef;
  change_class: ChangeClass;
  author?: string;
}

export interface AlterTypeResult {
  id: Uint8Array;
  name: string;
  version: number;
  change_class: ChangeClass;
}

export interface CreateEntryInput {
  type: string;
  slug: string;
  content: Record<string, unknown>;
  schema_version: number;
  author?: string;
  /** Non-default-locale slug overrides ({ "fr": "bonjour-le-monde", … }). */
  locale_slugs?: Record<string, string>;
}

export interface UpdateEntryInput {
  ref: EntryRef;
  content: Record<string, unknown>;
  parent_version: number;
  schema_version: number;
  author?: string;
  /** Replaces the entry's set of non-default-locale slugs. */
  locale_slugs?: Record<string, string>;
}

export interface PublishEntryInput {
  ref: EntryRef;
  version?: number;
}

export interface EntryRef {
  type: string;
  slug: string;
}

export interface EntryWrite {
  id: Uint8Array;
  type: string;
  slug: string;
  version: number;
}

export interface EntryDetail {
  id: Uint8Array;
  type: string;
  slug: string;
  version: number;
  current_version: number;
  published_version: number | null;
  schema_version: number;
  content: Record<string, unknown>;
  content_hash: Uint8Array;
  created_at: number;
  deleted_at: number | null;
  _redirect?: { from: string; to: string; locale?: string };
  _refs?: ReadonlyArray<{
    to: string;
    found: boolean;
    id?: string;
    type?: string;
    slug?: string;
    display?: string;
    url?: string;
    locale?: string;
    version?: number;
  }>;
  _warnings?: ReadonlyArray<{
    path: string;
    code: string;
    message: string;
    expected?: unknown;
    actual?: unknown;
  }>;
}

export interface RenameEntryInput {
  ref: EntryRef;
  new_slug: string;
  /** When set, renames the slug for this non-default locale only. */
  locale?: string;
}

export interface RenameEntryResult {
  id: Uint8Array;
  type: string;
  old_slug: string;
  new_slug: string;
  locale: string | null;
  retired_at: number;
}

export interface EntrySummary {
  id: Uint8Array;
  type: string;
  slug: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface FindEntriesInput {
  type: string;
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  includeDeleted?: boolean;
}

export interface FindEntriesResult {
  results: EntryDetail[];
  total: number;
  offset: number;
}

// -------- Assets --------

export interface AssetMeta {
  mime?: string;
  size?: number;
  alt?: string;
  dims?: { w: number; h: number };
  [k: string]: unknown;
}

export interface CreateAssetInput {
  kind: string;
  bytes: Uint8Array;
  meta?: AssetMeta;
  author?: string;
}

export interface AssetWrite {
  id: Uint8Array;
  version: number;
  kind: string;
  storage_ref: string;
  meta: AssetMeta;
}

export interface AssetSummary {
  id: Uint8Array;
  kind: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
  storage_ref: string;
  meta: AssetMeta;
  created_at: number;
}

export interface AssetDetail extends AssetSummary {
  version: number;
  author: string | null;
}

export interface ListAssetsInput {
  kind?: string;
  limit?: number;
  offset?: number;
  includeDeleted?: boolean;
}

export interface ListAssetsResult {
  results: AssetSummary[];
  total: number;
  offset: number;
}

/** ---------- API keys ---------- */

export type ApiKeyRole = 'admin' | 'reader';

export interface CreateApiKeyInput {
  role: ApiKeyRole;
  label?: string;
  key_hash: Uint8Array;
  key_prefix: string;
}

export interface ApiKeyRow {
  id: Uint8Array;
  role: ApiKeyRole;
  label: string | null;
  key_prefix: string;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ApiKeyLookup {
  id: Uint8Array;
  role: ApiKeyRole;
  label: string | null;
  revoked_at: number | null;
}

export interface Storage {
  createType(input: CreateTypeInput): Promise<CreateTypeResult>;
  alterType(input: AlterTypeInput): Promise<AlterTypeResult>;
  listTypes(opts?: { includeDeleted?: boolean }): Promise<TypeSummary[]>;
  getType(name: string): Promise<TypeDetail | null>;

  createAsset(input: CreateAssetInput): Promise<AssetWrite>;
  getAsset(id: Uint8Array, opts?: { version?: number }): Promise<AssetDetail | null>;
  listAssets(input?: ListAssetsInput): Promise<ListAssetsResult>;
  readAssetBytes(id: Uint8Array, opts?: { version?: number }): Promise<Buffer>;

  createEntry(input: CreateEntryInput): Promise<EntryWrite>;
  updateEntry(input: UpdateEntryInput): Promise<EntryWrite>;
  readEntry(ref: EntryRef, opts?: { version?: number; locale?: string }): Promise<EntryDetail | null>;
  findEntries(input: FindEntriesInput): Promise<FindEntriesResult>;
  publishEntry(input: PublishEntryInput): Promise<EntryWrite>;
  renameEntry(input: RenameEntryInput): Promise<RenameEntryResult>;

  /** Create an API key row from a pre-hashed secret. Returns the assigned id + created_at. */
  createApiKey(input: CreateApiKeyInput): Promise<{ id: Uint8Array; created_at: number }>;
  /** Constant-time hash lookup. Returns null on miss. Revoked keys still return so the caller can distinguish "never existed" from "revoked". */
  findApiKeyByHash(hash: Uint8Array): Promise<ApiKeyLookup | null>;
  /** List keys (sorted newest-first). Excludes revoked keys unless `includeRevoked` is set. */
  listApiKeys(opts?: { includeRevoked?: boolean }): Promise<ApiKeyRow[]>;
  /** Mark a key as revoked. Idempotent — returns null if the id doesn't exist. */
  revokeApiKey(id: Uint8Array): Promise<{ revoked_at: number } | null>;
  /** Update last_used_at, debounced internally so we don't write on every request. */
  markApiKeyUsed(id: Uint8Array, at: number): Promise<void>;
  /** Number of non-revoked keys — used to detect "auth disabled" mode. */
  countActiveApiKeys(): Promise<number>;

  close(): Promise<void>;
}
