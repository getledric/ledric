import { defineType } from '@ledric/schema';
import type { FieldDef, TypeDef, TypeDefOptions } from '@ledric/schema';
import type {
  Storage,
  ChangeClass,
  EntryDetail,
  EntryRef,
  EntryWrite,
  FindEntriesInput,
  FindEntriesResult,
  AssetMeta,
  AssetDetail,
  AssetSummary,
  AssetWrite,
  ListAssetsInput,
  ListAssetsResult
} from '@ledric/storage';
import { normalizeTypeDef } from './normalize.js';
import { deriveContent } from './derive.js';
import { validateContent, type ValidationError } from './validate.js';
import { classifyChange, deepEqual, type TypeDiff } from './classify.js';
import { applyMergePatch } from './merge-patch.js';
import { projectForLocale, extractLocaleSlugs } from './locale.js';

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

export interface AlterTypeInput {
  name: string;
  parent_version: number;
  merge_patch: Record<string, unknown>;
  dry_run?: boolean;
  author?: string;
}

export interface AlterTypeResult {
  name: string;
  version: number;
  change_class: ChangeClass;
  diff: TypeDiff;
  dry_run?: boolean;
  definition: TypeDef;
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
  locale?: string;
}

export interface PublishInput {
  ref: EntryRef;
  version?: number;
}

export interface PublishResult extends EntryWrite {
  published_version: number;
}

export interface RenameInput {
  ref: EntryRef;
  new_slug: string;
  locale?: string;
}

export interface RenameResult {
  id: string;
  type: string;
  old_slug: string;
  new_slug: string;
  locale: string | null;
  retired_at: number;
}

export interface MigrateEntriesInput {
  type: string;
  merge_patch?: Record<string, unknown>;
  filter?: Record<string, unknown>;
  dry_run?: boolean;
  author?: string;
  limit?: number;
}

export interface MigrateFailure {
  ref: EntryRef;
  errors: ValidationError[];
}

export interface MigrateEntriesResult {
  type: string;
  schema_version: number;
  checked: number;
  migrated: number;
  failed: MigrateFailure[];
  dry_run?: boolean;
}

export interface UploadAssetInput {
  kind: string;
  bytes: Uint8Array;
  meta?: AssetMeta;
  author?: string;
}

export interface GetAssetInput {
  id: string; // hex
  version?: number;
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

