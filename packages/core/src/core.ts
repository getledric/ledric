import { defineType } from '@ledric/schema';
import type { FieldDef, TypeDef, TypeDefOptions } from '@ledric/schema';
import type { Storage } from '@ledric/storage';

export interface Capabilities {
  vectorSearch: boolean;
  nativePubSub: boolean;
  fts: 'fts5' | 'tsvector';
}

export interface DescribeModelResult {
  schema_version: number;
  types: Record<string, TypeDescription>;
  capabilities: Capabilities;
}

export interface TypeDescription extends TypeDef {
  version: number;
}

export interface CreateTypeInput {
  name: string;
  fields: Record<string, FieldDef>;
  opts?: TypeDefOptions;
  author?: string;
}

export class Core {
  constructor(private readonly storage: Storage) {}

  async describeModel(): Promise<DescribeModelResult> {
    const summaries = await this.storage.listTypes();
    const types: Record<string, TypeDescription> = {};
    let schemaVersionTotal = 0;

    for (const summary of summaries) {
      const detail = await this.storage.getType(summary.name);
      if (!detail) continue;
      types[detail.name] = { ...detail.definition, version: detail.current_version };
      schemaVersionTotal += detail.current_version;
    }

    return {
      schema_version: schemaVersionTotal,
      types,
      capabilities: {
        vectorSearch: false,
        nativePubSub: false,
        fts: 'fts5'
      }
    };
  }

  async createType(input: CreateTypeInput): Promise<TypeDescription> {
    const definition = defineType(input.name, input.fields, input.opts ?? {});
    await this.storage.createType({
      definition,
      ...(input.author !== undefined ? { author: input.author } : {})
    });
    return { ...definition, version: 1 };
  }
}
