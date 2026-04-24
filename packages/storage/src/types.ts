import type { TypeDef } from '@ledric/schema';

export type ChangeClass = 'safe' | 'needs_backfill' | 'destructive';

export interface TypeSummary {
  id: Uint8Array;
  name: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface TypeDetail extends TypeSummary {
  definition: TypeDef;
  schema_version: number;
}

export interface CreateTypeInput {
  definition: TypeDef;
  author?: string;
}

export interface CreateTypeResult {
  id: Uint8Array;
  name: string;
  version: number;
}

export interface AlterTypeInput {
  name: string;
  parent_version: number;
  definition: TypeDef;
  change_class: ChangeClass;
  author?: string;
}

export interface AlterTypeResult {
  id: Uint8Array;
  name: string;
  version: number;
  change_class: ChangeClass;
}

export interface CreateEntryInput {
  type: string;
  slug: string;
  content: Record<string, unknown>;
  schema_version: number;
  author?: string;
}

export interface UpdateEntryInput {
  ref: EntryRef;
  content: Record<string, unknown>;
  parent_version: number;
  schema_version: number;
  author?: string;
}

export interface PublishEntryInput {
  ref: EntryRef;
  version?: number;
}

export interface EntryRef {
  type: string;
  slug: string;
}

export interface EntryWrite {
  id: Uint8Array;
  type: string;
  slug: string;
  version: number;
}

export interface EntryDetail {
  id: Uint8Array;
  type: string;
  slug: string;
  version: number;
  current_version: number;
  published_version: number | null;
  schema_version: number;
  content: Record<string, unknown>;
  content_hash: Uint8Array;
  created_at: number;
  deleted_at: number | null;
}

export interface EntrySummary {
  id: Uint8Array;
  type: string;
  slug: string;
  current_version: number;
  published_version: number | null;
  deleted_at: number | null;
}

export interface FindEntriesInput {
  type: string;
  where?: Record<string, unknown>;
  limit?: number;
  offset?: number;
  order?: Array<{ field: string; dir: 'asc' | 'desc' }>;
  includeDeleted?: boolean;
}

export interface FindEntriesResult {
  results: EntryDetail[];
  total: number;
  offset: number;
}

export interface Storage {
  createType(input: CreateTypeInput): Promise<CreateTypeResult>;
  alterType(input: AlterTypeInput): Promise<AlterTypeResult>;
  listTypes(opts?: { includeDeleted?: boolean }): Promise<TypeSummary[]>;
  getType(name: string): Promise<TypeDetail | null>;

  createEntry(input: CreateEntryInput): Promise<EntryWrite>;
  updateEntry(input: UpdateEntryInput): Promise<EntryWrite>;
  readEntry(ref: EntryRef, opts?: { version?: number }): Promise<EntryDetail | null>;
  findEntries(input: FindEntriesInput): Promise<FindEntriesResult>;
  publishEntry(input: PublishEntryInput): Promise<EntryWrite>;

  close(): Promise<void>;
}
