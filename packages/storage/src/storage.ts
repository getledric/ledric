import { sql, type Kysely } from 'kysely';
import type { TypeDef } from '@ledric/schema';
import type {
  Storage,
  TypeSummary,
  TypeDetail,
  CreateTypeInput,
  CreateTypeResult,
  CreateEntryInput,
  UpdateEntryInput,
  PublishEntryInput,
  EntryRef,
  EntryWrite,
  EntryDetail,
  FindEntriesInput,
  FindEntriesResult,
  CreateAssetInput,
  AssetDetail,
  AssetMeta,
  AssetWrite,
  ListAssetsInput,
  ListAssetsResult,
  TagInfo,
  TagWithCounts,
  AlterTypeInput,
  AlterTypeResult,
  RenameEntryInput,
  RenameEntryResult,
  DeleteTypeInput,
  DeleteTypeResult,
  DeleteEntryInput,
  DeleteEntryResult,
  CreateApiKeyInput,
  ApiKeyLookup,
  ApiKeyRow,
  UpdateAssetInput
} from './types.js';
import type { Database } from './schema.js';
import type { Dialect } from './migrations/run.js';
import { uuidv7Bytes } from './uuid.js';
import { contentHash } from './hash.js';
import { normalizeTag, normalizeTags } from './tags.js';
import { jsonExtractText, caseInsensitive } from './sql-helpers.js';
import {
  AssetBackendRegistry,
  DbAssetBackend,
  LocalAssetBackend
} from './assets/index.js';
import type { AssetBackend } from './assets/index.js';

export class VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT';
  constructor(
    public readonly type: string,
    public readonly slug: string,
    public readonly current_version: number,
    public readonly your_parent_version: number
  ) {
    super(
      `VERSION_CONFLICT: ${type}/${slug} is at version ${current_version}; your parent_version was ${your_parent_version}`
    );
  }
}

export class NotFoundError extends Error {
  readonly code = 'NOT_FOUND';
  constructor(
    public readonly kind: 'type' | 'entry' | 'asset' | 'asset_blob',
    public readonly ref: string
  ) {
    super(`NOT_FOUND: ${kind} "${ref}"`);
  }
}

export class UniqueViolationError extends Error {
  readonly code = 'UNIQUE_VIOLATION';
  constructor(
    public readonly type: string,
    public readonly field: string,
    public readonly value: unknown,
    public readonly conflicting_slug: string
  ) {
    super(
      `UNIQUE_VIOLATION: ${type}.${field} value collides with existing entry "${conflicting_slug}"`
    );
  }
}

export class TypeNotEmptyError extends Error {
  readonly code = 'TYPE_NOT_EMPTY';
  constructor(
    public readonly type: string,
    public readonly entry_count: number
  ) {
    super(
      `TYPE_NOT_EMPTY: type "${type}" still has ${entry_count} non-deleted entries. Pass cascade:true to delete them too, or delete_entry them first.`
    );
  }
}

const MAIN_ENV_NAME = 'main';

export type AssetsConfig =
  | { backend: 'db' }
  | { backend: 'local'; root: string }
  | { backend: AssetBackend; extras?: AssetBackend[] };

/**
 * Dialect-agnostic Storage implementation. Takes a `Kysely<Database>`
 * instance plus its dialect tag — the dialect is needed for the small
 * set of SQL bits Kysely doesn't abstract (json paths, case-insensitive
 * ORDER BY).
 *
 * The dialect-specific factory functions (`openSqlite`, `openMysql`,
 * `openPostgres`) construct one of these.
 */
export class LedricStorage implements Storage {
  readonly db: Kysely<Database>;
  readonly dialect: Dialect;
  readonly assetBackends: AssetBackendRegistry;
  /** Optional native handle for the underlying driver. Set by SQLite factory; null for others. */
  readonly nativeDb: unknown;
  private mainEnvId!: Uint8Array;

  constructor(opts: {
    db: Kysely<Database>;
    dialect: Dialect;
    assets?: AssetsConfig;
    nativeDb?: unknown;
  }) {
    this.db = opts.db;
    this.dialect = opts.dialect;
    this.nativeDb = opts.nativeDb ?? null;
    this.assetBackends = new AssetBackendRegistry();
    this.configureAssetBackends(opts.assets);
  }

  /** Called by factories after construction so async work can run. */
  async initialize(): Promise<void> {
    await this.bootstrapMainEnv();
  }

  private configureAssetBackends(config: AssetsConfig | undefined): void {
    // Always register db backend — cheap and useful as a fallback for resolving refs.
    this.assetBackends.register(new DbAssetBackend(this.db));

    const cfg: AssetsConfig = config ?? { backend: 'db' };
    if (typeof cfg.backend === 'string') {
      if (cfg.backend === 'db') {
        // already default
      } else if (cfg.backend === 'local') {
        this.assetBackends.register(new LocalAssetBackend(cfg.root), { asDefault: true });
      }
    } else {
      this.assetBackends.register(cfg.backend, { asDefault: true });
      for (const extra of cfg.extras ?? []) this.assetBackends.register(extra);
    }
  }

  private async bootstrapMainEnv(): Promise<void> {
    const row = await this.db
      .selectFrom('envs')
      .select('id')
      .where('name', '=', MAIN_ENV_NAME)
      .executeTakeFirst();

    if (row) {
      this.mainEnvId = new Uint8Array(row.id);
      return;
    }

    const id = uuidv7Bytes();
    await this.db
      .insertInto('envs')
      .values({
        id: Buffer.from(id),
        name: MAIN_ENV_NAME,
        parent_id: null,
        created_at: Date.now()
      })
      .execute();
    this.mainEnvId = id;
  }

  private envIdBuf(): Buffer {
    return Buffer.from(this.mainEnvId);
  }

  async createType(input: CreateTypeInput): Promise<CreateTypeResult> {
    const { definition, author } = input;
    const envId = this.envIdBuf();

    const existing = await this.db
      .selectFrom('types')
      .select(['id', 'current_version'])
      .where('env_id', '=', envId)
      .where('name', '=', definition.name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (existing) {
      throw new Error(
        `createType: type "${definition.name}" already exists (current version ${existing.current_version}). Use alter_type to evolve.`
      );
    }

    const typeId = uuidv7Bytes();
    const now = Date.now();
    const definitionJson = JSON.stringify(definition);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('types')
        .values({
          id: Buffer.from(typeId),
          env_id: envId,
          name: definition.name,
          current_version: 1,
          published_version: null,
          deleted_at: null
        })
        .execute();

      await tx
        .insertInto('type_versions')
        .values({
          type_id: Buffer.from(typeId),
          version: 1,
          definition: definitionJson,
          change_class: 'safe',
          parent_version: null,
          author: author ?? null,
          created_at: now
        })
        .execute();
    });

