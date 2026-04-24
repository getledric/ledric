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
  CreateAssetInput,
  AssetMeta,
  AssetWrite,
  AssetSummary,
  AssetDetail,
  ListAssetsInput,
  ListAssetsResult
} from './types.js';

export { SqliteStorage, VersionConflictError, NotFoundError } from './sqlite.js';
export type { OpenOptions, AssetsConfig } from './sqlite.js';

export type {
  AssetBackend,
  AssetPutInput,
  AssetGetResult
} from './assets/index.js';
export { AssetBackendRegistry, DbAssetBackend, LocalAssetBackend } from './assets/index.js';
