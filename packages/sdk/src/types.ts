// SDK-side wire types. Independent of @ledric/core internals so the SDK
// has zero monorepo coupling and can be published / consumed standalone.

/**
 * Augmentation seam for `ledric types --augment-sdk`. The generated
 * `ledric.types.ts` extends this interface with one key per content
 * type, so consumer code that imports the generated file gets full
 * type-safety on `client.read<'blog_post'>('hello')` etc. without us
 * shipping schema-aware code in the SDK itself.
 *
 * Empty by default — consumers who don't run codegen pass an explicit
 * field-shape generic instead.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface LedricEntries {}

export interface ResolvedRef {
  to: string;
  found: boolean;
  id?: string;
  type?: string;
  slug?: string;
  display?: string;
  url?: string;
  locale?: string;
  version?: number;
}

export interface ValidationWarning {
  path: string;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export interface Entry<F = Record<string, unknown>> {
  id: string;
  type: string;
  slug: string;
  version: number;
  locale?: string;
  fields: F;
  _redirect?: { from: string; to: string; locale?: string };
  _refs?: ResolvedRef[];
  _warnings?: ValidationWarning[];
  tags?: TagInfo[];
}

export interface EntrySummary<F = Record<string, unknown>> {
  id: string;
  type: string;
  slug: string;
  version: number;
  published_version: number | null;
  fields: F;
  _refs?: ResolvedRef[];
  tags?: TagInfo[];
}

export interface FindResult<F = Record<string, unknown>> {
  total: number;
  offset: number;
  results: EntrySummary<F>[];
}

export interface FieldDef {
  type: string;
  required?: boolean;
  description?: string;
  [k: string]: unknown;
}

export interface TypeDescription {
  name: string;
  description?: string;
  identifier_field?: string;
  display_field?: string;
  summary_fields?: string[];
  on_slug_change?: 'redirect' | 'error' | 'silent';
  example?: Record<string, unknown>;
  fields: Record<string, FieldDef>;
  version: number;
}

export interface Capabilities {
  vectorSearch: boolean;
  nativePubSub: boolean;
  fts: 'fts5' | 'tsvector';
  /**
   * Server supports imgix-style URL transforms on /assets/<ref_key>.
   * Object form carries the param catalogue + a worked example.
   */
  imageTransforms?: ImageTransformsCapability;
  /** Server enforces structural ref validation (warn on draft, error on publish). */
  refValidation?: boolean;
  /** Field type discriminators understood by this server. */
  fieldTypes?: readonly string[];
  /**
   * Per-discriminator catalogue of required/optional keys + a complete
   * example. Lets callers build new field defs without trial-and-error.
   */
  fieldTypeSpecs?: Record<string, FieldTypeSpec>;
  /**
   * URL of the HTTP API on this ledric process, when one is running
   * alongside the MCP server (i.e. `serve --http` / `serve --gui`).
   * Absent when only MCP stdio is on.
   */
  http_base?: string;
  /** Plain-language guidance for agents wiring up consumer sites. */
  consumer_guidance?: string;
  /** HTTP auth posture. Absent in pure-stdio MCP mode. */
  auth?: AuthCapability;
}

export interface ImageTransformsCapability {
  enabled: true;
  params: Record<string, string>;
  example: string;
}

export interface AuthCapability {
  read: 'open' | 'reader';
  write: 'admin';
  keys: readonly ('admin' | 'reader')[];
  header: string;
}

export interface FieldTypeSpec {
  description: string;
  required: readonly string[];
  optional: readonly string[];
  example: Record<string, unknown>;
  /**
   * Per-field-type wire-shape advertisement. Present only on field
   * types where the input and output shapes diverge or are non-obvious.
   */
  wire_shape?: WireShape;
}

export interface WireShape {
  input: string;
  input_example: unknown;
  output: string;
  output_example_resolved?: unknown;
  notes?: string;
}

export interface Conventions {
  name_pattern: string;
  reserved_content_keys: readonly string[];
  notes: string;
}

