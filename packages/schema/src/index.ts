export const PACKAGE_NAME = '@ledric/schema';

export type {
  FieldCommon,
  FieldString,
  FieldNumber,
  FieldBoolean,
  FieldDate,
  FieldSlug,
  FieldMarkdown,
  FieldAsset,
  FieldReferences,
  FieldArray,
  FieldVector,
  FieldEnum,
  FieldObject,
  FieldDef,
  FieldType,
  TypeDef,
  TypeDefOptions
} from './types.js';
export { FIELD_TYPES } from './types.js';

export { field } from './field.js';
export { defineType } from './define-type.js';
export { FIELD_TYPE_SPECS } from './field-specs.js';
export type { FieldTypeSpec } from './field-specs.js';

/** Identifier shape for type and field names. Leading underscore is reserved. */
export const NAME_PATTERN = '^[a-z][a-z0-9_]*$';

/**
 * Top-level keys in entry content that ledric reserves for sidecars.
 * These must not be used as field names. Names starting with `_` are
 * always reserved for forward compatibility — keep field names away
 * from the underscore prefix entirely.
 */
export const RESERVED_CONTENT_KEYS = [
  '_locale',
  '_redirect',
  '_refs',
  '_warnings'
] as const;
