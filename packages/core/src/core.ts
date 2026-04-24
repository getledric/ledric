import { defineType } from '@ledric/schema';
import type { FieldDef, TypeDef, TypeDefOptions } from '@ledric/schema';
import type {
  Storage,
  EntryDetail,
  EntryRef,
  EntryWrite,
  FindEntriesInput,
  FindEntriesResult
} from '@ledric/storage';
import { normalizeTypeDef } from './normalize.js';
import { deriveContent } from './derive.js';
import { validateContent, type ValidationError } from './validate.js';

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

export interface DraftInput {
  type: string;
  fields: Record<string, unknown>;
  ref?: EntryRef;
  parent_version?: number;
  author?: string;
}

export interface DraftResult extends EntryWrite {
  status: 'draft';
  content: Record<string, unknown>;
}

export interface ReadInput {
  ref: EntryRef;
  version?: number;
}

export interface PublishInput {
  ref: EntryRef;
  version?: number;
}

export interface PublishResult extends EntryWrite {
  published_version: number;
}

export class ValidationFailedError extends Error {
  readonly code = 'VALIDATION_FAILED';
  constructor(public readonly errors: ValidationError[]) {
    super(`VALIDATION_FAILED: ${errors.length} error(s)`);
  }
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
    const validated = defineType(input.name, input.fields, input.opts ?? {});
    const definition = normalizeTypeDef(validated);
    await this.storage.createType({
      definition,
      ...(input.author !== undefined ? { author: input.author } : {})
    });
    return { ...definition, version: 1 };
  }

  async draft(input: DraftInput): Promise<DraftResult> {
    const typeDetail = await this.storage.getType(input.type);
    if (!typeDetail) throw new Error(`Unknown type "${input.type}"`);

    const derived = deriveContent(typeDetail.definition, input.fields);
    const validated = validateContent(typeDetail.definition, derived);
    if (!validated.ok) throw new ValidationFailedError(validated.errors);

    const slugField = typeDetail.definition.identifier_field ?? 'slug';
    const slug = validated.value[slugField];
    if (typeof slug !== 'string' || slug.length === 0) {
      throw new ValidationFailedError([
        {
          path: `/${slugField}`,
          code: 'required',
          message: `The identifier field "${slugField}" must produce a non-empty slug.`
        }
      ]);
    }

    if (input.ref !== undefined) {
      if (input.ref.slug !== slug) {
        throw new ValidationFailedError([
          {
            path: `/${slugField}`,
            code: 'slug_change',
            message: `Cannot change slug on update in this version (ref was "${input.ref.slug}", content is "${slug}"). Slug changes will land when rename is implemented.`
          }
        ]);
      }
      if (input.parent_version === undefined) {
        throw new ValidationFailedError([
          {
            path: '/parent_version',
            code: 'required',
            message: 'parent_version is required when updating an existing entry.'
          }
        ]);
      }
      const write = await this.storage.updateEntry({
        ref: input.ref,
        content: validated.value,
        parent_version: input.parent_version,
        schema_version: typeDetail.current_version,
        ...(input.author !== undefined ? { author: input.author } : {})
      });
      return { ...write, status: 'draft', content: validated.value };
    }

    const write = await this.storage.createEntry({
      type: input.type,
      slug,
      content: validated.value,
      schema_version: typeDetail.current_version,
      ...(input.author !== undefined ? { author: input.author } : {})
    });
    return { ...write, status: 'draft', content: validated.value };
  }

  async read(input: ReadInput): Promise<EntryDetail | null> {
    const opts =
      input.version !== undefined ? { version: input.version } : undefined;
    return this.storage.readEntry(input.ref, opts);
  }

  async find(input: FindEntriesInput): Promise<FindEntriesResult> {
    return this.storage.findEntries(input);
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const write = await this.storage.publishEntry({
      ref: input.ref,
      ...(input.version !== undefined ? { version: input.version } : {})
    });
    return { ...write, published_version: write.version };
  }
}
