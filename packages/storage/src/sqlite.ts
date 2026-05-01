import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
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
  AssetSummary,
  AssetWrite,
  ListAssetsInput,
  ListAssetsResult,
  TagInfo,
  TagWithCounts
} from './types.js';
import { migrations } from './migrations.js';
import { uuidv7Bytes } from './uuid.js';
import { contentHash } from './hash.js';
import { normalizeTag, normalizeTags } from './tags.js';
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

export interface OpenOptions {
  path: string;
  assets?: AssetsConfig;
}

export class SqliteStorage implements Storage {
  readonly db: BetterSqliteDatabase;
  readonly assetBackends: AssetBackendRegistry;
  private mainEnvId!: Uint8Array;

  static async open(opts: OpenOptions): Promise<SqliteStorage> {
    const db = new Database(opts.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    const storage = new SqliteStorage(db);
    storage.migrate();
    storage.bootstrapMainEnv();
    storage.configureAssetBackends(opts.assets);
    return storage;
  }

  private constructor(db: BetterSqliteDatabase) {
    this.db = db;
    this.assetBackends = new AssetBackendRegistry();
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

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id         INTEGER PRIMARY KEY,
        name       TEXT    NOT NULL UNIQUE,
        applied_at INTEGER NOT NULL
      ) STRICT;
    `);

    const selectApplied = this.db.prepare<[], { id: number }>(
      'SELECT id FROM _migrations'
    );
    const applied = new Set(selectApplied.all().map((r) => r.id));

    const insertApplied = this.db.prepare(
      'INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)'
    );

    for (const migration of migrations) {
      if (applied.has(migration.id)) continue;
      const tx = this.db.transaction(() => {
        this.db.exec(migration.sql);
        insertApplied.run(migration.id, migration.name, Date.now());
      });
      tx();
    }
  }

  private bootstrapMainEnv(): void {
    const row = this.db
      .prepare<[string], { id: Buffer }>('SELECT id FROM envs WHERE name = ?')
      .get(MAIN_ENV_NAME);

    if (row) {
      this.mainEnvId = new Uint8Array(row.id);
      return;
    }

    const id = uuidv7Bytes();
    this.db
      .prepare('INSERT INTO envs (id, name, parent_id, created_at) VALUES (?, ?, NULL, ?)')
      .run(id, MAIN_ENV_NAME, Date.now());
    this.mainEnvId = id;
  }

  async createType(input: CreateTypeInput): Promise<CreateTypeResult> {
    const { definition, author } = input;
    const envId = this.mainEnvId;
    const existing = this.db
      .prepare<[Buffer, string], { id: Buffer; current_version: number }>(
        'SELECT id, current_version FROM types WHERE env_id = ? AND name = ? AND deleted_at IS NULL'
      )
      .get(Buffer.from(envId), definition.name);

    if (existing) {
      throw new Error(
        `createType: type "${definition.name}" already exists (current version ${existing.current_version}). Use alter_type to evolve.`
      );
    }

    const typeId = uuidv7Bytes();
    const now = Date.now();
    const definitionJson = JSON.stringify(definition);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO types (id, env_id, name, current_version, published_version, deleted_at)
           VALUES (?, ?, ?, 1, NULL, NULL)`
        )
        .run(typeId, envId, definition.name);