  async alterType(input: AlterTypeInput): Promise<AlterTypeResult> {
    const current = await this.storage.getType(input.name);
    if (!current) throw new Error(`Unknown type "${input.name}"`);

    if (
      typeof (input.merge_patch as { name?: unknown }).name === 'string' &&
      (input.merge_patch as { name: string }).name !== input.name
    ) {
      throw new Error(
        `alterType cannot rename "${input.name}" — renaming is a separate operation.`
      );
    }

    const merged = applyMergePatch(current.definition, {
      ...input.merge_patch,
      name: input.name
    }) as TypeDef;

    const validated = defineType(merged.name, merged.fields, {
      ...(merged.description !== undefined ? { description: merged.description } : {}),
      ...(merged.identifier_field !== undefined
        ? { identifier_field: merged.identifier_field }
        : {}),
      ...(merged.display_field !== undefined
        ? { display_field: merged.display_field }
        : {}),
      ...(merged.summary_fields !== undefined
        ? { summary_fields: merged.summary_fields }
        : {}),
      ...(merged.on_slug_change !== undefined
        ? { on_slug_change: merged.on_slug_change }
        : {}),
      ...(merged.example !== undefined ? { example: merged.example } : {})
    });
    const definition = normalizeTypeDef(validated);

    const diff = classifyChange(current.definition, definition);

    if (input.dry_run === true) {
      return {
        name: input.name,
        version: current.current_version,
        change_class: diff.class,
        diff,
        definition,
        dry_run: true
      };
    }

    const write = await this.storage.alterType({
      name: input.name,
      parent_version: input.parent_version,
      definition,
      change_class: diff.class,
      ...(input.author !== undefined ? { author: input.author } : {})
    });

    return {
      name: input.name,
      version: write.version,
      change_class: diff.class,
      diff,
      definition
    };
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

    // Compute locale_slugs from any per-locale slug fields. Only included
    // when the type is localized AND the slug field itself is localized
    // AND the locale block contains one. For non-localized types this is
    // always undefined — zero overhead at the storage layer.
    const localeSlugs = extractLocaleSlugs(typeDetail.definition, validated.value, slugField);

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
        ...(input.author !== undefined ? { author: input.author } : {}),
        ...(localeSlugs !== undefined ? { locale_slugs: localeSlugs } : {})
      });
      return { ...write, status: 'draft', content: validated.value };
    }

    const write = await this.storage.createEntry({
      type: input.type,
      slug,
      content: validated.value,
      schema_version: typeDetail.current_version,
      ...(input.author !== undefined ? { author: input.author } : {}),
      ...(localeSlugs !== undefined ? { locale_slugs: localeSlugs } : {})
    });
    return { ...write, status: 'draft', content: validated.value };
  }

  async read(input: ReadInput): Promise<EntryDetail | null> {
    const opts: { version?: number; locale?: string } = {};
    if (input.version !== undefined) opts.version = input.version;
    if (input.locale !== undefined) opts.locale = input.locale;
    const entry = await this.storage.readEntry(input.ref, opts);
    if (!entry) return null;

    // For localized types, always run projection — even for the default
    // locale or no-locale reads — so consumers never see other locales'
    // translations leaking through `_locale`. For non-localized types
    // this is a cheap no-op.
    const typeDetail = await this.storage.getType(entry.type);
    if (!typeDetail) return entry;
    const projected = projectForLocale(
      entry.content,
      typeDetail.definition,
      input.locale
    );
    return { ...entry, content: projected };
  }

  async find(input: FindEntriesInput & { locale?: string }): Promise<FindEntriesResult> {
    const result = await this.storage.findEntries(input);
    const typeDetail = await this.storage.getType(input.type);
    if (!typeDetail) return result;
    const projected = result.results.map((r) => ({
      ...r,
      content: projectForLocale(r.content, typeDetail.definition, input.locale)
    }));
    return { ...result, results: projected };
  }

  async rename(input: RenameInput): Promise<RenameResult> {
    const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
    if (!SLUG_RE.test(input.new_slug)) {
      throw new ValidationFailedError([
        {
          path: '/new_slug',
          code: 'format',
          message:
            'Slug must be 1-64 chars, lowercase a-z/0-9/hyphens, not starting or ending with a hyphen.',
          actual: input.new_slug
        }
      ]);
    }
    const result = await this.storage.renameEntry({
      ref: input.ref,
      new_slug: input.new_slug,
      ...(input.locale !== undefined ? { locale: input.locale } : {})
    });
    return {
      id: Buffer.from(result.id).toString('hex'),
      type: result.type,
      old_slug: result.old_slug,
      new_slug: result.new_slug,
      locale: result.locale,
      retired_at: result.retired_at
    };
  }

  async publish(input: PublishInput): Promise<PublishResult> {
    const write = await this.storage.publishEntry({
      ref: input.ref,
      ...(input.version !== undefined ? { version: input.version } : {})
    });
    return { ...write, published_version: write.version };
  }

  async uploadAsset(input: UploadAssetInput): Promise<AssetWrite> {
    return this.storage.createAsset({
      kind: input.kind,
      bytes: input.bytes,
      ...(input.meta !== undefined ? { meta: input.meta } : {}),
      ...(input.author !== undefined ? { author: input.author } : {})
    });
  }

  async getAsset(input: GetAssetInput): Promise<AssetDetail | null> {
    const id = Buffer.from(input.id, 'hex');
    if (id.byteLength !== 16) {
      throw new Error(`Invalid asset id "${input.id}" (expected 32-char hex)`);
    }
    return this.storage.getAsset(
      new Uint8Array(id),
      ...(input.version !== undefined ? [{ version: input.version }] : [])
    );
  }

  async listAssets(input?: ListAssetsInput): Promise<ListAssetsResult> {
    return this.storage.listAssets(input);
  }

  async readAssetBytes(input: GetAssetInput): Promise<Buffer> {
    const id = Buffer.from(input.id, 'hex');
    if (id.byteLength !== 16) {
      throw new Error(`Invalid asset id "${input.id}" (expected 32-char hex)`);
    }
    return this.storage.readAssetBytes(
      new Uint8Array(id),
      ...(input.version !== undefined ? [{ version: input.version }] : [])
    );
  }

  // No-op pass-through used by tests and future hooks.
  async migrateEntries(input: MigrateEntriesInput): Promise<MigrateEntriesResult> {
    const typeDetail = await this.storage.getType(input.type);
    if (!typeDetail) throw new Error(`Unknown type "${input.type}"`);

    const PAGE = Math.min(input.limit ?? 500, 500);
    let offset = 0;
    let checked = 0;
    let migrated = 0;
    const failed: MigrateFailure[] = [];

    // Stable page ordering (created_at DESC by default) is fine here because
    // we re-query each page and mutate current_version under optimistic
    // concurrency; if a page shifts we'll just skip what we already saw.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const page = await this.storage.findEntries({
        type: input.type,
        ...(input.filter !== undefined ? { where: input.filter } : {}),
        limit: PAGE,
        offset
      });
      if (page.results.length === 0) break;

      for (const entry of page.results) {
        checked++;
        const ref: EntryRef = { type: entry.type, slug: entry.slug };

        let candidate = entry.content;
        if (input.merge_patch !== undefined) {
          candidate = applyMergePatch(candidate, input.merge_patch) as Record<string, unknown>;
        }
        candidate = deriveContent(typeDetail.definition, candidate);

        const v = validateContent(typeDetail.definition, candidate);
        if (!v.ok) {
          failed.push({ ref, errors: v.errors });
          continue;
        }

        const schemaChanged = entry.schema_version !== typeDetail.current_version;
        const contentChanged = !deepEqual(entry.content, v.value);
        if (!contentChanged && !schemaChanged) continue;

        migrated++;
        if (input.dry_run === true) continue;

        const slugField = typeDetail.definition.identifier_field ?? 'slug';
        const localeSlugs = extractLocaleSlugs(typeDetail.definition, v.value, slugField);

        await this.storage.updateEntry({
          ref,
          content: v.value,
          parent_version: entry.current_version,
          schema_version: typeDetail.current_version,
          ...(input.author !== undefined ? { author: input.author } : {}),
          ...(localeSlugs !== undefined ? { locale_slugs: localeSlugs } : {})
        });
      }

      if (page.results.length < PAGE) break;
      offset += page.results.length;
    }

    return {
      type: input.type,
      schema_version: typeDetail.current_version,
      checked,
      migrated,
      failed,
      ...(input.dry_run === true ? { dry_run: true } : {})
    };
  }
}
