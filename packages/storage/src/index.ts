export const PACKAGE_NAME = '@ledric/storage';

export type {
  Storage,
  TypeSummary,
  TypeDetail,
  CreateTypeInput,
  CreateTypeResult,
  AlterTypeInput,
  AlterTypeResult,
  ChangeClass,
  CreateEntryInput,
  UpdateEntryInput,
  PublishEntryInput,
  EntryRef,
  EntryWrite,
  EntryDetail,
  EntrySummary,
  FindEntriesInput,
  FindEntriesResult,
  RenameEntryInput,
  RenameEntryResult,
  CreateAssetInput,
  UpdateAssetInput,
  AssetMeta,
  AssetWrite,
  AssetSummary,
  AssetDetail,
  ListAssetsInput,
  ListAssetsResult,
  DeleteTypeInput,
  DeleteTypeResult,
  DeleteEntryInput,
  DeleteEntryResult,
  TagInfo,
  TagWithCounts,
  ApiKeyRole,
  CreateApiKeyInput,
  ApiKeyRow,
  ApiKeyLookup,
  ApiKeyLookupWithHash
} from './types.js';

export {
  generateApiKey,
  hashApiKey,
  parseApiKeyRole,
  looksLikeApiKey,
  ROLE_PREFIX
} from './keys.js';
export type { GeneratedApiKey } from './keys.js';

export { normalizeTag, normalizeTags } from './tags.js';
export type { NormalizedTag } from './tags.js';

// Storage implementation: a dialect-agnostic LedricStorage class plus
// per-dialect factory functions.
export {
  LedricStorage,
  VersionConflictError,
  NotFoundError,
  TypeNotEmptyError,
  UniqueViolationError
} from './storage.js';
export type { AssetsConfig } from './storage.js';

export { openSqlite, openMysql, openPostgres } from './dialects/index.js';
export type {
  OpenSqliteOptions,
  OpenMysqlOptions,
  OpenPostgresOptions
} from './dialects/index.js';

export type { Database as DatabaseSchema } from './schema.js';
export type { Dialect } from './migrations/run.js';

export type {
  AssetBackend,
  AssetPutInput,
  AssetGetResult
} from './assets/index.js';
export { AssetBackendRegistry, DbAssetBackend, LocalAssetBackend } from './assets/index.js';
