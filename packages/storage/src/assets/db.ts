import type { Database as BetterSqliteDatabase } from 'better-sqlite3';
import type { AssetBackend, AssetGetResult, AssetPutInput } from './backend.js';

export class DbAssetBackend implements AssetBackend {
  readonly scheme = 'db';

  constructor(private readonly db: BetterSqliteDatabase) {}

  put(input: AssetPutInput): Promise<string> {
    this.db
      .prepare('INSERT INTO asset_blobs (asset_id, version, bytes) VALUES (?, ?, ?)')
      .run(input.assetId, input.version, input.bytes);
    const hex = Buffer.from(input.assetId).toString('hex');
    return Promise.resolve(`db:${hex}:${input.version}`);
  }

  get(storageRef: string): Promise<AssetGetResult> {
    const { id, version } = parseDbRef(storageRef);
    const row = this.db
      .prepare<[Buffer, number], { bytes: Buffer }>(
        'SELECT bytes FROM asset_blobs WHERE asset_id = ? AND version = ?'
      )
      .get(id, version);
    if (!row) throw new Error(`No asset_blob for ref ${storageRef}`);
    return Promise.resolve({ bytes: row.bytes });
  }

  delete(storageRef: string): Promise<void> {
    const { id, version } = parseDbRef(storageRef);
    this.db
      .prepare('DELETE FROM asset_blobs WHERE asset_id = ? AND version = ?')
      .run(id, version);
    return Promise.resolve();
  }
}

function parseDbRef(ref: string): { id: Buffer; version: number } {
  const parts = ref.split(':');
  if (parts.length !== 3 || parts[0] !== 'db') {
    throw new Error(`Not a db storage_ref: ${ref}`);
  }
  return { id: Buffer.from(parts[1] as string, 'hex'), version: Number(parts[2]) };
}
