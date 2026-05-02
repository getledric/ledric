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

/** ---------- Tags ---------- */

export interface TagInfo {
  /** Canonical, lowercased, URL-safe form. The stable identity. */
  slug: string;
  /** Display form, case preserved. */
  label: string;
}

export interface TagWithCounts extends TagInfo {
  /** Number of non-deleted assets currently using this tag. */
  asset_uses: number;
  /** Number of non-deleted entries currently using this tag. */
  entry_uses: number;
}

export interface CreateEntryInput {
  type: string;
  slug: string;
  content: Record<string, unknown>;
  schema_version: number;
  author?: string;
  /** Non-default-locale slug overrides ({ "fr": "bonjour-le-monde", … }). */
  locale_slugs?: Record<string, string>;
  /** Initial tags. Free-form strings; normalized server-side. */
  tags?: readonly string[];
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
  /** Sorted by label, ascending. Empty array when untagged. */
  tags: TagInfo[];
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
  /** Sorted by label, ascending. Empty array when untagged. */
  tags: TagInfo[];
}

export interface FindEntriesInput {
  type: string;
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  includeDeleted?: boolean;
  /** Filter to entries that have ALL of these tags (matched by slug). */
  tags?: readonly string[];
  /**
   * Full-text search query. When set, results are restricted to entries
   * matching the query across their searchable:true fields and ordered
   * by relevance rank (overriding `order` unless `order` is supplied
   * explicitly).
   */
  q?: string;
  /**
   * Locale to scope FTS matches to. When set with `q`, only matches in
   * that locale's row plus rows with locale='' (non-localized fields)
   * count. When omitted, all locales contribute.
   */
  locale?: string;
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
  /** Initial tags. Free-form strings; normalized server-side. */
  tags?: readonly string[];
}

/**
 * Replace the bytes (and optionally meta) of an existing asset, bumping
 * its current_version. The asset id stays put — entry content keeps
 * resolving — but the new version row gets its own ref_key, so URLs
 * built from `expand_assets` change automatically and cache safely.
 */
export interface UpdateAssetInput {
  id: Uint8Array;
  parent_version: number;
  bytes: Uint8Array;
  /** When provided, replaces the meta on the new version (does not merge). */
  meta?: AssetMeta;
  author?: string;
}

export interface AssetWrite {
  id: Uint8Array;
  version: number;
  kind: string;
  storage_ref: string;
  meta: AssetMeta;
  /** 16-byte opaque key for the URL of this specific version. */
  ref_key: Uint8Array;
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
  /** ref_key of the current version — used to build cache-stable URLs. */
  ref_key: Uint8Array;
  /** Sorted by label, ascending. Empty array when untagged. */
  tags: TagInfo[];
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
  /** Filter to assets that have ALL of these tags (matched by slug). */
  tags?: readonly string[];
}

export interface ListAssetsResult {
  results: AssetSummary[];
  total: number;
  offset: number;
}

/** ---------- Soft-delete ---------- */

export interface DeleteTypeInput {
  name: string;
  parent_version: number;
  /**
   * When true, every non-deleted entry of this type is soft-deleted in
   * the same transaction. When false (default), the operation throws
   * TypeNotEmptyError if any entries remain.
   */
  cascade?: boolean;
}

export interface DeleteTypeResult {
  name: string;
  deleted_at: number;
  /** Count of entries that were cascade-deleted alongside the type. */
  entries_deleted: number;
}

export interface DeleteEntryInput {
  ref: EntryRef;
  parent_version: number;
}

export interface DeleteEntryResult {
  id: Uint8Array;
  type: string;
  slug: string;
  deleted_at: number;
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
  /** Replace the bytes of an existing asset; mints a new ref_key. */
  updateAsset(input: UpdateAssetInput): Promise<AssetWrite>;
  getAsset(id: Uint8Array, opts?: { version?: number }): Promise<AssetDetail | null>;
  /** Look up an asset version by its opaque ref_key (the URL key). Returns null on miss. */
  findAssetByRefKey(ref_key: Uint8Array): Promise<AssetDetail | null>;
  listAssets(input?: ListAssetsInput): Promise<ListAssetsResult>;
  readAssetBytes(id: Uint8Array, opts?: { version?: number }): Promise<Buffer>;

  createEntry(input: CreateEntryInput): Promise<EntryWrite>;
  updateEntry(input: UpdateEntryInput): Promise<EntryWrite>;
  readEntry(ref: EntryRef, opts?: { version?: number; locale?: string }): Promise<EntryDetail | null>;
  findEntries(input: FindEntriesInput): Promise<FindEntriesResult>;
  publishEntry(input: PublishEntryInput): Promise<EntryWrite>;
  renameEntry(input: RenameEntryInput): Promise<RenameEntryResult>;
  /** Soft-delete a type. With cascade, also soft-deletes all its entries. */
  deleteType(input: DeleteTypeInput): Promise<DeleteTypeResult>;
  /** Soft-delete an entry. Reads stop seeing it; storage row stays. */
  deleteEntry(input: DeleteEntryInput): Promise<DeleteEntryResult>;

  /**
   * Tag operations. Inputs are free-form strings; the storage layer
   * normalizes (`#Featured Event`, `featured event`, `FEATURED EVENT`
   * all collapse to slug `featured-event`). Adding an unknown tag for
   * the first time creates the row in `tags` with the caller's
   * preserved-case label; later writes match by slug and inherit the
   * existing label.
   */
  addAssetTags(assetId: Uint8Array, inputs: readonly string[]): Promise<TagInfo[]>;
  removeAssetTags(assetId: Uint8Array, inputs: readonly string[]): Promise<number>;
  getAssetTags(assetId: Uint8Array): Promise<TagInfo[]>;
  addEntryTags(entryId: Uint8Array, inputs: readonly string[]): Promise<TagInfo[]>;
  removeEntryTags(entryId: Uint8Array, inputs: readonly string[]): Promise<number>;
  getEntryTags(entryId: Uint8Array): Promise<TagInfo[]>;
  /** Every tag in the env, ordered by total uses desc, then label asc. */
  listTags(): Promise<TagWithCounts[]>;
  /** Relabel an existing tag. Slug is the stable identity and never changes. */
  updateTag(slug: string, label: string): Promise<TagInfo | null>;

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
