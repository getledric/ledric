export const PACKAGE_NAME = '@ledric/core';

export { Core, ValidationFailedError } from './core.js';
export type {
  Capabilities,
  DescribeModelResult,
  TypeDescription,
  CreateTypeInput,
  AlterTypeInput,
  AlterTypeResult,
  DraftInput,
  DraftResult,
  ReadInput,
  PublishInput,
  PublishResult,
  MigrateEntriesInput,
  MigrateEntriesResult,
  MigrateFailure
} from './core.js';
export { normalizeTypeDef, normalizeField } from './normalize.js';
export { validateContent } from './validate.js';
export type { ValidationError, ValidationResult } from './validate.js';
export { deriveContent, slugify } from './derive.js';
export { classifyChange } from './classify.js';
export type { TypeDiff, FieldDiff } from './classify.js';
export { applyMergePatch } from './merge-patch.js';
