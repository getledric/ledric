// SDK-side wire types. Independent of @ledric/core internals so the SDK
// has zero monorepo coupling and can be published / consumed standalone.

export interface Entry<F = Record<string, unknown>> {
  id: string;
  type: string;
  slug: string;
  version: number;
  locale?: string;
  fields: F;
  _redirect?: { from: string; to: string; locale?: string };
}

export interface EntrySummary<F = Record<string, unknown>> {
  id: string;
  type: string;
  slug: string;
  version: number;
  published_version: number | null;
  fields: F;
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
}

export interface DescribeModel {
  schema_version: number;
  types: Record<string, TypeDescription>;
  capabilities: Capabilities;
}

export interface AssetMeta {
  mime?: string;
  size?: number;
  alt?: string;
  dims?: { w: number; h: number };
  [k: string]: unknown;
}

export interface Asset {
  id: string;
  kind: string;
  version: number;
  current_version: number;
  published_version: number | null;
  storage_ref: string;
  meta: AssetMeta;
  url: string;
}

export interface AssetSummary {
  id: string;
  kind: string;
  version: number;
  storage_ref: string;
  meta: AssetMeta;
  url: string;
}

export interface ListAssetsResult {
  total: number;
  offset: number;
  results: AssetSummary[];
}

export type EntryRef = string | { type: string; slug: string };

export interface FindOptions {
  limit?: number;
  offset?: number;
  locale?: string;
  /** Resolve asset-typed fields. true expands all; string[] picks specific. */
  expandAssets?: boolean | string[];
}

export interface ListAssetsOptions {
  kind?: string;
  limit?: number;
  offset?: number;
}

export interface ReadOptions {
  version?: number;
  locale?: string;
  /** Resolve asset-typed fields. true expands all; string[] picks specific. */
  expandAssets?: boolean | string[];
}
