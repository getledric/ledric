import { Kysely, MysqlDialect } from 'kysely';
import type { Database as Schema } from '../schema.js';
import { LedricStorage, type AssetsConfig } from '../storage.js';
import { runMigrations } from '../migrations/run.js';
import { mysqlMigrations } from '../migrations/mysql.js';

// Loaded lazily so projects that only use SQLite don't need mysql2 on
// disk. The driver is declared as an optional peer dep.
type CreatePoolFn = (opts: Record<string, unknown>) => unknown;

async function loadMysql2(): Promise<{ createPool: CreatePoolFn }> {
  try {
    return (await import('mysql2')) as unknown as { createPool: CreatePoolFn };
  } catch {
    throw new Error(
      'openMysql requires the "mysql2" package. Install it with: npm install mysql2'
    );
  }
}

export interface OpenMysqlOptions {
  /**
   * Either a connection URI ("mysql://user:pass@host:3306/db") or a
   * mysql2 pool config object. Whatever you pass is forwarded to
   * `mysql2.createPool`.
   */
  connection: string | Record<string, unknown>;
  assets?: AssetsConfig;
}

export async function openMysql(opts: OpenMysqlOptions): Promise<LedricStorage> {
  const mysql2 = await loadMysql2();
  const pool =
    typeof opts.connection === 'string'
      ? mysql2.createPool({ uri: opts.connection })
      : mysql2.createPool(opts.connection);

  const db = new Kysely<Schema>({
    dialect: new MysqlDialect({ pool: pool as never })
  });

  await runMigrations(db, 'mysql', mysqlMigrations);

  const storage = new LedricStorage({
    db,
    dialect: 'mysql',
    assets: opts.assets,
    nativeDb: pool
  });
  await storage.initialize();
  return storage;
}
