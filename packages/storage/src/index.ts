export const PACKAGE_NAME = '@ledric/storage';

export type {
  Storage,
  TypeSummary,
  TypeDetail,
  CreateTypeInput,
  CreateTypeResult,
  ChangeClass,
  CreateEntryInput,
  UpdateEntryInput,
  PublishEntryInput,
  EntryRef,
  EntryWrite,
  EntryDetail,
  EntrySummary,
  FindEntriesInput,
  FindEntriesResult
} from './types.js';

export { SqliteStorage, VersionConflictError, NotFoundError } from './sqlite.js';
export type { OpenOptions } from './sqlite.js';
