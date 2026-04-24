export const PACKAGE_NAME = '@ledric/core';

export { Core, ValidationFailedError } from './core.js';
export type {
  Capabilities,
  DescribeModelResult,
  TypeDescription,
  CreateTypeInput,
  DraftInput,
  DraftResult,
  ReadInput,
  PublishInput,
  PublishResult
} from './core.js';
export { normalizeTypeDef, normalizeField } from './normalize.js';
export { validateContent } from './validate.js';
export type { ValidationError, ValidationResult } from './validate.js';
export { deriveContent, slugify } from './derive.js';
