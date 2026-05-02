export const PACKAGE_NAME = '@ledric/sdk';

export { LedricClient, createLedricClient, LedricError } from './client.js';
export type { LedricClientOptions, LedricApiError } from './client.js';
export { refAttrs, refAttrsHtml } from './refs.js';
export type { RefSource } from './refs.js';
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
  AssetTransformOptions,
  TagInfo,
  TagWithCounts,
  ListAssetsResult,
  ListAssetsOptions,
  ResolvedRef,
  ValidationWarning
} from './types.js';

export type { LedricEntries } from './types.js';
