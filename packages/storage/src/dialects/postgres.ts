import { Kysely, PostgresDialect } from 'kysely';
import type { Database as Schema } from '../schema.js';
import { LedricStorage, type AssetsConfig } from '../storage.js';
import { runMigrations } from '../migrations/run.js';
import { postgresMigrations } from '../migrations/postgres.js';

// Loaded lazily — `pg` is an optional peer dep.
type PoolCtor = new (opts: Record<string, unknown>) => unknown;

async function loadPg(): Promise<{ Pool: PoolCtor }> {
  try {
    return (await import('pg')) as unknown as { Pool: PoolCtor };
  } catch {
    throw new Error(
      'openPostgres requires the "pg" package. Install it with: npm install pg'
    );
  }
}

export interface OpenPostgresOptions {
  /**
   * Either a connection string ("postgres://user:pass@host:5432/db") or
   * a `pg.Pool` config object. Whatever you pass is forwarded to the
   * `pg.Pool` constructor.
   */
  connection: string | Record<string, unknown>;
  assets?: AssetsConfig;
}

export async function openPostgres(opts: OpenPostgresOptions): Promise<LedricStorage> {
  const pg = await loadPg();
  const pool =
    typeof opts.connection === 'string'
      ? new pg.Pool({ connectionString: opts.connection })
      : new pg.Pool(opts.connection);

  const db = new Kysely<Schema>({
    dialect: new PostgresDialect({ pool: pool as never })
  });

  await runMigrations(db, 'postgres', postgresMigrations);

  const storage = new LedricStorage({
    db,
    dialect: 'postgres',
    assets: opts.assets,
    nativeDb: pool
  });
  await storage.initialize();
  return storage;
}
