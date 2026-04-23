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

export interface Storage {
  createType(input: CreateTypeInput): Promise<CreateTypeResult>;
  listTypes(opts?: { includeDeleted?: boolean }): Promise<TypeSummary[]>;
  getType(name: string): Promise<TypeDetail | null>;
  close(): Promise<void>;
}