export interface DescribeModel {
  schema_version: number;
  types: Record<string, TypeDescription>;
  capabilities: Capabilities;
  conventions?: Conventions;
}

export interface AssetMeta {
  mime?: string;
  size?: number;
  alt?: string;
  dims?: { w: number; h: number };
  [k: string]: unknown;
}

export interface TagInfo {
  /** Canonical, lowercased, URL-safe form. The stable identity. */
  slug: string;
  /** Display form, case preserved. */
  label: string;
}

export interface TagWithCounts extends TagInfo {
  asset_uses: number;
  entry_uses: number;
}

export interface Asset {
  /** Stable asset id — what entry content references. Doesn't change across versions. */
  id: string;
  /** Per-version opaque key. URL-bearing. Different per version. */
  ref_key: string;
  kind: string;
  version: number;
  current_version: number;
  published_version: number | null;
  storage_ref: string;
  meta: AssetMeta;
  /** Canonical URL — uses ref_key, version-pinned, safe to long-cache. */
  url: string;
  /** Tags currently applied to this asset, sorted by label asc. */
  tags?: TagInfo[];
}

export interface AssetSummary {
  id: string;
  ref_key: string;
  kind: string;
  version: number;
  storage_ref: string;
  meta: AssetMeta;
  url: string;
  tags?: TagInfo[];
}

export interface ListAssetsResult {
  total: number;
  offset: number;
  results: AssetSummary[];
}

export type EntryRef = string | { type: string; slug: string };

export interface FindOptions {
  /** Filter to entries that have ALL of these tags (matched by slug). */
  tags?: string[];
  limit?: number;
  offset?: number;
  locale?: string;
  /** Resolve asset-typed fields. true expands all; string[] picks specific. */
  expandAssets?: boolean | string[];
  /** Walk markdown fields for :::ref{} directives, attach _refs sidecar to each result. */
  resolveRefs?: boolean;
  /**
   * Restrict to currently-published entries. Drafts are filtered out and
   * each result projects from its published version (not the head).
   * The natural default for SSG / SSR consumers.
   */
  published?: boolean;
  /**
   * Project each result's `fields` to only the type's declared
   * `summary_fields`. Reserved sidecars (`_locale`, `_refs`) pass
   * through unchanged. Saves payload size for list views that don't
   * need the full body.
   */
  summary?: boolean;
}

export interface ListAssetsOptions {
  kind?: string;
  /** Filter to assets that have ALL of these tags. */
  tags?: string[];
  limit?: number;
  offset?: number;
}

/**
 * imgix-style image transform parameters. The server applies them at
 * request time against the source asset; nothing about the transform
 * is persisted into entry content.
 */
export interface AssetTransformOptions {
  /** Source-pixel width (multiplied by `dpr`). Capped server-side at 4096. */
  w?: number;
  /** Source-pixel height (multiplied by `dpr`). Capped server-side at 4096. */
  h?: number;
  /**
   * `clip` (default) preserves aspect inside the box; `crop` fills the
   * box and may crop. `cover` and `contain` are accepted aliases.
   */
  fit?: 'clip' | 'crop' | 'cover' | 'contain';
  /** Output quality (1-100), used for jpg/webp/avif. Default 80. */
  q?: number;
  /** Force output format. */
  fm?: 'jpg' | 'jpeg' | 'png' | 'webp' | 'avif';
  /** `'format'` makes the server pick the best format from Accept. */
  auto?: 'format';
  /** Pixel-density multiplier applied to w/h. 1..4 server-side. */
  dpr?: number;
  /** Pin a specific asset version. */
  version?: number;
}

export interface ReadOptions {
  version?: number;
  locale?: string;
  /** Resolve asset-typed fields. true expands all; string[] picks specific. */
  expandAssets?: boolean | string[];
  /** Walk markdown fields for :::ref{} directives, attach _refs sidecar. */
  resolveRefs?: boolean;
}
