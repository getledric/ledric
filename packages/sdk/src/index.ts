export const PACKAGE_NAME = '@ledric/sdk';

export { LedricClient, createLedricClient, LedricError } from './client.js';
export type { LedricClientOptions } from './client.js';
export type {
  Entry,
  EntrySummary,
  FindResult,
  FindOptions,
  ReadOptions,
  EntryRef,
  TypeDescription,
  DescribeModel,
  FieldDef,
  Capabilities,
  Asset,
  AssetSummary,
  AssetMeta,
  ListAssetsResult,
  ListAssetsOptions,
  ResolvedRef
} from './types.js';
