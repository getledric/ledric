export interface FieldCommon {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  indexed?: boolean;
  /** When true, the field accepts per-locale overrides via content._locale[locale][field]. */
  localized?: boolean;
  /**
   * Value to fill in when content omits this field (or sets it to null).
   * Applied at write time, baked into stored content. The value's runtime
   * type must match the field's `type` (validated at defineType).
   */
  default?: unknown;
  /**
   * When true, the field is excluded from `read` / `find` responses by
   * default. Pass `include_private: true` (admin role only over HTTP) to
   * see it. Useful for internal notes, audit metadata, draft scratchpads,
   * etc. that shouldn't leak to public consumer sites. v1 enforcement is
   * top-level only — `private` on nested object/array fields is accepted
   * for forward compat but not yet stripped from responses.
   */
  private?: boolean;
}

export interface FieldString extends FieldCommon {
  type: 'string';
  min?: number;
  max?: number;
  pattern?: string;
  /**
   * When true, no two non-deleted entries of this type may have the same
   * value for this field. Enforced at draft / publish; conflicting writes
   * fail with code: 'UNIQUE_VIOLATION'. Cannot be combined with localized:true.
   */
  unique?: boolean;
}

export interface FieldNumber extends FieldCommon {
  type: 'number';
  min?: number;
  max?: number;
  integer?: boolean;
  /** See FieldString.unique. */
  unique?: boolean;
}

export interface FieldBoolean extends FieldCommon {
  type: 'boolean';
}

export interface FieldDate extends FieldCommon {
  type: 'date';
  /** See FieldString.unique. */
  unique?: boolean;
}

export interface FieldSlug extends FieldCommon {
  type: 'slug';
  from?: string;
  on_change?: 'redirect' | 'error' | 'silent';
}

export interface FieldMarkdown extends FieldCommon {
  type: 'markdown';
  html?: 'allow' | 'sanitize' | 'forbid';
  max?: number;
}

export interface FieldAsset extends FieldCommon {
  type: 'asset';
  /** High-level kinds whitelist: e.g. ['image'], ['image', 'video']. */
  kinds?: readonly string[];
  /** When true, the field stores an array of asset ids instead of one. */
  multiple?: boolean;
  /**
   * Concrete MIME types to allow — finer-grained than `kinds`. e.g.
   * ['image/jpeg', 'image/png'] to disallow GIF/WebP. Empty array is
   * not allowed; omit the key to leave it open.
   */
  mime_types?: readonly string[];
  /** Maximum byte size of the referenced asset's source bytes. */
  max_size_bytes?: number;
  /** Image dimension bounds, applied when the asset's meta carries width/height. */
  min_width?: number;
  max_width?: number;
  min_height?: number;
  max_height?: number;
  /**
   * Required aspect ratio in "W:H" form (e.g. "16:9"). The check passes
   * if abs(width/height − W/H) < 0.005 — accommodates one-pixel rounding.
   */
  aspect_ratio?: string;
}

export interface FieldReferences extends FieldCommon {
  type: 'references';
  to: readonly string[];
  min?: number;
  max?: number;
  pinning?: 'auto' | 'manual' | 'forbidden';
}

export interface FieldArray extends FieldCommon {
  type: 'array';
  of: FieldDef;
  min?: number;
  max?: number;
}

export interface FieldVector extends FieldCommon {
  type: 'vector';
  dims: number;
  byo?: boolean;
}

export interface FieldEnum extends FieldCommon {
  type: 'enum';
  values: readonly string[];
}

export interface FieldObject extends FieldCommon {
  type: 'object';
  /** Nested fields with the same shape rules as the top level. */
  fields: Record<string, FieldDef>;
  /** When true, unknown nested keys raise a validation error. Default: true. */
  strict?: boolean;
}

/**
 * JSS — CSS-in-JS object stored as JSON. Top-level keys are CSS selectors
 * (`.hero`, `.hero h1`), values are rule objects whose entries are either
 * CSS properties (string/number values) or nested at-rules / pseudo-state
 * blocks (object values: `&:hover`, `@media (min-width: 768px)`).
 *
 * `@apply: "text-2xl hover:text-3xl"` is permitted as a string property
 * value — Tailwind utility composition is the consumer renderer's job;
 * the CMS stores the string as-is.
 *
 * Shape-only validation: ledric does not know which CSS properties,
 * Tailwind utilities, or design-token vars the consumer has registered.
 */
export interface FieldJss extends FieldCommon {
  type: 'jss';
}

/**
 * Raw CSS source. Stored as a string. Consumer scopes/applies it at
 * render time (e.g. via a `<style>` block on the rendered block).
 */
export interface FieldCss extends FieldCommon {
  type: 'css';
  max?: number;
}

export type FieldDef =
  | FieldString
  | FieldNumber
  | FieldBoolean
  | FieldDate
  | FieldSlug
  | FieldMarkdown
  | FieldAsset
  | FieldReferences
  | FieldArray
  | FieldVector
  | FieldEnum
  | FieldObject
  | FieldJss
  | FieldCss;

/** The complete set of valid field type discriminators. Useful for validation. */
export const FIELD_TYPES = [
  'string',
  'number',
  'boolean',
  'date',
  'slug',
  'markdown',
  'asset',
  'references',
  'array',
  'vector',
  'enum',
  'object',
  'jss',
  'css'
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

export interface TypeDefOptions {
  description?: string;
  identifier_field?: string;
  display_field?: string;
  summary_fields?: readonly string[];
  on_slug_change?: 'redirect' | 'error' | 'silent';
  example?: Record<string, unknown>;
  /**
   * Allowed locale codes for this type. When set, content may carry a
   * top-level `_locale` map keyed by locale name. Required to use any
   * `localized: true` fields.
   */
  locales?: readonly string[];
  /** Locale to treat as canonical / source of truth. Defaults to locales[0]. */
  default_locale?: string;
  /**
   * Per-locale fallback chain. When a localized field is missing for the
   * requested locale, walk these locales in order, finally falling back to
   * the default-locale value at the top level.
   */
  fallback?: Readonly<Record<string, string>>;
}

export interface TypeDef extends TypeDefOptions {
  name: string;
  fields: Record<string, FieldDef>;
}
