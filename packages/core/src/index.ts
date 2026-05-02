export const PACKAGE_NAME = '@ledric/core';

export { Core, ValidationFailedError, AssetConstraintError } from './core.js';
export type {
  Capabilities,
  CoreOptions,
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
  RenameInput,
  RenameResult,
  DeleteTypeInput,
  DeleteTypeResult,
  DeleteEntryInput,
  DeleteEntryResult,
  MigrateEntriesInput,
  MigrateEntriesResult,
  MigrateFailure,
  UploadAssetInput,
  GetAssetInput,
  GetTransformedAssetInput,
  TransformedAsset
} from './core.js';
export {
  parseTransformParams,
  computeOutputFormat,
  applyTransforms,
  transformCacheKey,
  FsTransformCache,
  extForFormat,
  MAX_OUTPUT_DIMENSION
} from './transforms.js';
export type {
  TransformParams,
  TransformContext,
  TransformCache
} from './transforms.js';
export { normalizeTypeDef, normalizeField } from './normalize.js';
export { validateContent } from './validate.js';
export type { ValidationError, ValidationResult } from './validate.js';
export { deriveContent, slugify } from './derive.js';
export { classifyChange } from './classify.js';
export type { TypeDiff, FieldDiff } from './classify.js';
export { applyMergePatch } from './merge-patch.js';
export { resolveAssets } from './resolve-assets.js';
export type { ResolvedAsset } from './resolve-assets.js';
export {
  extractInlineRefs,
  collectInlineRefs,
  resolveInlineRefs
} from './resolve-refs.js';
export type {
  InlineRefAttrs,
  InlineRefSource,
  ResolvedRef
} from './resolve-refs.js';
export { parseRef } from './parse-ref.js';
export type { ParsedRef } from './parse-ref.js';
export { checkStructuralRefs } from './check-refs.js';
export {
  LOCALE_KEY,
  defaultLocale,
  computeFallbackChain,
  projectForLocale,
  extractLocaleSlugs
} from './locale.js';
