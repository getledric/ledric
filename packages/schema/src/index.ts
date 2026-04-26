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
