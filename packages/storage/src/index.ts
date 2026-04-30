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
  ApiKeyRole,
  CreateApiKeyInput,
  ApiKeyRow,
  ApiKeyLookup
} from './types.js';

export {
  generateApiKey,
  hashApiKey,
  parseApiKeyRole,
  looksLikeApiKey,
  ROLE_PREFIX
} from './keys.js';
export type { GeneratedApiKey } from './keys.js';

export {
  SqliteStorage,
  VersionConflictError,
  NotFoundError,
  TypeNotEmptyError
} from './sqlite.js';
export type { OpenOptions, AssetsConfig } from './sqlite.js';

export type {
  AssetBackend,
  AssetPutInput,
  AssetGetResult
} from './assets/index.js';
export { AssetBackendRegistry, DbAssetBackend, LocalAssetBackend } from './assets/index.js';