    return { id: typeId, name: definition.name, version: 1 };
  }

  async alterType(input: AlterTypeInput): Promise<AlterTypeResult> {
    const envId = this.envIdBuf();
    const row = await this.db
      .selectFrom('types')
      .select(['id', 'current_version'])
      .where('env_id', '=', envId)
      .where('name', '=', input.name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('type', input.name);

    if (row.current_version !== input.parent_version) {
      throw new VersionConflictError(
        'type',
        input.name,
        row.current_version,
        input.parent_version
      );
    }

    const nextVersion = row.current_version + 1;
    const now = Date.now();
    const definitionJson = JSON.stringify(input.definition);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('type_versions')
        .values({
          type_id: row.id,
          version: nextVersion,
          definition: definitionJson,
          change_class: input.change_class,
          parent_version: row.current_version,
          author: input.author ?? null,
          created_at: now
        })
        .execute();

      await tx
        .updateTable('types')
        .set({ current_version: nextVersion })
        .where('id', '=', row.id)
        .execute();
    });

    return {
      id: new Uint8Array(row.id),
      name: input.name,
      version: nextVersion,
      change_class: input.change_class
    };
  }

  async listTypes(opts?: { includeDeleted?: boolean }): Promise<TypeSummary[]> {
    const envId = this.envIdBuf();
    let q = this.db
      .selectFrom('types')
      .select(['id', 'name', 'current_version', 'published_version', 'deleted_at'])
      .where('env_id', '=', envId)
      .orderBy('name');
    if (opts?.includeDeleted !== true) {
      q = q.where('deleted_at', 'is', null);
    }
    const rows = await q.execute();
    return rows.map((r) => ({
      id: new Uint8Array(r.id),
      name: r.name,
      current_version: r.current_version,
      published_version: r.published_version,
      deleted_at: r.deleted_at
    }));
  }

  async getType(name: string): Promise<TypeDetail | null> {
    const envId = this.envIdBuf();
    const row = await this.db
      .selectFrom('types as t')
      .innerJoin('type_versions as tv', (join) =>
        join.onRef('tv.type_id', '=', 't.id').onRef('tv.version', '=', 't.current_version')
      )
      .select([
        't.id as id',
        't.name as name',
        't.current_version as current_version',
        't.published_version as published_version',
        't.deleted_at as deleted_at',
        'tv.definition as definition'
      ])
      .where('t.env_id', '=', envId)
      .where('t.name', '=', name)
      .executeTakeFirst();

    if (!row) return null;

    const definition = JSON.parse(row.definition) as TypeDef;
    return {
      id: new Uint8Array(row.id),
      name: row.name,
      current_version: row.current_version,
      published_version: row.published_version,
      deleted_at: row.deleted_at,
      schema_version: row.current_version,
      definition
    };
  }

  private async requireTypeId(name: string): Promise<{ id: Buffer; current_version: number }> {
    const row = await this.db
      .selectFrom('types')
      .select(['id', 'current_version'])
      .where('env_id', '=', this.envIdBuf())
      .where('name', '=', name)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!row) throw new NotFoundError('type', name);
    return { id: row.id, current_version: row.current_version };
  }

  async createEntry(input: CreateEntryInput): Promise<EntryWrite> {
    const typeRow = await this.requireTypeId(input.type);
    const entryId = uuidv7Bytes();
    const now = Date.now();
    const hash = contentHash(input.content);
    const contentJson = JSON.stringify(input.content);
    const localeSlugs = input.locale_slugs ?? {};
    const hasLocaleSlugs = Object.keys(localeSlugs).length > 0;
    const envId = this.envIdBuf();
    const initialTags = normalizeTags(input.tags ?? []);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('entries')
        .values({
          id: Buffer.from(entryId),
          env_id: envId,
          type_id: typeRow.id,
          slug: input.slug,
          current_version: 1,
          published_version: null,
          deleted_at: null
        })
        .execute();

      await tx
        .insertInto('entry_versions')
        .values({
          entry_id: Buffer.from(entryId),
          version: 1,
          content: contentJson,
          schema_version: input.schema_version,
          content_hash: Buffer.from(hash),
          parent_version: null,
          author: input.author ?? null,
          created_at: now
        })
        .execute();

      if (hasLocaleSlugs) {
        const rows = Object.entries(localeSlugs).map(([locale, slug]) => ({
          env_id: envId,
          type_id: typeRow.id,
          locale,
          slug,
          entry_id: Buffer.from(entryId)
        }));
        await tx.insertInto('entries_slugs').values(rows).execute();
      }

      if (initialTags.length > 0) {
        const resolved = await this.resolveOrCreateTags(tx, envId, initialTags);
        await this.attachEntryTags(tx, envId, Buffer.from(entryId), resolved.map((r) => r.id));
      }

      await this.syncFtsRows(tx, Buffer.from(entryId), input.type, typeRow.id, input.content);
    });

    return { id: entryId, type: input.type, slug: input.slug, version: 1 };
  }

  async updateEntry(input: UpdateEntryInput): Promise<EntryWrite> {
    const typeRow = await this.requireTypeId(input.ref.type);
    const envId = this.envIdBuf();

    const row = await this.db
      .selectFrom('entries')
      .select(['id', 'current_version'])
      .where('env_id', '=', envId)
      .where('type_id', '=', typeRow.id)
      .where('slug', '=', input.ref.slug)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!row) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);

    if (row.current_version !== input.parent_version) {
      throw new VersionConflictError(
        input.ref.type,
        input.ref.slug,
        row.current_version,
        input.parent_version
      );
    }

    const entryIdBuf = row.id;
    const nextVersion = row.current_version + 1;
    const now = Date.now();
    const hash = contentHash(input.content);
    const contentJson = JSON.stringify(input.content);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('entry_versions')
        .values({
          entry_id: entryIdBuf,
          version: nextVersion,
          content: contentJson,
          schema_version: input.schema_version,
          content_hash: Buffer.from(hash),
          parent_version: row.current_version,
          author: input.author ?? null,
          created_at: now
        })
        .execute();

      await tx
        .updateTable('entries')
        .set({ current_version: nextVersion })
        .where('id', '=', entryIdBuf)
        .execute();

      // locale_slugs === undefined means "don't touch routing"; an empty
      // map or populated map replaces the entry's per-locale slugs.
      if (input.locale_slugs !== undefined) {
        await tx.deleteFrom('entries_slugs').where('entry_id', '=', entryIdBuf).execute();
        const rows = Object.entries(input.locale_slugs).map(([locale, slug]) => ({
          env_id: envId,
          type_id: typeRow.id,
          locale,
          slug,
          entry_id: entryIdBuf
        }));
        if (rows.length > 0) {
          await tx.insertInto('entries_slugs').values(rows).execute();
        }
      }

      await this.syncFtsRows(tx, entryIdBuf, input.ref.type, typeRow.id, input.content);
    });

    return {
      id: new Uint8Array(entryIdBuf),
      type: input.ref.type,
      slug: input.ref.slug,
      version: nextVersion
    };
  }

  async readEntry(
    ref: EntryRef,
    opts?: { version?: number; locale?: string }
  ): Promise<EntryDetail | null> {
    const envId = this.envIdBuf();
    const locale = opts?.locale;

    // Locale-aware lookup: try entries_slugs(locale, slug) first when a
    // locale is supplied. If it hits, we project through the resolved
    // entry's default-locale slug.
    if (locale !== undefined) {
      const localeRow = await this.db
        .selectFrom('entries_slugs as es')
        .innerJoin('types as t', 't.id', 'es.type_id')
        .innerJoin('entries as e', 'e.id', 'es.entry_id')
        .select(['es.entry_id as entry_id', 'e.slug as current_slug'])
        .where('es.env_id', '=', envId)
        .where('t.name', '=', ref.type)
        .where('es.locale', '=', locale)
        .where('es.slug', '=', ref.slug)
        .where('e.deleted_at', 'is', null)
        .executeTakeFirst();
      if (localeRow) {
        const resolved = await this.readEntryDirect(
          { type: ref.type, slug: localeRow.current_slug },
          opts
        );
        if (resolved) return resolved;
      }
    }

    const direct = await this.readEntryDirect(ref, opts);
    if (direct !== null) return direct;

    // Fall through: is this a retired slug for some entry of this type?
    let retiredQ = this.db
      .selectFrom('slug_history as h')
      .innerJoin('types as t', 't.id', 'h.type_id')
      .select(['h.entry_id as entry_id'])
      .where('h.env_id', '=', envId)
      .where('t.name', '=', ref.type)
      .where('h.slug', '=', ref.slug)
      .orderBy('h.retired_at', 'desc')
      .limit(1);
    if (locale !== undefined) {
      retiredQ = retiredQ.where('h.locale', '=', locale);
    }
    const retired = await retiredQ.executeTakeFirst();

    if (!retired) return null;

    const currentRow = await this.db
      .selectFrom('entries')
      .select(['slug', 'deleted_at'])
      .where('id', '=', retired.entry_id)
      .executeTakeFirst();

    if (!currentRow || currentRow.deleted_at !== null) return null;

    let redirectTo = currentRow.slug;
    if (locale !== undefined) {
      const currentLocaleSlug = await this.db
        .selectFrom('entries_slugs')
        .select('slug')
        .where('entry_id', '=', retired.entry_id)
        .where('locale', '=', locale)
        .executeTakeFirst();
      if (currentLocaleSlug) redirectTo = currentLocaleSlug.slug;
    }

    const resolved = await this.readEntryDirect(
      { type: ref.type, slug: currentRow.slug },
      opts
    );
    if (!resolved) return null;
    return {
      ...resolved,
      _redirect: {
        from: ref.slug,
        to: redirectTo,
        ...(locale !== undefined ? { locale } : {})
      }
    };
  }

  private async readEntryDirect(
    ref: EntryRef,
    opts?: { version?: number }
  ): Promise<EntryDetail | null> {
    const envId = this.envIdBuf();
    const versionMatch = opts?.version !== undefined ? opts.version : null;

    let q = this.db
      .selectFrom('entries as e')
      .innerJoin('types as t', 't.id', 'e.type_id')
      .innerJoin('entry_versions as ev', (join) => {
        if (versionMatch !== null) {
          return join.onRef('ev.entry_id', '=', 'e.id').on('ev.version', '=', versionMatch);
        }
        return join.onRef('ev.entry_id', '=', 'e.id').onRef('ev.version', '=', 'e.current_version');
      })
      .select([
        'e.id as id',
        'e.slug as slug',
        'e.current_version as current_version',
        'e.published_version as published_version',
        'e.deleted_at as deleted_at',
        'ev.version as version',
        'ev.content as content',
        'ev.schema_version as schema_version',
        'ev.content_hash as content_hash',
        'ev.created_at as created_at'
      ])
      .where('e.env_id', '=', envId)
      .where('t.name', '=', ref.type)
      .where('e.slug', '=', ref.slug)
      .where('e.deleted_at', 'is', null);

    const row = await q.executeTakeFirst();
    if (!row) return null;

    const tags = (await this.fetchEntryTags(envId, [row.id])).get(row.id.toString('hex')) ?? [];
    return {
      id: new Uint8Array(row.id),
      type: ref.type,
      slug: row.slug,
      version: row.version,
      current_version: row.current_version,
      published_version: row.published_version,
      schema_version: row.schema_version,
      content: JSON.parse(row.content) as Record<string, unknown>,
      content_hash: new Uint8Array(row.content_hash),
      created_at: row.created_at,
      deleted_at: row.deleted_at,
      tags
    };
  }

  async renameEntry(input: RenameEntryInput): Promise<RenameEntryResult> {
    const typeRow = await this.requireTypeId(input.ref.type);
    const envId = this.envIdBuf();
    const localeArg = input.locale ?? null;

    let entryIdBuf: Buffer;
    if (input.locale === undefined) {
      const entryRow = await this.db
        .selectFrom('entries')
        .select('id')
        .where('env_id', '=', envId)
        .where('type_id', '=', typeRow.id)
        .where('slug', '=', input.ref.slug)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!entryRow) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);
      entryIdBuf = entryRow.id;
    } else {
      const localeRow = await this.db
        .selectFrom('entries_slugs')
        .select('entry_id')
        .where('env_id', '=', envId)
        .where('type_id', '=', typeRow.id)
        .where('locale', '=', input.locale)
        .where('slug', '=', input.ref.slug)
        .executeTakeFirst();
      if (!localeRow) {
        throw new NotFoundError(
          'entry',
          `${input.ref.type}/${input.ref.slug}@${input.locale}`
        );
      }
      entryIdBuf = localeRow.entry_id;
    }

    if (input.new_slug === input.ref.slug) {
      return {
        id: new Uint8Array(entryIdBuf),
        type: input.ref.type,
        old_slug: input.ref.slug,
        new_slug: input.new_slug,
        locale: localeArg,
        retired_at: Date.now()
      };
    }

    const now = Date.now();
    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('slug_history')
        .values({
          env_id: envId,
          slug: input.ref.slug,
          type_id: typeRow.id,
          entry_id: entryIdBuf,
          retired_at: now,
          locale: localeArg
        })
        .execute();

      if (input.locale === undefined) {
        await tx
          .updateTable('entries')
          .set({ slug: input.new_slug })
          .where('id', '=', entryIdBuf)
          .execute();
      } else {
        await tx
          .updateTable('entries_slugs')
          .set({ slug: input.new_slug })
          .where('env_id', '=', envId)
          .where('type_id', '=', typeRow.id)
          .where('locale', '=', input.locale)
          .where('slug', '=', input.ref.slug)
          .execute();
      }
    });

    return {
      id: new Uint8Array(entryIdBuf),
      type: input.ref.type,
      old_slug: input.ref.slug,
      new_slug: input.new_slug,
      locale: localeArg,
      retired_at: now
    };
  }

  async findEntries(input: FindEntriesInput): Promise<FindEntriesResult> {
    // When a full-text query is supplied, delegate to searchEntries.
    // v1: we ignore `where` and `order` in this path — FTS rank is the
    // ordering, and tags + locale carry the structural filtering load.
    if (typeof input.q === 'string' && input.q.length > 0) {
      return this.searchEntries({
        q: input.q,
        type: input.type,
        ...(input.tags !== undefined ? { tags: input.tags } : {}),
        ...(input.locale !== undefined ? { locale: input.locale } : {}),
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
        ...(input.offset !== undefined ? { offset: input.offset } : {}),
        ...(input.includeDeleted !== undefined ? { includeDeleted: input.includeDeleted } : {}),
        ...(input.published !== undefined ? { published: input.published } : {})
      });
    }

    const typeRow = await this.requireTypeId(input.type);
    const envId = this.envIdBuf();
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    const where = input.where ?? {};

    const tagSlugs = input.tags ? normalizeTags(input.tags).map((t) => t.slug) : [];

    const publishedOnly = input.published === true;
    const baseQuery = (selectExprs: ReadonlyArray<string> | null) => {
      let q = this.db
        .selectFrom('entries as e')
        .innerJoin('entry_versions as ev', (join) =>
          publishedOnly
            ? join
                .onRef('ev.entry_id', '=', 'e.id')
                .onRef('ev.version', '=', 'e.published_version')
            : join
                .onRef('ev.entry_id', '=', 'e.id')
                .onRef('ev.version', '=', 'e.current_version')
        )
        .where('e.env_id', '=', envId)
        .where('e.type_id', '=', typeRow.id);

      if (publishedOnly) {
        q = q.where('e.published_version', 'is not', null);
      }

      if (input.includeDeleted !== true) {
        q = q.where('e.deleted_at', 'is', null);
      }

      // JSON-field WHERE filters via dialect-aware json_extract.
      for (const [field, value] of Object.entries(where)) {
        const expr = jsonExtractText(this.dialect, sql.ref('ev.content'), field);
        // Coerce value to a string for cross-dialect comparison.
        q = q.where(expr, '=', value === null ? null : String(value));
      }

      // Tag filter — must have ALL provided tags.
      if (tagSlugs.length > 0) {
        const tagSubquery = this.db
          .selectFrom('entry_tags as et')
          .innerJoin('tags as t', 't.id', 'et.tag_id')
          .select((eb) => eb.ref('et.entry_id').as('entry_id'))
          .where('et.env_id', '=', envId)
          .where('t.slug', 'in', tagSlugs)
          .groupBy('et.entry_id')
          .having((eb) => eb.fn.count('t.slug').distinct(), '=', tagSlugs.length);
        q = q.where('e.id', 'in', tagSubquery);
      }

      if (selectExprs === null) {
        return q.select(({ fn }) => [fn.countAll<number>().as('c')]);
      }

      let withSelect = q.select([
        'e.id as id',
        'e.slug as slug',
        'e.current_version as current_version',
        'e.published_version as published_version',
        'e.deleted_at as deleted_at',
        'ev.version as version',
        'ev.content as content',
        'ev.schema_version as schema_version',
        'ev.content_hash as content_hash',
        'ev.created_at as created_at'
      ]);

      if (input.order && input.order.length > 0) {
        for (const o of input.order) {
          const expr = jsonExtractText(this.dialect, sql.ref('ev.content'), o.field);
          withSelect = withSelect.orderBy(expr, o.dir === 'asc' ? 'asc' : 'desc');
        }
      } else {
        withSelect = withSelect.orderBy('ev.created_at', 'desc');
      }

      return withSelect.limit(limit).offset(offset);
    };

    const rows = (await baseQuery([]).execute()) as Array<{
      id: Buffer;
      slug: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
      version: number;
      content: string;
      schema_version: number;
      content_hash: Buffer;
      created_at: number;
    }>;

    const countRow = (await baseQuery(null).executeTakeFirst()) as { c: number } | undefined;
    const total = Number(countRow?.c ?? 0);

    const tagsByEntry = await this.fetchEntryTags(envId, rows.map((r) => r.id));

    const results: EntryDetail[] = rows.map((r) => ({
      id: new Uint8Array(r.id),
      type: input.type,
      slug: r.slug,
      version: r.version,
      current_version: r.current_version,
      published_version: r.published_version,
      schema_version: r.schema_version,
      content: JSON.parse(r.content) as Record<string, unknown>,
      content_hash: new Uint8Array(r.content_hash),
      created_at: r.created_at,
      deleted_at: r.deleted_at,
      tags: tagsByEntry.get(r.id.toString('hex')) ?? []
    }));

    return { results, total, offset };
  }

  async publishEntry(input: PublishEntryInput): Promise<EntryWrite> {
    const typeRow = await this.requireTypeId(input.ref.type);
    const envId = this.envIdBuf();

    const row = await this.db
      .selectFrom('entries')
      .select(['id', 'current_version'])
      .where('env_id', '=', envId)
      .where('type_id', '=', typeRow.id)
      .where('slug', '=', input.ref.slug)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!row) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);

    const targetVersion = input.version ?? row.current_version;

    const versionRow = await this.db
      .selectFrom('entry_versions')
      .select('version')
      .where('entry_id', '=', row.id)
      .where('version', '=', targetVersion)
      .executeTakeFirst();

    if (!versionRow) {
      throw new NotFoundError(
        'entry',
        `${input.ref.type}/${input.ref.slug}@v${targetVersion}`
      );
    }

    await this.db
      .updateTable('entries')
      .set({ published_version: targetVersion })
      .where('id', '=', row.id)
      .execute();

    return {
      id: new Uint8Array(row.id),
      type: input.ref.type,
      slug: input.ref.slug,
      version: targetVersion
    };
  }

  async deleteType(input: DeleteTypeInput): Promise<DeleteTypeResult> {
    const envId = this.envIdBuf();
    return await this.db.transaction().execute(async (tx) => {
      const typeRow = await tx
        .selectFrom('types')
        .select(['id', 'current_version', 'deleted_at'])
        .where('env_id', '=', envId)
        .where('name', '=', input.name)
        .executeTakeFirst();
      if (!typeRow || typeRow.deleted_at !== null) {
        throw new NotFoundError('type', input.name);
      }
      if (typeRow.current_version !== input.parent_version) {
        throw new VersionConflictError(
          'type',
          input.name,
          typeRow.current_version,
          input.parent_version
        );
      }

      const liveCountRow = await tx
        .selectFrom('entries')
        .select(({ fn }) => fn.countAll<number>().as('n'))
        .where('env_id', '=', envId)
        .where('type_id', '=', typeRow.id)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      const liveCount = Number(liveCountRow?.n ?? 0);

      let entries_deleted = 0;
      if (liveCount > 0) {
        if (input.cascade !== true) {
          throw new TypeNotEmptyError(input.name, liveCount);
        }
        const now = Date.now();
        const result = await tx
          .updateTable('entries')
          .set({ deleted_at: now })
          .where('env_id', '=', envId)
          .where('type_id', '=', typeRow.id)
          .where('deleted_at', 'is', null)
          .executeTakeFirst();
        entries_deleted = Number(result.numUpdatedRows ?? 0);
      }

      const now = Date.now();
      await tx
        .updateTable('types')
        .set({ deleted_at: now })
        .where('id', '=', typeRow.id)
        .execute();

      return { name: input.name, deleted_at: now, entries_deleted };
    });
  }

  async deleteEntry(input: DeleteEntryInput): Promise<DeleteEntryResult> {
    const typeRow = await this.requireTypeId(input.ref.type);
    const envId = this.envIdBuf();

    const row = await this.db
      .selectFrom('entries')
      .select(['id', 'current_version'])
      .where('env_id', '=', envId)
      .where('type_id', '=', typeRow.id)
      .where('slug', '=', input.ref.slug)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();

    if (!row) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);
    if (row.current_version !== input.parent_version) {
      throw new VersionConflictError(
        input.ref.type,
        input.ref.slug,
        row.current_version,
        input.parent_version
      );
    }

    const now = Date.now();
    await this.db
      .updateTable('entries')
      .set({ deleted_at: now })
      .where('id', '=', row.id)
      .execute();

    return {
      id: new Uint8Array(row.id),
      type: input.ref.type,
      slug: input.ref.slug,
      deleted_at: now
    };
  }

  async createAsset(input: CreateAssetInput): Promise<AssetWrite> {
    const assetId = uuidv7Bytes();
    const refKey = uuidv7Bytes();
    const now = Date.now();
    const backend = this.assetBackends.default();
    const meta: AssetMeta = {
      ...(input.meta ?? {}),
      size: input.bytes.byteLength
    };

    const storageRef = await backend.put({
      assetId,
      version: 1,
      bytes: input.bytes,
      ...(meta.mime !== undefined ? { mime: meta.mime } : {})
    });

    const envId = this.envIdBuf();
    const initialTags = normalizeTags(input.tags ?? []);

    await this.db.transaction().execute(async (tx) => {
      await tx
        .insertInto('assets')
        .values({
          id: Buffer.from(assetId),
          env_id: envId,
          kind: input.kind,
          current_version: 1,
          published_version: null,
          deleted_at: null
        })
        .execute();

      await tx
        .insertInto('asset_versions')
        .values({
          asset_id: Buffer.from(assetId),
          version: 1,
          storage_ref: storageRef,
          meta: JSON.stringify(meta),
          parent_version: null,
          author: input.author ?? null,
          created_at: now,
          ref_key: Buffer.from(refKey)
        })
        .execute();

      if (initialTags.length > 0) {
        const resolved = await this.resolveOrCreateTags(tx, envId, initialTags);
        await this.attachAssetTags(tx, envId, Buffer.from(assetId), resolved.map((r) => r.id));
      }
    });

    return {
      id: assetId,
      version: 1,
      kind: input.kind,
      storage_ref: storageRef,
      meta,
      ref_key: refKey
    };
  }

  async updateAsset(input: UpdateAssetInput): Promise<AssetWrite> {
    const envId = this.envIdBuf();
    const idBuf = Buffer.from(input.id);

    const cur = await this.db
      .selectFrom('assets')
      .select(['kind', 'current_version', 'deleted_at'])
      .where('env_id', '=', envId)
      .where('id', '=', idBuf)
      .executeTakeFirst();
    if (!cur || cur.deleted_at !== null) {
      throw new NotFoundError('asset', Buffer.from(input.id).toString('hex'));
    }
    if (cur.current_version !== input.parent_version) {
      throw new VersionConflictError(
        'asset',
        Buffer.from(input.id).toString('hex'),
        cur.current_version,
        input.parent_version
      );
    }

    const prevMetaRow = await this.db
      .selectFrom('asset_versions')
      .select('meta')
      .where('asset_id', '=', idBuf)
      .where('version', '=', cur.current_version)
      .executeTakeFirst();
    const prevMeta = prevMetaRow ? (JSON.parse(prevMetaRow.meta) as AssetMeta) : {};

    const baseMeta: AssetMeta = input.meta !== undefined ? input.meta : prevMeta;
    const meta: AssetMeta = { ...baseMeta, size: input.bytes.byteLength };

    const refKey = uuidv7Bytes();
    const newVersion = cur.current_version + 1;
    const now = Date.now();
    const backend = this.assetBackends.default();
    const storageRef = await backend.put({
      assetId: input.id,
      version: newVersion,
      bytes: input.bytes,
      ...(meta.mime !== undefined ? { mime: meta.mime } : {})
    });

    await this.db.transaction().execute(async (tx) => {
      const recheck = await tx
        .selectFrom('assets')
        .select('current_version')
        .where('env_id', '=', envId)
        .where('id', '=', idBuf)
        .executeTakeFirst();
      if (!recheck || recheck.current_version !== input.parent_version) {
        throw new VersionConflictError(
          'asset',
          Buffer.from(input.id).toString('hex'),
          recheck?.current_version ?? -1,
          input.parent_version
        );
      }

      await tx
        .insertInto('asset_versions')
        .values({
          asset_id: idBuf,
          version: newVersion,
          storage_ref: storageRef,
          meta: JSON.stringify(meta),
          parent_version: cur.current_version,
          author: input.author ?? null,
          created_at: now,
          ref_key: Buffer.from(refKey)
        })
        .execute();

      await tx
        .updateTable('assets')
        .set({ current_version: newVersion })
        .where('id', '=', idBuf)
        .execute();
    });

    return {
      id: new Uint8Array(input.id),
      version: newVersion,
      kind: cur.kind,
      storage_ref: storageRef,
      meta,
      ref_key: refKey
    };
  }

  async findAssetByRefKey(refKey: Uint8Array): Promise<AssetDetail | null> {
    const envId = this.envIdBuf();
    const row = await this.db
      .selectFrom('asset_versions as av')
      .innerJoin('assets as a', 'a.id', 'av.asset_id')
      .select([
        'a.id as id',
        'a.kind as kind',
        'a.current_version as current_version',
        'a.published_version as published_version',
        'a.deleted_at as deleted_at',
        'av.version as version',
        'av.storage_ref as storage_ref',
        'av.meta as meta',
        'av.author as author',
        'av.created_at as created_at',
        'av.ref_key as ref_key'
      ])
      .where('a.env_id', '=', envId)
      .where('av.ref_key', '=', Buffer.from(refKey))
      .executeTakeFirst();
    if (!row) return null;
    const tags = (await this.fetchAssetTags(envId, [row.id])).get(row.id.toString('hex')) ?? [];
    return {
      id: new Uint8Array(row.id),
      kind: row.kind,
      current_version: row.current_version,
      published_version: row.published_version,
      deleted_at: row.deleted_at,
      version: row.version,
      storage_ref: row.storage_ref,
      meta: JSON.parse(row.meta) as AssetMeta,
      author: row.author,
      created_at: row.created_at,
      ref_key: new Uint8Array(row.ref_key),
      tags
    };
  }

  async getAsset(
    id: Uint8Array,
    opts?: { version?: number }
  ): Promise<AssetDetail | null> {
    const envId = this.envIdBuf();
    const idBuf = Buffer.from(id);
    const versionMatch = opts?.version !== undefined ? opts.version : null;

    let q = this.db
      .selectFrom('assets as a')
      .innerJoin('asset_versions as av', (join) => {
        if (versionMatch !== null) {
          return join.onRef('av.asset_id', '=', 'a.id').on('av.version', '=', versionMatch);
        }
        return join
          .onRef('av.asset_id', '=', 'a.id')
          .onRef('av.version', '=', 'a.current_version');
      })
      .select([
        'a.kind as kind',
        'a.current_version as current_version',
        'a.published_version as published_version',
        'a.deleted_at as deleted_at',
        'av.version as version',
        'av.storage_ref as storage_ref',
        'av.meta as meta',
        'av.author as author',
        'av.created_at as created_at',
        'av.ref_key as ref_key'
      ])
      .where('a.env_id', '=', envId)
      .where('a.id', '=', idBuf);

    const row = await q.executeTakeFirst();
    if (!row) return null;

    const tags = (await this.fetchAssetTags(envId, [idBuf])).get(idBuf.toString('hex')) ?? [];
    return {
      id: new Uint8Array(id),
      kind: row.kind,
      current_version: row.current_version,
      published_version: row.published_version,
      deleted_at: row.deleted_at,
      version: row.version,
      storage_ref: row.storage_ref,
      meta: JSON.parse(row.meta) as AssetMeta,
      author: row.author,
      created_at: row.created_at,
      ref_key: new Uint8Array(row.ref_key),
      tags
    };
  }

  async listAssets(input?: ListAssetsInput): Promise<ListAssetsResult> {
    const envId = this.envIdBuf();
    const limit = input?.limit ?? 50;
    const offset = input?.offset ?? 0;

    const tagSlugs = input?.tags ? normalizeTags(input.tags).map((t) => t.slug) : [];

    const buildBase = (countOnly: boolean) => {
      let q = this.db
        .selectFrom('assets as a')
        .innerJoin('asset_versions as av', (join) =>
          join.onRef('av.asset_id', '=', 'a.id').onRef('av.version', '=', 'a.current_version')
        )
        .where('a.env_id', '=', envId);

      if (input?.kind !== undefined) q = q.where('a.kind', '=', input.kind);
      if (input?.includeDeleted !== true) q = q.where('a.deleted_at', 'is', null);

      if (tagSlugs.length > 0) {
        const sub = this.db
          .selectFrom('asset_tags as at')
          .innerJoin('tags as t', 't.id', 'at.tag_id')
          .select((eb) => eb.ref('at.asset_id').as('asset_id'))
          .where('at.env_id', '=', envId)
          .where('t.slug', 'in', tagSlugs)
          .groupBy('at.asset_id')
          .having((eb) => eb.fn.count('t.slug').distinct(), '=', tagSlugs.length);
        q = q.where('a.id', 'in', sub);
      }

      if (countOnly) {
        return q.select(({ fn }) => fn.countAll<number>().as('c'));
      }

      return q
        .select([
          'a.id as id',
          'a.kind as kind',
          'a.current_version as current_version',
          'a.published_version as published_version',
          'a.deleted_at as deleted_at',
          'av.storage_ref as storage_ref',
          'av.meta as meta',
          'av.created_at as created_at',
          'av.ref_key as ref_key'
        ])
        .orderBy('av.created_at', 'desc')
        .limit(limit)
        .offset(offset);
    };

    const rows = (await buildBase(false).execute()) as Array<{
      id: Buffer;
      kind: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
      storage_ref: string;
      meta: string;
      created_at: number;
      ref_key: Buffer;
    }>;

    const countRow = (await buildBase(true).executeTakeFirst()) as { c: number } | undefined;
    const total = Number(countRow?.c ?? 0);

    const tagsByAsset = await this.fetchAssetTags(envId, rows.map((r) => r.id));

    return {
      results: rows.map((r) => ({
        id: new Uint8Array(r.id),
        kind: r.kind,
        current_version: r.current_version,
        published_version: r.published_version,
        deleted_at: r.deleted_at,
        storage_ref: r.storage_ref,
        meta: JSON.parse(r.meta) as AssetMeta,
        created_at: r.created_at,
        ref_key: new Uint8Array(r.ref_key),
        tags: tagsByAsset.get(r.id.toString('hex')) ?? []
      })),
      total,
      offset
    };
  }

  async readAssetBytes(id: Uint8Array, opts?: { version?: number }): Promise<Buffer> {
    const asset = await this.getAsset(id, opts);
    if (!asset) throw new NotFoundError('asset', Buffer.from(id).toString('hex'));
    const backend = this.assetBackends.resolve(asset.storage_ref);
    const { bytes } = await backend.get(asset.storage_ref);
    return bytes;
  }

  // -------------------- API keys --------------------

  async createApiKey(input: CreateApiKeyInput): Promise<{ id: Uint8Array; created_at: number }> {
    const id = uuidv7Bytes();
    const created_at = Date.now();
    await this.db
      .insertInto('api_keys')
      .values({
        id: Buffer.from(id),
        env_id: this.envIdBuf(),
        role: input.role,
        label: input.label ?? null,
        key_hash: Buffer.from(input.key_hash),
        key_prefix: input.key_prefix,
        created_at,
        last_used_at: null,
        revoked_at: null
      })
      .execute();
    return { id, created_at };
  }

  async findApiKeyByHash(hash: Uint8Array): Promise<ApiKeyLookup | null> {
    const row = await this.db
      .selectFrom('api_keys')
      .select(['id', 'role', 'label', 'revoked_at'])
      .where('key_hash', '=', Buffer.from(hash))
      .executeTakeFirst();
    if (!row) return null;
    return {
      id: new Uint8Array(row.id),
      role: row.role,
      label: row.label,
      revoked_at: row.revoked_at
    };
  }

  async listApiKeys(opts?: { includeRevoked?: boolean }): Promise<ApiKeyRow[]> {
    let q = this.db
      .selectFrom('api_keys')
      .select(['id', 'role', 'label', 'key_prefix', 'created_at', 'last_used_at', 'revoked_at'])
      .where('env_id', '=', this.envIdBuf())
      .orderBy('created_at', 'desc');
    if (opts?.includeRevoked !== true) q = q.where('revoked_at', 'is', null);
    const rows = await q.execute();
    return rows.map((r) => ({
      id: new Uint8Array(r.id),
      role: r.role,
      label: r.label,
      key_prefix: r.key_prefix,
      created_at: r.created_at,
      last_used_at: r.last_used_at,
      revoked_at: r.revoked_at
    }));
  }

  async revokeApiKey(id: Uint8Array): Promise<{ revoked_at: number } | null> {
    const revoked_at = Date.now();
    const idBuf = Buffer.from(id);
    const updated = await this.db
      .updateTable('api_keys')
      .set({ revoked_at })
      .where('id', '=', idBuf)
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    if (Number(updated.numUpdatedRows ?? 0) > 0) {
      return { revoked_at };
    }
    // Either no such id, or already revoked. Distinguish.
    const existing = await this.db
      .selectFrom('api_keys')
      .select('revoked_at')
      .where('id', '=', idBuf)
      .executeTakeFirst();
    if (!existing) return null;
    return { revoked_at: existing.revoked_at ?? revoked_at };
  }

  async markApiKeyUsed(id: Uint8Array, at: number): Promise<void> {
    // Debounced — only write when previous touch is more than 60s old.
    await this.db
      .updateTable('api_keys')
      .set({ last_used_at: at })
      .where('id', '=', Buffer.from(id))
      .where((eb) =>
        eb.or([eb('last_used_at', 'is', null), eb('last_used_at', '<', at - 60_000)])
      )
      .execute();
  }

  async countActiveApiKeys(): Promise<number> {
    const row = await this.db
      .selectFrom('api_keys')
      .select(({ fn }) => fn.countAll<number>().as('n'))
      .where('env_id', '=', this.envIdBuf())
      .where('revoked_at', 'is', null)
      .executeTakeFirst();
    return Number(row?.n ?? 0);
  }

  // -------------------- Tags --------------------

  /**
   * Resolve normalized tag inputs to existing tag rows, creating any
   * that don't exist yet. Existing rows keep their original label.
   */
  private async resolveOrCreateTags(
    tx: Kysely<Database>,
    envId: Buffer,
    inputs: readonly { slug: string; label: string }[]
  ): Promise<{ id: Buffer; slug: string; label: string }[]> {
    if (inputs.length === 0) return [];
    const out: { id: Buffer; slug: string; label: string }[] = [];
    for (const t of inputs) {
      const row = await tx
        .selectFrom('tags')
        .select(['id', 'label'])
        .where('env_id', '=', envId)
        .where('slug', '=', t.slug)
        .executeTakeFirst();
      if (row) {
        out.push({ id: row.id, slug: t.slug, label: row.label });
      } else {
        const id = uuidv7Bytes();
        const idBuf = Buffer.from(id);
        await tx
          .insertInto('tags')
          .values({
            id: idBuf,
            env_id: envId,
            slug: t.slug,
            label: t.label,
            created_at: Date.now()
          })
          .execute();
        out.push({ id: idBuf, slug: t.slug, label: t.label });
      }
    }
    return out;
  }

  /** Ignore-on-conflict insert into entry_tags. Dialect-aware. */
  private async attachEntryTags(
    tx: Kysely<Database>,
    envId: Buffer,
    entryId: Buffer,
    tagIds: readonly Buffer[]
  ): Promise<void> {
    if (tagIds.length === 0) return;
    const rows = tagIds.map((tag_id) => ({ env_id: envId, entry_id: entryId, tag_id }));
    await this.upsertIgnore(tx, 'entry_tags', rows);
  }

  /** Ignore-on-conflict insert into asset_tags. Dialect-aware. */
  private async attachAssetTags(
    tx: Kysely<Database>,
    envId: Buffer,
    assetId: Buffer,
    tagIds: readonly Buffer[]
  ): Promise<void> {
    if (tagIds.length === 0) return;
    const rows = tagIds.map((tag_id) => ({ env_id: envId, asset_id: assetId, tag_id }));
    await this.upsertIgnore(tx, 'asset_tags', rows);
  }

  /**
   * Cross-dialect "insert, ignore on duplicate primary key". Kysely's
   * onConflict() works for SQLite + Postgres, but MySQL needs the
   * `INSERT IGNORE` form via the `.ignore()` modifier.
   */
  private async upsertIgnore<TName extends 'entry_tags' | 'asset_tags'>(
    tx: Kysely<Database>,
    table: TName,
    rows: ReadonlyArray<Database[TName]>
  ): Promise<void> {
    if (this.dialect === 'mysql') {
      await tx.insertInto(table).ignore().values(rows as never).execute();
      return;
    }
    // SQLite + Postgres
    await tx
      .insertInto(table)
      .values(rows as never)
      .onConflict((oc) => oc.doNothing())
      .execute();
  }

  private async lookupTagIdsBySlug(envId: Buffer, slugs: readonly string[]): Promise<Buffer[]> {
    if (slugs.length === 0) return [];
    const rows = await this.db
      .selectFrom('tags')
      .select('id')
      .where('env_id', '=', envId)
      .where('slug', 'in', slugs as string[])
      .execute();
    return rows.map((r) => r.id);
  }

  private async fetchAssetTags(
    envId: Buffer,
    assetIds: readonly Buffer[]
  ): Promise<Map<string, TagInfo[]>> {
    const out = new Map<string, TagInfo[]>();
    if (assetIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('asset_tags as at')
      .innerJoin('tags as t', 't.id', 'at.tag_id')
      .select(['at.asset_id as asset_id', 't.slug as slug', 't.label as label'])
      .where('at.env_id', '=', envId)
      .where('at.asset_id', 'in', assetIds as Buffer[])
      .orderBy(caseInsensitive(sql.ref('t.label')), 'asc')
      .execute();
    for (const r of rows) {
      const key = r.asset_id.toString('hex');
      const list = out.get(key) ?? [];
      list.push({ slug: r.slug, label: r.label });
      out.set(key, list);
    }
    return out;
  }

  private async fetchEntryTags(
    envId: Buffer,
    entryIds: readonly Buffer[]
  ): Promise<Map<string, TagInfo[]>> {
    const out = new Map<string, TagInfo[]>();
    if (entryIds.length === 0) return out;
    const rows = await this.db
      .selectFrom('entry_tags as et')
      .innerJoin('tags as t', 't.id', 'et.tag_id')
      .select(['et.entry_id as entry_id', 't.slug as slug', 't.label as label'])
      .where('et.env_id', '=', envId)
      .where('et.entry_id', 'in', entryIds as Buffer[])
      .orderBy(caseInsensitive(sql.ref('t.label')), 'asc')
      .execute();
    for (const r of rows) {
      const key = r.entry_id.toString('hex');
      const list = out.get(key) ?? [];
      list.push({ slug: r.slug, label: r.label });
      out.set(key, list);
    }
    return out;
  }

  async addAssetTags(assetId: Uint8Array, inputs: readonly string[]): Promise<TagInfo[]> {
    const normalized = normalizeTags(inputs);
    const envId = this.envIdBuf();
    const idBuf = Buffer.from(assetId);

    return await this.db.transaction().execute(async (tx) => {
      const exists = await tx
        .selectFrom('assets')
        .select('id')
        .where('env_id', '=', envId)
        .where('id', '=', idBuf)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!exists) {
        throw new NotFoundError('asset', Buffer.from(assetId).toString('hex'));
      }
      if (normalized.length > 0) {
        const tags = await this.resolveOrCreateTags(tx, envId, normalized);
        await this.attachAssetTags(tx, envId, idBuf, tags.map((t) => t.id));
      }
      const rows = await tx
        .selectFrom('asset_tags as at')
        .innerJoin('tags as t', 't.id', 'at.tag_id')
        .select(['t.slug as slug', 't.label as label'])
        .where('at.env_id', '=', envId)
        .where('at.asset_id', '=', idBuf)
        .orderBy(caseInsensitive(sql.ref('t.label')), 'asc')
        .execute();
      return rows.map((r) => ({ slug: r.slug, label: r.label }));
    });
  }

  async removeAssetTags(assetId: Uint8Array, inputs: readonly string[]): Promise<number> {
    const normalized = normalizeTags(inputs);
    if (normalized.length === 0) return 0;
    const envId = this.envIdBuf();
    const tagIds = await this.lookupTagIdsBySlug(envId, normalized.map((n) => n.slug));
    if (tagIds.length === 0) return 0;
    const result = await this.db
      .deleteFrom('asset_tags')
      .where('env_id', '=', envId)
      .where('asset_id', '=', Buffer.from(assetId))
      .where('tag_id', 'in', tagIds)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async getAssetTags(assetId: Uint8Array): Promise<TagInfo[]> {
    const envId = this.envIdBuf();
    const idBuf = Buffer.from(assetId);
    return (await this.fetchAssetTags(envId, [idBuf])).get(idBuf.toString('hex')) ?? [];
  }

  async addEntryTags(entryId: Uint8Array, inputs: readonly string[]): Promise<TagInfo[]> {
    const normalized = normalizeTags(inputs);
    const envId = this.envIdBuf();
    const idBuf = Buffer.from(entryId);

    return await this.db.transaction().execute(async (tx) => {
      const exists = await tx
        .selectFrom('entries')
        .select('id')
        .where('env_id', '=', envId)
        .where('id', '=', idBuf)
        .where('deleted_at', 'is', null)
        .executeTakeFirst();
      if (!exists) {
        throw new NotFoundError('entry', Buffer.from(entryId).toString('hex'));
      }
      if (normalized.length > 0) {
        const tags = await this.resolveOrCreateTags(tx, envId, normalized);
        await this.attachEntryTags(tx, envId, idBuf, tags.map((t) => t.id));
      }
      const rows = await tx
        .selectFrom('entry_tags as et')
        .innerJoin('tags as t', 't.id', 'et.tag_id')
        .select(['t.slug as slug', 't.label as label'])
        .where('et.env_id', '=', envId)
        .where('et.entry_id', '=', idBuf)
        .orderBy(caseInsensitive(sql.ref('t.label')), 'asc')
        .execute();
      return rows.map((r) => ({ slug: r.slug, label: r.label }));
    });
  }

  async removeEntryTags(entryId: Uint8Array, inputs: readonly string[]): Promise<number> {
    const normalized = normalizeTags(inputs);
    if (normalized.length === 0) return 0;
    const envId = this.envIdBuf();
    const tagIds = await this.lookupTagIdsBySlug(envId, normalized.map((n) => n.slug));
    if (tagIds.length === 0) return 0;
    const result = await this.db
      .deleteFrom('entry_tags')
      .where('env_id', '=', envId)
      .where('entry_id', '=', Buffer.from(entryId))
      .where('tag_id', 'in', tagIds)
      .executeTakeFirst();
    return Number(result.numDeletedRows ?? 0);
  }

  async getEntryTags(entryId: Uint8Array): Promise<TagInfo[]> {
    const envId = this.envIdBuf();
    const idBuf = Buffer.from(entryId);
    return (await this.fetchEntryTags(envId, [idBuf])).get(idBuf.toString('hex')) ?? [];
  }

  async listTags(): Promise<TagWithCounts[]> {
    const envId = this.envIdBuf();
    // Counts are filtered to non-deleted assets/entries — a tag attached
    // only to deleted things shows zero.
    const assetSub = sql<number>`COALESCE((
      SELECT COUNT(*) FROM asset_tags at
      JOIN assets a ON a.id = at.asset_id
      WHERE at.env_id = t.env_id AND at.tag_id = t.id AND a.deleted_at IS NULL
    ), 0)`;
    const entrySub = sql<number>`COALESCE((
      SELECT COUNT(*) FROM entry_tags et
      JOIN entries e ON e.id = et.entry_id
      WHERE et.env_id = t.env_id AND et.tag_id = t.id AND e.deleted_at IS NULL
    ), 0)`;

    const rows = await this.db
      .selectFrom('tags as t')
      .select([
        't.slug as slug',
        't.label as label',
        assetSub.as('asset_uses'),
        entrySub.as('entry_uses')
      ])
      .where('t.env_id', '=', envId)
      .orderBy(sql`(${assetSub} + ${entrySub})`, 'desc')
      .orderBy(caseInsensitive(sql.ref('t.label')), 'asc')
      .execute();

    return rows.map((r) => ({
      slug: r.slug,
      label: r.label,
      asset_uses: Number(r.asset_uses),
      entry_uses: Number(r.entry_uses)
    }));
  }

  async updateTag(slug: string, label: string): Promise<TagInfo | null> {
    const newLabel = normalizeTag(label);
    if (newLabel === null) {
      throw new Error(`updateTag: invalid label "${label}"`);
    }
    const envId = this.envIdBuf();
    const result = await this.db
      .updateTable('tags')
      .set({ label: newLabel.label })
      .where('env_id', '=', envId)
      .where('slug', '=', slug)
      .executeTakeFirst();
    if (Number(result.numUpdatedRows ?? 0) === 0) return null;
    return { slug, label: newLabel.label };
  }

  // ───────────────── full-text search ─────────────────

  /**
   * Load the current TypeDef from type_versions for the given type_id.
   * Used by the FTS sync hooks to discover which fields are searchable.
   * Returns null when the type is missing — callers fall through to a
   * no-op rather than failing the whole entry write on a stale FK race.
   */
  private async loadCurrentTypeDef(
    tx: Kysely<Database>,
    typeId: Buffer
  ): Promise<TypeDef | null> {
    const row = await tx
      .selectFrom('types as t')
      .innerJoin('type_versions as tv', (join) =>
        join.onRef('tv.type_id', '=', 't.id').onRef('tv.version', '=', 't.current_version')
      )
      .select(['tv.definition'])
      .where('t.id', '=', typeId)
      .executeTakeFirst();
    if (!row) return null;
    try {
      return JSON.parse(row.definition) as TypeDef;
    } catch {
      return null;
    }
  }

  /**
   * Walk the type's fields and the entry's content, returning one
   * fts_entries row per (searchable field, locale). Pure function — no
   * DB calls. The default-locale value gets locale='' so non-locale-
   * scoped queries always find it; per-locale overrides on a localized
   * field get their tag verbatim.
   *
   * v1 limitation: only top-level string/markdown fields are indexed.
   * searchable:true on a field nested inside an array or object is
   * accepted at defineType but ignored here.
   */
  private extractFtsRows(
    typeDef: TypeDef,
    content: Record<string, unknown>
  ): Array<{ field_name: string; locale: string; value: string }> {
    const out: Array<{ field_name: string; locale: string; value: string }> = [];
    const localeOverrides = (content._locale ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
    for (const [fieldName, fieldDef] of Object.entries(typeDef.fields)) {
      if ((fieldDef as { searchable?: boolean }).searchable !== true) continue;
      if (fieldDef.type !== 'string' && fieldDef.type !== 'markdown') continue;
      const baseValue = content[fieldName];
      if (typeof baseValue === 'string' && baseValue.length > 0) {
        out.push({ field_name: fieldName, locale: '', value: baseValue });
      }
      if (fieldDef.localized === true) {
        for (const [locale, fieldsByLocale] of Object.entries(localeOverrides)) {
          if (fieldsByLocale === null || typeof fieldsByLocale !== 'object') continue;
          const v = (fieldsByLocale as Record<string, unknown>)[fieldName];
          if (typeof v === 'string' && v.length > 0) {
            out.push({ field_name: fieldName, locale, value: v });
          }
        }
      }
    }
    return out;
  }

  /**
   * Replace the FTS rows for an entry. Always called in the same
   * transaction as the parent entry write so an aborted entry write
   * leaves no partial index. Empty content (no searchable fields, no
   * values) is fine — we just delete and don't re-insert.
   */
  private async syncFtsRows(
    tx: Kysely<Database>,
    entryId: Buffer,
    typeName: string,
    typeId: Buffer,
    content: Record<string, unknown>
  ): Promise<void> {
    await tx.deleteFrom('fts_entries').where('entry_id', '=', entryId).execute();
    const typeDef = await this.loadCurrentTypeDef(tx, typeId);
    if (!typeDef) return;
    const rows = this.extractFtsRows(typeDef, content);
    if (rows.length === 0) return;
    await tx
      .insertInto('fts_entries')
      .values(
        rows.map((r) => ({
          entry_id: entryId,
          type: typeName,
          field_name: r.field_name,
          locale: r.locale,
          value: r.value
        }))
      )
      .execute();
  }

  /**
   * Full-text search across one type (or all types when type is omitted).
   * Dialect-specific FTS syntax — sqlite uses MATCH on the FTS5 virtual
   * table, postgres uses tsvector @@ tsquery, mysql uses MATCH...AGAINST.
   * Rank ordering is normalised: results come back highest-relevance
   * first regardless of dialect.
   */
  async searchEntries(input: {
    q: string;
    type?: string;
    tags?: readonly string[];
    locale?: string;
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
    published?: boolean;
  }): Promise<{ results: EntryDetail[]; total: number; offset: number }> {
    const envId = this.envIdBuf();
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    const tagSlugs = input.tags ? normalizeTags(input.tags).map((t) => t.slug) : [];

    // Dialect-specific match + rank expressions. We collapse multi-field
    // matches to one row per entry by GROUP BY + the highest rank seen.
    // matchExpr is typed `sql<boolean>` so Kysely's .where() accepts it
    // as an OperandExpression<SqlBool>.
    let matchExpr: ReturnType<typeof sql<boolean>>;
    let rankExpr: ReturnType<typeof sql<number>>;
    let rankDir: 'asc' | 'desc';
    switch (this.dialect) {
      case 'sqlite':
        // SQLite FTS5: bm25() is an auxiliary function. It takes the
        // FTS5 table reference but parses the argument as a column ref
        // unless the table appears UNALIASED in FROM. So we leave
        // fts_entries un-aliased throughout this query.
        matchExpr = sql<boolean>`fts_entries.value MATCH ${input.q}`;
        rankExpr = sql<number>`bm25(fts_entries)`;
        rankDir = 'asc';
        break;
      case 'postgres':
        matchExpr = sql<boolean>`fts_entries.ts @@ plainto_tsquery('simple', ${input.q})`;
        rankExpr = sql<number>`ts_rank(fts_entries.ts, plainto_tsquery('simple', ${input.q}))`;
        rankDir = 'desc';
        break;
      case 'mysql': {
        // BOOLEAN MODE chosen over NATURAL LANGUAGE MODE because NL has
        // a "50% rule": a word appearing in >=50% of indexed rows is
        // treated as a stop word and matches nothing. Tiny datasets
        // (test fixtures, freshly-seeded production tables) hit this
        // surprise constantly. BOOLEAN MODE has no such rule.
        //
        // Operator characters in BOOLEAN MODE (+ - * ~ < > @ ( ) ")
        // would re-interpret a plain user query as syntax, so we strip
        // them out — replace each with a space so adjacent tokens stay
        // word-separated.
        const cleaned = input.q.replace(/[+\-*~<>@()"]/g, ' ');
        matchExpr = sql<boolean>`MATCH(fts_entries.value) AGAINST (${cleaned} IN BOOLEAN MODE)`;
        rankExpr = sql<number>`MATCH(fts_entries.value) AGAINST (${cleaned} IN BOOLEAN MODE)`;
        rankDir = 'desc';
        break;
      }
    }

    // Two-step approach: pull matching FTS rows first, then filter and
    // paginate in JS. Cleaner across dialects than fighting SQLite FTS5's
    // restrictions on bm25 inside aggregate functions, and the result
    // sets for FTS queries are typically small enough that in-memory
    // dedupe is fine for v1.

    // Step 1: dialect-specific FTS-only query — returns (entry_id, rank).
    // Filtered by locale here too because fts_entries.locale lives on
    // this table; everything else (env / type / tags / deleted_at)
    // happens against the entries table in step 2.
    const ftsMatches = await this.db
      .selectFrom('fts_entries')
      .where(matchExpr)
      .$if(input.locale !== undefined, (qb) => {
        const loc = input.locale as string;
        return qb.where((eb) =>
          eb.or([eb('fts_entries.locale', '=', loc), eb('fts_entries.locale', '=', '')])
        );
      })
      .select(['fts_entries.entry_id as entry_id', rankExpr.as('rank')])
      .execute();

    if (ftsMatches.length === 0) {
      return { results: [], total: 0, offset };
    }

    // Step 2: collapse to one rank per entry_id (best rank wins).
    const bestRank = new Map<string, { id: Buffer; rank: number }>();
    for (const m of ftsMatches) {
      const key = (m.entry_id as Buffer).toString('hex');
      const existing = bestRank.get(key);
      if (existing === undefined) {
        bestRank.set(key, { id: m.entry_id as Buffer, rank: Number(m.rank) });
        continue;
      }
      const better =
        rankDir === 'asc' ? Number(m.rank) < existing.rank : Number(m.rank) > existing.rank;
      if (better) existing.rank = Number(m.rank);
    }

    // Step 3: filter the matched ids through the entries table to apply
    // env / type / tags / deleted_at. Returns the subset of ids that
    // survive — order doesn't matter here since we re-sort by rank below.
    let filterQuery = this.db
      .selectFrom('entries as e')
      .where('e.env_id', '=', envId)
      .where(
        'e.id',
        'in',
        Array.from(bestRank.values()).map((v) => v.id)
      );
    if (input.includeDeleted !== true) {
      filterQuery = filterQuery.where('e.deleted_at', 'is', null);
    }
    if (input.published === true) {
      filterQuery = filterQuery.where('e.published_version', 'is not', null);
    }
    if (input.type !== undefined) {
      const typeRow = await this.requireTypeId(input.type);
      filterQuery = filterQuery.where('e.type_id', '=', typeRow.id);
    }
    if (tagSlugs.length > 0) {
      const tagSubquery = this.db
        .selectFrom('entry_tags as et')
        .innerJoin('tags as t', 't.id', 'et.tag_id')
        .select((eb) => eb.ref('et.entry_id').as('entry_id'))
        .where('et.env_id', '=', envId)
        .where('t.slug', 'in', tagSlugs)
        .groupBy('et.entry_id')
        .having((eb) => eb.fn.count('t.slug').distinct(), '=', tagSlugs.length);
      filterQuery = filterQuery.where('e.id', 'in', tagSubquery);
    }
    const allowedRows = await filterQuery.select(['e.id as id']).execute();
    const allowed = new Set(allowedRows.map((r) => (r.id as Buffer).toString('hex')));

    // Step 4: order by rank, paginate.
    const sorted = Array.from(bestRank.values())
      .filter((v) => allowed.has(v.id.toString('hex')))
      .sort((a, b) => (rankDir === 'asc' ? a.rank - b.rank : b.rank - a.rank));
    const total = sorted.length;
    const page = sorted.slice(offset, offset + limit);

    if (page.length === 0) {
      return { results: [], total, offset };
    }

    const ranked = page.map((p) => ({ id: p.id, rank: p.rank }));

    if (ranked.length === 0) {
      return { results: [], total, offset };
    }

    // Hydrate full EntryDetail rows. Ordering preserved via a Map.
    const idOrder = ranked.map((r) => r.id);
    const orderById = new Map<string, number>();
    idOrder.forEach((id, i) => orderById.set(id.toString('hex'), i));

    const detailRows = await this.db
      .selectFrom('entries as e')
      .innerJoin('types as t', 't.id', 'e.type_id')
      .innerJoin('entry_versions as ev', (join) =>
        input.published === true
          ? join
              .onRef('ev.entry_id', '=', 'e.id')
              .onRef('ev.version', '=', 'e.published_version')
          : join
              .onRef('ev.entry_id', '=', 'e.id')
              .onRef('ev.version', '=', 'e.current_version')
      )
      .select([
        'e.id as id',
        't.name as type',
        'e.slug as slug',
        'e.current_version as current_version',
        'e.published_version as published_version',
        'e.deleted_at as deleted_at',
        'ev.version as version',
        'ev.content as content',
        'ev.schema_version as schema_version',
        'ev.content_hash as content_hash',
        'ev.created_at as created_at'
      ])
      .where(
        'e.id',
        'in',
        idOrder.map((id) => Buffer.from(id))
      )
      .execute();

    const tagMap = await this.fetchEntryTags(envId, idOrder.map((id) => Buffer.from(id)));

    const results: EntryDetail[] = detailRows
      .map((r) => ({
        id: new Uint8Array(r.id),
        type: r.type,
        slug: r.slug,
        current_version: r.current_version,
        published_version: r.published_version,
        deleted_at: r.deleted_at,
        version: r.version,
        content: JSON.parse(r.content) as Record<string, unknown>,
        schema_version: r.schema_version,
        content_hash: new Uint8Array(r.content_hash),
        created_at: r.created_at,
        tags: tagMap.get(Buffer.from(r.id).toString('hex')) ?? []
      }))
      .sort(
        (a, b) =>
          (orderById.get(Buffer.from(a.id).toString('hex')) ?? 0) -
          (orderById.get(Buffer.from(b.id).toString('hex')) ?? 0)
      );

    return { results, total, offset };
  }

  async close(): Promise<void> {
    await this.db.destroy();
  }
}
