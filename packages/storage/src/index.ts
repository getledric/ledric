export const PACKAGE_NAME = '@ledric/storage';

export type {
  Storage,
  TypeSummary,
  TypeDetail,
  CreateTypeInput,
  CreateTypeResult,
  ChangeClass
} from './types.js';

export { SqliteStorage } from './sqlite.js';
export type { OpenOptions } from './sqlite.js';