      this.db
        .prepare(
          `INSERT INTO type_versions
             (type_id, version, definition, change_class, parent_version, author, created_at)
           VALUES (?, 1, ?, 'safe', NULL, ?, ?)`
        )
        .run(typeId, definitionJson, author ?? null, now);
    });
    tx();

    return { id: typeId, name: definition.name, version: 1 };
  }

  async alterType(input: import('./types.js').AlterTypeInput): Promise<import('./types.js').AlterTypeResult> {
    const envId = Buffer.from(this.mainEnvId);

    const row = this.db
      .prepare<[Buffer, string], { id: Buffer; current_version: number }>(
        'SELECT id, current_version FROM types WHERE env_id = ? AND name = ? AND deleted_at IS NULL'
      )
      .get(envId, input.name);
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

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO type_versions
             (type_id, version, definition, change_class, parent_version, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          row.id,
          nextVersion,
          definitionJson,
          input.change_class,
          row.current_version,
          input.author ?? null,
          now
        );

      this.db
        .prepare('UPDATE types SET current_version = ? WHERE id = ?')
        .run(nextVersion, row.id);
    });
    tx();

    return {
      id: new Uint8Array(row.id),
      name: input.name,
      version: nextVersion,
      change_class: input.change_class
    };
  }

  async listTypes(opts?: { includeDeleted?: boolean }): Promise<TypeSummary[]> {
    const includeDeleted = opts?.includeDeleted === true;
    const envId = Buffer.from(this.mainEnvId);

    interface Row {
      id: Buffer;
      name: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
    }

    const rows = includeDeleted
      ? this.db
          .prepare<[Buffer], Row>(
            'SELECT id, name, current_version, published_version, deleted_at FROM types WHERE env_id = ? ORDER BY name'
          )
          .all(envId)
      : this.db
          .prepare<[Buffer], Row>(
            'SELECT id, name, current_version, published_version, deleted_at FROM types WHERE env_id = ? AND deleted_at IS NULL ORDER BY name'
          )
          .all(envId);

    return rows.map((r) => ({
      id: new Uint8Array(r.id),
      name: r.name,
      current_version: r.current_version,
      published_version: r.published_version,
      deleted_at: r.deleted_at
    }));
  }

  async getType(name: string): Promise<TypeDetail | null> {
    const envId = Buffer.from(this.mainEnvId);

    interface Row {
      id: Buffer;
      name: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
      definition: string;
    }

    const row = this.db
      .prepare<[Buffer, string], Row>(
        `SELECT t.id, t.name, t.current_version, t.published_version, t.deleted_at,
                tv.definition
         FROM types t
         JOIN type_versions tv
           ON tv.type_id = t.id AND tv.version = t.current_version
         WHERE t.env_id = ? AND t.name = ?`
      )
      .get(envId, name);

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

  private requireTypeId(name: string): { id: Uint8Array; current_version: number } {
    const row = this.db
      .prepare<[Buffer, string], { id: Buffer; current_version: number }>(
        'SELECT id, current_version FROM types WHERE env_id = ? AND name = ? AND deleted_at IS NULL'
      )
      .get(Buffer.from(this.mainEnvId), name);
    if (!row) throw new NotFoundError('type', name);
    return { id: new Uint8Array(row.id), current_version: row.current_version };
  }

  async createEntry(input: CreateEntryInput): Promise<EntryWrite> {
    const typeRow = this.requireTypeId(input.type);
    const entryId = uuidv7Bytes();
    const now = Date.now();
    const hash = contentHash(input.content);
    const contentJson = JSON.stringify(input.content);
    const localeSlugs = input.locale_slugs ?? {};
    const hasLocaleSlugs = Object.keys(localeSlugs).length > 0;
    const envId = Buffer.from(this.mainEnvId);
    const initialTags = normalizeTags(input.tags ?? []);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entries (id, env_id, type_id, slug, current_version, published_version, deleted_at)
           VALUES (?, ?, ?, ?, 1, NULL, NULL)`
        )
        .run(entryId, this.mainEnvId, typeRow.id, input.slug);

      this.db
        .prepare(
          `INSERT INTO entry_versions
             (entry_id, version, content, schema_version, content_hash, parent_version, author, created_at)
           VALUES (?, 1, ?, ?, ?, NULL, ?, ?)`
        )
        .run(entryId, contentJson, input.schema_version, hash, input.author ?? null, now);

      if (hasLocaleSlugs) {
        const insert = this.db.prepare(
          `INSERT INTO entries_slugs (env_id, type_id, locale, slug, entry_id)
           VALUES (?, ?, ?, ?, ?)`
        );
        for (const [locale, slug] of Object.entries(localeSlugs)) {
          insert.run(this.mainEnvId, Buffer.from(typeRow.id), locale, slug, entryId);
        }
      }

      if (initialTags.length > 0) {
        const resolved = this.resolveOrCreateTags(envId, initialTags);
        const ins = this.db.prepare(
          `INSERT OR IGNORE INTO entry_tags (env_id, entry_id, tag_id) VALUES (?, ?, ?)`
        );
        for (const t of resolved) ins.run(envId, Buffer.from(entryId), Buffer.from(t.id));
      }
    });
    tx();

    return { id: entryId, type: input.type, slug: input.slug, version: 1 };
  }

  async updateEntry(input: UpdateEntryInput): Promise<EntryWrite> {
    const typeRow = this.requireTypeId(input.ref.type);

    const row = this.db
      .prepare<[Buffer, Buffer, string], { id: Buffer; current_version: number }>(
        `SELECT id, current_version FROM entries
         WHERE env_id = ? AND type_id = ? AND slug = ? AND deleted_at IS NULL`
      )
      .get(Buffer.from(this.mainEnvId), Buffer.from(typeRow.id), input.ref.slug);

    if (!row) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);

    if (row.current_version !== input.parent_version) {
      throw new VersionConflictError(
        input.ref.type,
        input.ref.slug,
        row.current_version,
        input.parent_version
      );
    }

    const entryId = new Uint8Array(row.id);
    const nextVersion = row.current_version + 1;
    const now = Date.now();
    const hash = contentHash(input.content);
    const contentJson = JSON.stringify(input.content);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO entry_versions
             (entry_id, version, content, schema_version, content_hash, parent_version, author, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          entryId,
          nextVersion,
          contentJson,
          input.schema_version,
          hash,
          row.current_version,
          input.author ?? null,
          now
        );

      this.db
        .prepare('UPDATE entries SET current_version = ? WHERE id = ?')
        .run(nextVersion, entryId);

      // locale_slugs === undefined means "don't touch routing"; an empty
      // map or populated map replaces the entry's per-locale slugs.
      if (input.locale_slugs !== undefined) {
        this.db
          .prepare('DELETE FROM entries_slugs WHERE entry_id = ?')
          .run(Buffer.from(entryId));
        const insert = this.db.prepare(
          `INSERT INTO entries_slugs (env_id, type_id, locale, slug, entry_id)
           VALUES (?, ?, ?, ?, ?)`
        );
        for (const [locale, slug] of Object.entries(input.locale_slugs)) {
          insert.run(
            this.mainEnvId,
            Buffer.from(typeRow.id),
            locale,
            slug,
            Buffer.from(entryId)
          );
        }
      }
    });
    tx();

    return { id: entryId, type: input.ref.type, slug: input.ref.slug, version: nextVersion };
  }

  async readEntry(
    ref: EntryRef,
    opts?: { version?: number; locale?: string }
  ): Promise<EntryDetail | null> {
    const envId = Buffer.from(this.mainEnvId);
    const locale = opts?.locale;

    // Locale-aware lookup path: try entries_slugs(locale, slug) first when
    // a locale is supplied. Falls through to the default-locale entries.slug
    // path below — consumers can read via either the localized slug OR the
    // default slug + project.
    if (locale !== undefined) {
      const localeRow = this.db
        .prepare<[Buffer, string, string, string], { entry_id: Buffer; current_slug: string }>(
          `SELECT es.entry_id, e.slug AS current_slug
           FROM entries_slugs es
           JOIN types t  ON t.id  = es.type_id
           JOIN entries e ON e.id = es.entry_id
           WHERE es.env_id = ? AND t.name = ? AND es.locale = ? AND es.slug = ?
             AND e.deleted_at IS NULL`
        )
        .get(envId, ref.type, locale, ref.slug);
      if (localeRow) {
        const resolved = this.readEntryDirect(
          { type: ref.type, slug: localeRow.current_slug },
          opts
        );
        if (resolved) return resolved;
      }
    }

    const direct = this.readEntryDirect(ref, opts);
    if (direct !== null) return direct;

    // Fall through: is this a retired slug for some entry of this type? Honour
    // locale: a retired FR slug only matches when the reader asks for FR
    // (or unspecified, which we treat as "any locale" for back-compat).
    const retired = locale !== undefined
      ? this.db
          .prepare<[Buffer, string, string, string], { entry_id: Buffer }>(
            `SELECT h.entry_id FROM slug_history h
             JOIN types t ON t.id = h.type_id
             WHERE h.env_id = ? AND t.name = ? AND h.slug = ? AND h.locale = ?
             ORDER BY h.retired_at DESC LIMIT 1`
          )
          .get(envId, ref.type, ref.slug, locale)
      : this.db
          .prepare<[Buffer, string, string], { entry_id: Buffer }>(
            `SELECT h.entry_id FROM slug_history h
             JOIN types t ON t.id = h.type_id
             WHERE h.env_id = ? AND t.name = ? AND h.slug = ?
             ORDER BY h.retired_at DESC LIMIT 1`
          )
          .get(envId, ref.type, ref.slug);

    if (!retired) return null;

    const currentRow = this.db
      .prepare<[Buffer], { slug: string; deleted_at: number | null }>(
        'SELECT slug, deleted_at FROM entries WHERE id = ?'
      )
      .get(retired.entry_id);

    if (!currentRow || currentRow.deleted_at !== null) return null;

    // For non-default-locale renames, look up the entry's current locale slug
    // to surface in the redirect target.
    let redirectTo = currentRow.slug;
    if (locale !== undefined) {
      const currentLocaleSlug = this.db
        .prepare<[Buffer, string], { slug: string }>(
          'SELECT slug FROM entries_slugs WHERE entry_id = ? AND locale = ?'
        )
        .get(retired.entry_id, locale);
      if (currentLocaleSlug) redirectTo = currentLocaleSlug.slug;
    }

    const resolved = this.readEntryDirect(
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

  private readEntryDirect(
    ref: EntryRef,
    opts?: { version?: number }
  ): EntryDetail | null {
    const envId = Buffer.from(this.mainEnvId);

    interface JoinRow {
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
    }

    // Direct reads always exclude soft-deleted entries — the slug-history
    // fallback (in readEntry) is what handles "the slug used to point at
    // this entry, but it was renamed". A deleted entry has neither a
    // current row nor a retired-slug pointer, so callers see null.
    const row = opts?.version !== undefined
      ? this.db
          .prepare<[number, Buffer, string, string], JoinRow>(
            `SELECT e.id, e.slug, e.current_version, e.published_version, e.deleted_at,
                    ev.version, ev.content, ev.schema_version, ev.content_hash, ev.created_at
             FROM entries e
             JOIN types t ON t.id = e.type_id
             JOIN entry_versions ev ON ev.entry_id = e.id AND ev.version = ?
             WHERE e.env_id = ? AND t.name = ? AND e.slug = ? AND e.deleted_at IS NULL`
          )
          .get(opts.version, envId, ref.type, ref.slug)
      : this.db
          .prepare<[Buffer, string, string], JoinRow>(
            `SELECT e.id, e.slug, e.current_version, e.published_version, e.deleted_at,
                    ev.version, ev.content, ev.schema_version, ev.content_hash, ev.created_at
             FROM entries e
             JOIN types t ON t.id = e.type_id
             JOIN entry_versions ev ON ev.entry_id = e.id AND ev.version = e.current_version
             WHERE e.env_id = ? AND t.name = ? AND e.slug = ? AND e.deleted_at IS NULL`
          )
          .get(envId, ref.type, ref.slug);

    if (!row) return null;

    const tags = this.fetchEntryTags(envId, [row.id]).get(row.id.toString('hex')) ?? [];
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

  async renameEntry(input: import('./types.js').RenameEntryInput): Promise<import('./types.js').RenameEntryResult> {
    const typeRow = this.requireTypeId(input.ref.type);
    const envId = Buffer.from(this.mainEnvId);
    const localeArg = input.locale ?? null;

    let entryId: Buffer;
    if (input.locale === undefined) {
      // Default-locale (or non-localized) rename — look up via entries.slug.
      const entryRow = this.db
        .prepare<[Buffer, Buffer, string], { id: Buffer }>(
          `SELECT id FROM entries
           WHERE env_id = ? AND type_id = ? AND slug = ? AND deleted_at IS NULL`
        )
        .get(envId, Buffer.from(typeRow.id), input.ref.slug);
      if (!entryRow) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);
      entryId = entryRow.id;
    } else {
      // Non-default-locale rename — look up via entries_slugs.
      const localeRow = this.db
        .prepare<[Buffer, Buffer, string, string], { entry_id: Buffer }>(
          `SELECT entry_id FROM entries_slugs
           WHERE env_id = ? AND type_id = ? AND locale = ? AND slug = ?`
        )
        .get(envId, Buffer.from(typeRow.id), input.locale, input.ref.slug);
      if (!localeRow) {
        throw new NotFoundError(
          'entry',
          `${input.ref.type}/${input.ref.slug}@${input.locale}`
        );
      }
      entryId = localeRow.entry_id;
    }

    if (input.new_slug === input.ref.slug) {
      return {
        id: new Uint8Array(entryId),
        type: input.ref.type,
        old_slug: input.ref.slug,
        new_slug: input.new_slug,
        locale: localeArg,
        retired_at: Date.now()
      };
    }

    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          'INSERT INTO slug_history (env_id, slug, type_id, entry_id, retired_at, locale) VALUES (?, ?, ?, ?, ?, ?)'
        )
        .run(envId, input.ref.slug, Buffer.from(typeRow.id), entryId, now, localeArg);

      if (input.locale === undefined) {
        this.db
          .prepare('UPDATE entries SET slug = ? WHERE id = ?')
          .run(input.new_slug, entryId);
      } else {
        this.db
          .prepare(
            `UPDATE entries_slugs SET slug = ?
             WHERE env_id = ? AND type_id = ? AND locale = ? AND slug = ?`
          )
          .run(
            input.new_slug,
            envId,
            Buffer.from(typeRow.id),
            input.locale,
            input.ref.slug
          );
      }
    });
    tx();

    return {
      id: new Uint8Array(entryId),
      type: input.ref.type,
      old_slug: input.ref.slug,
      new_slug: input.new_slug,
      locale: localeArg,
      retired_at: now
    };
  }

  async findEntries(input: FindEntriesInput): Promise<FindEntriesResult> {
    const typeRow = this.requireTypeId(input.type);
    const envId = Buffer.from(this.mainEnvId);
    const limit = input.limit ?? 20;
    const offset = input.offset ?? 0;
    const where = input.where ?? {};

    // Build dynamic WHERE for top-level fields via json_extract.
    const whereFragments: string[] = [];
    const whereParams: unknown[] = [];
    for (const [field, value] of Object.entries(where)) {
      whereFragments.push(`json_extract(ev.content, '$.' || ?) = ?`);
      whereParams.push(field, value);
    }

    // Deleted filter
    const deletedClause = input.includeDeleted ? '' : 'AND e.deleted_at IS NULL';

    // Tag filter — must have ALL of the provided tags (matched by slug).
    const tagSlugs = input.tags
      ? normalizeTags(input.tags).map((t) => t.slug)
      : [];
    let tagFilter = '';
    const tagParams: unknown[] = [];
    if (tagSlugs.length > 0) {
      const placeholders = tagSlugs.map(() => '?').join(',');
      tagFilter = ` AND e.id IN (
        SELECT et.entry_id FROM entry_tags et
        JOIN tags t ON t.id = et.tag_id
        WHERE et.env_id = e.env_id AND t.slug IN (${placeholders})
        GROUP BY et.entry_id
        HAVING COUNT(DISTINCT t.slug) = ?
      )`;
      tagParams.push(...tagSlugs, tagSlugs.length);
    }

    // Order
    let orderClause = 'ORDER BY ev.created_at DESC';
    if (input.order && input.order.length > 0) {
      const parts = input.order.map((o) => {
        const dir = o.dir === 'asc' ? 'ASC' : 'DESC';
        return `json_extract(ev.content, '$.' || '${o.field.replace(/'/g, "''")}') ${dir}`;
      });
      orderClause = `ORDER BY ${parts.join(', ')}`;
    }

    const whereSql = whereFragments.length > 0 ? `AND ${whereFragments.join(' AND ')}` : '';

    interface JoinRow {
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
    }

    const selectSql = `
      SELECT e.id, e.slug, e.current_version, e.published_version, e.deleted_at,
             ev.version, ev.content, ev.schema_version, ev.content_hash, ev.created_at
      FROM entries e
      JOIN entry_versions ev ON ev.entry_id = e.id AND ev.version = e.current_version
      WHERE e.env_id = ? AND e.type_id = ? ${deletedClause} ${whereSql}${tagFilter}
      ${orderClause}
      LIMIT ? OFFSET ?
    `;

    const rows = this.db
      .prepare<unknown[], JoinRow>(selectSql)
      .all(envId, Buffer.from(typeRow.id), ...whereParams, ...tagParams, limit, offset);

    const countSql = `
      SELECT COUNT(*) AS c
      FROM entries e
      JOIN entry_versions ev ON ev.entry_id = e.id AND ev.version = e.current_version
      WHERE e.env_id = ? AND e.type_id = ? ${deletedClause} ${whereSql}${tagFilter}
    `;

    const countRow = this.db
      .prepare<unknown[], { c: number }>(countSql)
      .get(envId, Buffer.from(typeRow.id), ...whereParams, ...tagParams);

    const total = countRow?.c ?? 0;
    const tagsByEntry = this.fetchEntryTags(envId, rows.map((r) => r.id));

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
    const typeRow = this.requireTypeId(input.ref.type);
    const envId = Buffer.from(this.mainEnvId);

    const row = this.db
      .prepare<[Buffer, Buffer, string], { id: Buffer; current_version: number }>(
        `SELECT id, current_version FROM entries
         WHERE env_id = ? AND type_id = ? AND slug = ? AND deleted_at IS NULL`
      )
      .get(envId, Buffer.from(typeRow.id), input.ref.slug);

    if (!row) throw new NotFoundError('entry', `${input.ref.type}/${input.ref.slug}`);

    const targetVersion = input.version ?? row.current_version;

    // Ensure the target version exists.
    const versionRow = this.db
      .prepare<[Buffer, number], { version: number }>(
        'SELECT version FROM entry_versions WHERE entry_id = ? AND version = ?'
      )
      .get(row.id, targetVersion);

    if (!versionRow) {
      throw new NotFoundError(
        'entry',
        `${input.ref.type}/${input.ref.slug}@v${targetVersion}`
      );
    }

    this.db
      .prepare('UPDATE entries SET published_version = ? WHERE id = ?')
      .run(targetVersion, row.id);

    return {
      id: new Uint8Array(row.id),
      type: input.ref.type,
      slug: input.ref.slug,
      version: targetVersion
    };
  }

  async deleteType(input: import('./types.js').DeleteTypeInput): Promise<import('./types.js').DeleteTypeResult> {
    const envId = Buffer.from(this.mainEnvId);
    // Atomic: ensure not already deleted, version match, optional cascade,
    // then mark deleted_at. better-sqlite3's transaction wrapper keeps
    // the steps consistent across read + write.
    const tx = this.db.transaction((): import('./types.js').DeleteTypeResult => {
      const typeRow = this.db
        .prepare<[Buffer, string], { id: Buffer; current_version: number; deleted_at: number | null }>(
          'SELECT id, current_version, deleted_at FROM types WHERE env_id = ? AND name = ?'
        )
        .get(envId, input.name);
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

      const liveCount = this.db
        .prepare<[Buffer, Buffer], { n: number }>(
          'SELECT COUNT(*) AS n FROM entries WHERE env_id = ? AND type_id = ? AND deleted_at IS NULL'
        )
        .get(envId, typeRow.id)?.n ?? 0;

      let entries_deleted = 0;
      if (liveCount > 0) {
        if (input.cascade !== true) {
          throw new TypeNotEmptyError(input.name, liveCount);
        }
        const now = Date.now();
        const info = this.db
          .prepare(
            'UPDATE entries SET deleted_at = ? WHERE env_id = ? AND type_id = ? AND deleted_at IS NULL'
          )
          .run(now, envId, typeRow.id);
        entries_deleted = info.changes;
      }

      const now = Date.now();
      this.db
        .prepare('UPDATE types SET deleted_at = ? WHERE id = ?')
        .run(now, typeRow.id);

      return { name: input.name, deleted_at: now, entries_deleted };
    });
    return tx();
  }

  async deleteEntry(input: import('./types.js').DeleteEntryInput): Promise<import('./types.js').DeleteEntryResult> {
    const typeRow = this.requireTypeId(input.ref.type);
    const envId = Buffer.from(this.mainEnvId);

    const row = this.db
      .prepare<[Buffer, Buffer, string], { id: Buffer; current_version: number }>(
        `SELECT id, current_version FROM entries
         WHERE env_id = ? AND type_id = ? AND slug = ? AND deleted_at IS NULL`
      )
      .get(envId, Buffer.from(typeRow.id), input.ref.slug);

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
    this.db
      .prepare('UPDATE entries SET deleted_at = ? WHERE id = ?')
      .run(now, row.id);

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

    const envId = Buffer.from(this.mainEnvId);
    const initialTags = normalizeTags(input.tags ?? []);

    const tx = this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO assets (id, env_id, kind, current_version, published_version, deleted_at)
           VALUES (?, ?, ?, 1, NULL, NULL)`
        )
        .run(assetId, this.mainEnvId, input.kind);

      this.db
        .prepare(
          `INSERT INTO asset_versions
             (asset_id, version, storage_ref, meta, parent_version, author, created_at, ref_key)
           VALUES (?, 1, ?, ?, NULL, ?, ?, ?)`
        )
        .run(assetId, storageRef, JSON.stringify(meta), input.author ?? null, now, Buffer.from(refKey));

      if (initialTags.length > 0) {
        const resolved = this.resolveOrCreateTags(envId, initialTags);
        const ins = this.db.prepare(
          `INSERT OR IGNORE INTO asset_tags (env_id, asset_id, tag_id) VALUES (?, ?, ?)`
        );
        for (const t of resolved) ins.run(envId, Buffer.from(assetId), Buffer.from(t.id));
      }
    });
    tx();

    return {
      id: assetId,
      version: 1,
      kind: input.kind,
      storage_ref: storageRef,
      meta,
      ref_key: refKey
    };
  }

  async updateAsset(input: import('./types.js').UpdateAssetInput): Promise<AssetWrite> {
    const envId = Buffer.from(this.mainEnvId);
    const idBuf = Buffer.from(input.id);

    // Resolve current state outside the transaction so we can talk to
    // the asset backend (which may do IO) before locking the DB.
    const cur = this.db
      .prepare<[Buffer, Buffer], { kind: string; current_version: number; deleted_at: number | null }>(
        'SELECT kind, current_version, deleted_at FROM assets WHERE env_id = ? AND id = ?'
      )
      .get(envId, idBuf);
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

    // Carry meta forward unless the caller supplied a replacement.
    const prevMetaRow = this.db
      .prepare<[Buffer, number], { meta: string }>(
        'SELECT meta FROM asset_versions WHERE asset_id = ? AND version = ?'
      )
      .get(idBuf, cur.current_version);
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

    const tx = this.db.transaction(() => {
      // Re-check inside the transaction so two concurrent updates can't
      // both bump from the same parent_version.
      const recheck = this.db
        .prepare<[Buffer, Buffer], { current_version: number }>(
          'SELECT current_version FROM assets WHERE env_id = ? AND id = ?'
        )
        .get(envId, idBuf);
      if (!recheck || recheck.current_version !== input.parent_version) {
        throw new VersionConflictError(
          'asset',
          Buffer.from(input.id).toString('hex'),
          recheck?.current_version ?? -1,
          input.parent_version
        );
      }
      this.db
        .prepare(
          `INSERT INTO asset_versions
             (asset_id, version, storage_ref, meta, parent_version, author, created_at, ref_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          idBuf,
          newVersion,
          storageRef,
          JSON.stringify(meta),
          cur.current_version,
          input.author ?? null,
          now,
          Buffer.from(refKey)
        );
      this.db
        .prepare('UPDATE assets SET current_version = ? WHERE id = ?')
        .run(newVersion, idBuf);
    });
    tx();

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
    const envId = Buffer.from(this.mainEnvId);
    interface JoinRow {
      id: Buffer;
      kind: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
      version: number;
      storage_ref: string;
      meta: string;
      author: string | null;
      created_at: number;
      ref_key: Buffer;
    }
    const row = this.db
      .prepare<[Buffer, Buffer], JoinRow>(
        `SELECT a.id, a.kind, a.current_version, a.published_version, a.deleted_at,
                av.version, av.storage_ref, av.meta, av.author, av.created_at, av.ref_key
         FROM asset_versions av
         JOIN assets a ON a.id = av.asset_id
         WHERE a.env_id = ? AND av.ref_key = ?`
      )
      .get(envId, Buffer.from(refKey));
    if (!row) return null;
    const tags = this.fetchAssetTags(envId, [row.id]).get(row.id.toString('hex')) ?? [];
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
    const envId = Buffer.from(this.mainEnvId);

    interface JoinRow {
      kind: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
      version: number;
      storage_ref: string;
      meta: string;
      author: string | null;
      created_at: number;
      ref_key: Buffer;
    }

    const row = opts?.version !== undefined
      ? this.db
          .prepare<[number, Buffer, Buffer], JoinRow>(
            `SELECT a.kind, a.current_version, a.published_version, a.deleted_at,
                    av.version, av.storage_ref, av.meta, av.author, av.created_at, av.ref_key
             FROM assets a
             JOIN asset_versions av ON av.asset_id = a.id AND av.version = ?
             WHERE a.env_id = ? AND a.id = ?`
          )
          .get(opts.version, envId, Buffer.from(id))
      : this.db
          .prepare<[Buffer, Buffer], JoinRow>(
            `SELECT a.kind, a.current_version, a.published_version, a.deleted_at,
                    av.version, av.storage_ref, av.meta, av.author, av.created_at, av.ref_key
             FROM assets a
             JOIN asset_versions av ON av.asset_id = a.id AND av.version = a.current_version
             WHERE a.env_id = ? AND a.id = ?`
          )
          .get(envId, Buffer.from(id));

    if (!row) return null;

    const tags = this.fetchAssetTags(envId, [Buffer.from(id)]).get(
      Buffer.from(id).toString('hex')
    ) ?? [];

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
    const envId = Buffer.from(this.mainEnvId);
    const limit = input?.limit ?? 50;
    const offset = input?.offset ?? 0;
    const kindFilter = input?.kind !== undefined ? ' AND a.kind = ?' : '';
    const deletedFilter = input?.includeDeleted === true ? '' : ' AND a.deleted_at IS NULL';

    // Tag filter — must have ALL of the provided tags. Inputs are
    // normalized so case/whitespace/leading-# variants all match.
    const tagSlugs = input?.tags
      ? normalizeTags(input.tags).map((t) => t.slug)
      : [];
    let tagFilter = '';
    const tagParams: unknown[] = [];
    if (tagSlugs.length > 0) {
      const placeholders = tagSlugs.map(() => '?').join(',');
      tagFilter = ` AND a.id IN (
        SELECT at.asset_id FROM asset_tags at
        JOIN tags t ON t.id = at.tag_id
        WHERE at.env_id = a.env_id AND t.slug IN (${placeholders})
        GROUP BY at.asset_id
        HAVING COUNT(DISTINCT t.slug) = ?
      )`;
      tagParams.push(...tagSlugs, tagSlugs.length);
    }

    interface Row {
      id: Buffer;
      kind: string;
      current_version: number;
      published_version: number | null;
      deleted_at: number | null;
      storage_ref: string;
      meta: string;
      created_at: number;
      ref_key: Buffer;
    }

    const params: unknown[] = [envId];
    if (input?.kind !== undefined) params.push(input.kind);
    params.push(...tagParams);
    params.push(limit, offset);

    const rows = this.db
      .prepare<unknown[], Row>(
        `SELECT a.id, a.kind, a.current_version, a.published_version, a.deleted_at,
                av.storage_ref, av.meta, av.created_at, av.ref_key
         FROM assets a
         JOIN asset_versions av ON av.asset_id = a.id AND av.version = a.current_version
         WHERE a.env_id = ?${kindFilter}${deletedFilter}${tagFilter}
         ORDER BY av.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(...params);

    const countParams: unknown[] = [envId];
    if (input?.kind !== undefined) countParams.push(input.kind);
    countParams.push(...tagParams);

    const countRow = this.db
      .prepare<unknown[], { c: number }>(
        `SELECT COUNT(*) AS c FROM assets a WHERE a.env_id = ?${kindFilter}${deletedFilter}${tagFilter}`
      )
      .get(...countParams);

    const tagsByAsset = this.fetchAssetTags(envId, rows.map((r) => r.id));

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
      total: countRow?.c ?? 0,
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

  async createApiKey(input: import('./types.js').CreateApiKeyInput): Promise<{ id: Uint8Array; created_at: number }> {
    const id = uuidv7Bytes();
    const created_at = Date.now();
    this.db
      .prepare(
        `INSERT INTO api_keys (id, env_id, role, label, key_hash, key_prefix, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        Buffer.from(id),
        Buffer.from(this.mainEnvId),
        input.role,
        input.label ?? null,
        Buffer.from(input.key_hash),
        input.key_prefix,
        created_at
      );
    return { id, created_at };
  }

  async findApiKeyByHash(hash: Uint8Array): Promise<import('./types.js').ApiKeyLookup | null> {
    const row = this.db
      .prepare<[Buffer], { id: Buffer; role: 'admin' | 'reader'; label: string | null; revoked_at: number | null }>(
        `SELECT id, role, label, revoked_at FROM api_keys WHERE key_hash = ?`
      )
      .get(Buffer.from(hash));
    if (!row) return null;
    return {
      id: new Uint8Array(row.id),
      role: row.role,
      label: row.label,
      revoked_at: row.revoked_at
    };
  }

  async listApiKeys(opts?: { includeRevoked?: boolean }): Promise<import('./types.js').ApiKeyRow[]> {
    const stmt = opts?.includeRevoked === true
      ? `SELECT id, role, label, key_prefix, created_at, last_used_at, revoked_at
         FROM api_keys WHERE env_id = ? ORDER BY created_at DESC`
      : `SELECT id, role, label, key_prefix, created_at, last_used_at, revoked_at
         FROM api_keys WHERE env_id = ? AND revoked_at IS NULL ORDER BY created_at DESC`;
    const rows = this.db
      .prepare<[Buffer], { id: Buffer; role: 'admin' | 'reader'; label: string | null; key_prefix: string; created_at: number; last_used_at: number | null; revoked_at: number | null }>(
        stmt
      )
      .all(Buffer.from(this.mainEnvId));
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
    const info = this.db
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`
      )
      .run(revoked_at, Buffer.from(id));
    if (info.changes === 0) {
      // Either no such id, or already revoked. Distinguish.
      const exists = this.db
        .prepare<[Buffer], { revoked_at: number | null }>(
          `SELECT revoked_at FROM api_keys WHERE id = ?`
        )
        .get(Buffer.from(id));
      if (!exists) return null;
      return { revoked_at: exists.revoked_at ?? revoked_at };
    }
    return { revoked_at };
  }

  /**
   * Update last_used_at. Debounced — we only write when the previous
   * touch is more than 60s old, so a busy server isn't doing one DB
   * write per authenticated request.
   */
  async markApiKeyUsed(id: Uint8Array, at: number): Promise<void> {
    this.db
      .prepare(
        `UPDATE api_keys SET last_used_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
      )
      .run(at, Buffer.from(id), at - 60_000);
  }

  async countActiveApiKeys(): Promise<number> {
    const row = this.db
      .prepare<[Buffer], { n: number }>(
        `SELECT COUNT(*) AS n FROM api_keys WHERE env_id = ? AND revoked_at IS NULL`
      )
      .get(Buffer.from(this.mainEnvId));
    return row?.n ?? 0;
  }

  // -------------------- Tags --------------------

  /**
   * Resolve normalized tag inputs to existing tag rows, creating any
   * that don't exist yet. Existing rows keep their original label —
   * later writes don't relabel automatically. Returns the resolved tag
   * rows in input order, with their canonical label (existing or new).
   */
  private resolveOrCreateTags(
    envId: Buffer,
    inputs: readonly { slug: string; label: string }[]
  ): { id: Uint8Array; slug: string; label: string }[] {
    if (inputs.length === 0) return [];
    const findStmt = this.db.prepare<[Buffer, string], { id: Buffer; label: string }>(
      'SELECT id, label FROM tags WHERE env_id = ? AND slug = ?'
    );
    const insertStmt = this.db.prepare(
      `INSERT INTO tags (id, env_id, slug, label, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const out: { id: Uint8Array; slug: string; label: string }[] = [];
    for (const t of inputs) {
      const row = findStmt.get(envId, t.slug);
      if (row) {
        out.push({ id: new Uint8Array(row.id), slug: t.slug, label: row.label });
      } else {
        const id = uuidv7Bytes();
        insertStmt.run(Buffer.from(id), envId, t.slug, t.label, Date.now());
        out.push({ id, slug: t.slug, label: t.label });
      }
    }
    return out;
  }

  /** Slug-only lookup of tag ids — used by `removeXTags` and the filter path. */
  private lookupTagIdsBySlug(envId: Buffer, slugs: readonly string[]): Buffer[] {
    if (slugs.length === 0) return [];
    const placeholders = slugs.map(() => '?').join(',');
    const rows = this.db
      .prepare<unknown[], { id: Buffer }>(
        `SELECT id FROM tags WHERE env_id = ? AND slug IN (${placeholders})`
      )
      .all(envId, ...slugs);
    return rows.map((r) => r.id);
  }

  /** Tags currently attached to a given asset, sorted by label asc. */
  private fetchAssetTags(envId: Buffer, assetIds: readonly Buffer[]): Map<string, TagInfo[]> {
    const out = new Map<string, TagInfo[]>();
    if (assetIds.length === 0) return out;
    const placeholders = assetIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<unknown[], { asset_id: Buffer; slug: string; label: string }>(
        `SELECT at.asset_id, t.slug, t.label
         FROM asset_tags at
         JOIN tags t ON t.id = at.tag_id
         WHERE at.env_id = ? AND at.asset_id IN (${placeholders})
         ORDER BY t.label COLLATE NOCASE ASC`
      )
      .all(envId, ...assetIds);
    for (const r of rows) {
      const key = r.asset_id.toString('hex');
      const list = out.get(key) ?? [];
      list.push({ slug: r.slug, label: r.label });
      out.set(key, list);
    }
    return out;
  }

  /** Tags currently attached to a given entry, sorted by label asc. */
  private fetchEntryTags(envId: Buffer, entryIds: readonly Buffer[]): Map<string, TagInfo[]> {
    const out = new Map<string, TagInfo[]>();
    if (entryIds.length === 0) return out;
    const placeholders = entryIds.map(() => '?').join(',');
    const rows = this.db
      .prepare<unknown[], { entry_id: Buffer; slug: string; label: string }>(
        `SELECT et.entry_id, t.slug, t.label
         FROM entry_tags et
         JOIN tags t ON t.id = et.tag_id
         WHERE et.env_id = ? AND et.entry_id IN (${placeholders})
         ORDER BY t.label COLLATE NOCASE ASC`
      )
      .all(envId, ...entryIds);
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
    if (normalized.length === 0) return [];
    const envId = Buffer.from(this.mainEnvId);
    const idBuf = Buffer.from(assetId);

    return this.db.transaction((): TagInfo[] => {
      const exists = this.db
        .prepare<[Buffer, Buffer], { ok: number }>(
          'SELECT 1 AS ok FROM assets WHERE env_id = ? AND id = ? AND deleted_at IS NULL'
        )
        .get(envId, idBuf);
      if (!exists) {
        throw new NotFoundError('asset', Buffer.from(assetId).toString('hex'));
      }
      const tags = this.resolveOrCreateTags(envId, normalized);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO asset_tags (env_id, asset_id, tag_id) VALUES (?, ?, ?)`
      );
      for (const t of tags) ins.run(envId, idBuf, Buffer.from(t.id));
      return tags.map((t) => ({ slug: t.slug, label: t.label }));
    })();
  }

  async removeAssetTags(assetId: Uint8Array, inputs: readonly string[]): Promise<number> {
    const normalized = normalizeTags(inputs);
    if (normalized.length === 0) return 0;
    const envId = Buffer.from(this.mainEnvId);
    const tagIds = this.lookupTagIdsBySlug(envId, normalized.map((n) => n.slug));
    if (tagIds.length === 0) return 0;
    const placeholders = tagIds.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `DELETE FROM asset_tags WHERE env_id = ? AND asset_id = ? AND tag_id IN (${placeholders})`
      )
      .run(envId, Buffer.from(assetId), ...tagIds);
    return result.changes;
  }

  async getAssetTags(assetId: Uint8Array): Promise<TagInfo[]> {
    const envId = Buffer.from(this.mainEnvId);
    return this.fetchAssetTags(envId, [Buffer.from(assetId)]).get(
      Buffer.from(assetId).toString('hex')
    ) ?? [];
  }

  async addEntryTags(entryId: Uint8Array, inputs: readonly string[]): Promise<TagInfo[]> {
    const normalized = normalizeTags(inputs);
    if (normalized.length === 0) return [];
    const envId = Buffer.from(this.mainEnvId);
    const idBuf = Buffer.from(entryId);

    return this.db.transaction((): TagInfo[] => {
      const exists = this.db
        .prepare<[Buffer, Buffer], { ok: number }>(
          'SELECT 1 AS ok FROM entries WHERE env_id = ? AND id = ? AND deleted_at IS NULL'
        )
        .get(envId, idBuf);
      if (!exists) {
        throw new NotFoundError('entry', Buffer.from(entryId).toString('hex'));
      }
      const tags = this.resolveOrCreateTags(envId, normalized);
      const ins = this.db.prepare(
        `INSERT OR IGNORE INTO entry_tags (env_id, entry_id, tag_id) VALUES (?, ?, ?)`
      );
      for (const t of tags) ins.run(envId, idBuf, Buffer.from(t.id));
      return tags.map((t) => ({ slug: t.slug, label: t.label }));
    })();
  }

  async removeEntryTags(entryId: Uint8Array, inputs: readonly string[]): Promise<number> {
    const normalized = normalizeTags(inputs);
    if (normalized.length === 0) return 0;
    const envId = Buffer.from(this.mainEnvId);
    const tagIds = this.lookupTagIdsBySlug(envId, normalized.map((n) => n.slug));
    if (tagIds.length === 0) return 0;
    const placeholders = tagIds.map(() => '?').join(',');
    const result = this.db
      .prepare(
        `DELETE FROM entry_tags WHERE env_id = ? AND entry_id = ? AND tag_id IN (${placeholders})`
      )
      .run(envId, Buffer.from(entryId), ...tagIds);
    return result.changes;
  }

  async getEntryTags(entryId: Uint8Array): Promise<TagInfo[]> {
    const envId = Buffer.from(this.mainEnvId);
    return this.fetchEntryTags(envId, [Buffer.from(entryId)]).get(
      Buffer.from(entryId).toString('hex')
    ) ?? [];
  }

  async listTags(): Promise<TagWithCounts[]> {
    const envId = Buffer.from(this.mainEnvId);
    // Counts are filtered to non-deleted assets/entries so a "stale"
    // tag attached only to deleted things shows zero — matches what
    // the user actually sees in lists.
    const rows = this.db
      .prepare<[Buffer], { slug: string; label: string; asset_uses: number; entry_uses: number }>(
        `SELECT t.slug, t.label,
                COALESCE((
                  SELECT COUNT(*) FROM asset_tags at
                  JOIN assets a ON a.id = at.asset_id
                  WHERE at.env_id = t.env_id AND at.tag_id = t.id AND a.deleted_at IS NULL
                ), 0) AS asset_uses,
                COALESCE((
                  SELECT COUNT(*) FROM entry_tags et
                  JOIN entries e ON e.id = et.entry_id
                  WHERE et.env_id = t.env_id AND et.tag_id = t.id AND e.deleted_at IS NULL
                ), 0) AS entry_uses
         FROM tags t
         WHERE t.env_id = ?
         ORDER BY (asset_uses + entry_uses) DESC, t.label COLLATE NOCASE ASC`
      )
      .all(envId);
    return rows.map((r) => ({
      slug: r.slug,
      label: r.label,
      asset_uses: r.asset_uses,
      entry_uses: r.entry_uses
    }));
  }

  async updateTag(slug: string, label: string): Promise<TagInfo | null> {
    const newLabel = normalizeTag(label);
    if (newLabel === null) {
      throw new Error(`updateTag: invalid label "${label}"`);
    }
    const envId = Buffer.from(this.mainEnvId);
    const result = this.db
      .prepare('UPDATE tags SET label = ? WHERE env_id = ? AND slug = ?')
      .run(newLabel.label, envId, slug);
    if (result.changes === 0) return null;
    return { slug, label: newLabel.label };
  }

  async close(): Promise<void> {
    this.db.close();
  }
}
