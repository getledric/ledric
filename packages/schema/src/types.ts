export interface FieldCommon {
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  indexed?: boolean;
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
}

export interface TypeDef extends TypeDefOptions {
  name: string;
  fields: Record<string, FieldDef>;
}
