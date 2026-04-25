export interface FieldCommon {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  indexed?: boolean;
  /** When true, the field accepts per-locale overrides via content._locale[locale][field]. */
  localized?: boolean;
}

export interface FieldString extends FieldCommon {
  type: 'string';
  min?: number;
  max?: number;
  pattern?: string;
}

export interface FieldNumber extends FieldCommon {
  type: 'number';
  min?: number;
  max?: number;
  integer?: boolean;
}

export interface FieldBoolean extends FieldCommon {
  type: 'boolean';
}

export interface FieldDate extends FieldCommon {
  type: 'date';
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
  kinds?: readonly string[];
  multiple?: boolean;
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
  | FieldEnum;

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
