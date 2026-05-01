import Database from 'better-sqlite3';
import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import { Kysely, SqliteDialect } from 'kysely';
import type { Database as Schema } from '../schema.js';
import { LedricStorage, type AssetsConfig } from '../storage.js';
import { runMigrations } from '../migrations/run.js';
import { sqliteMigrations } from '../migrations/sqlite.js';

export interface OpenSqliteOptions {
  /** Filesystem path or `:memory:`. */
  path: string;
  assets?: AssetsConfig;
}

/**
 * Open a SQLite-backed LedricStorage. Default — works out of the box
 * without any external services. `:memory:` paths give you an
 * ephemeral DB suitable for tests.
 *
 * The returned storage object exposes `.nativeDb` if you need direct
 * better-sqlite3 access (e.g. for `pragma`, raw SQL, or backup).
 */
export async function openSqlite(opts: OpenSqliteOptions): Promise<LedricStorage> {
  const native: BetterSqliteDatabase = new Database(opts.path);
  native.pragma('journal_mode = WAL');
  native.pragma('foreign_keys = ON');
  native.pragma('synchronous = NORMAL');

  const db = new Kysely<Schema>({
    dialect: new SqliteDialect({ database: native })
  });

  await runMigrations(db, 'sqlite', sqliteMigrations);

  const storage = new LedricStorage({
    db,
    dialect: 'sqlite',
    assets: opts.assets,
    nativeDb: native
  });
  await storage.initialize();
  return storage;
}
