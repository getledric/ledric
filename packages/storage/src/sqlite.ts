import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { TypeDef } from '@ledric/schema';
import type {
  Storage,
  TypeSummary,
  TypeDetail,
  CreateTypeInput,
  CreateTypeResult
} from './types.js';
import { migrations } from './migrations.js';
import { uuidv7Bytes } from './uuid.js';

const MAIN_ENV_NAME = 'main';

export interface OpenOptions {
  path: string;
}

export class SqliteStorage implements Storage {
  readonly db: BetterSqliteDatabase;
  private mainEnvId!: Uint8Array;

  static async open(opts: OpenOptions): Promise<SqliteStorage> {
    const db = new Database(opts.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = NORMAL');
    const storage = new SqliteStorage(db);
    storage.migrate();
    storage.bootstrapMainEnv();
    return storage;
  }

  private constructor(db: BetterSqliteDatabase) {
    this.db = db;
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

  async close(): Promise<void> {
    this.db.close();
  }
}
