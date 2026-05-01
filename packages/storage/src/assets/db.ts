import type { Kysely } from 'kysely';
import type { Database } from '../schema.js';
import type { AssetBackend, AssetGetResult, AssetPutInput } from './backend.js';

export class DbAssetBackend implements AssetBackend {
  readonly scheme = 'db';

  constructor(private readonly db: Kysely<Database>) {}

  async put(input: AssetPutInput): Promise<string> {
    await this.db
      .insertInto('asset_blobs')
      .values({
        asset_id: Buffer.from(input.assetId),
        version: input.version,
        bytes: Buffer.from(input.bytes)
      })
      .execute();
    const hex = Buffer.from(input.assetId).toString('hex');
    return `db:${hex}:${input.version}`;
  }

  async get(storageRef: string): Promise<AssetGetResult> {
    const { id, version } = parseDbRef(storageRef);
    const row = await this.db
      .selectFrom('asset_blobs')
      .select('bytes')
      .where('asset_id', '=', id)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!row) throw new Error(`No asset_blob for ref ${storageRef}`);
    return { bytes: Buffer.from(row.bytes) };
  }

  async delete(storageRef: string): Promise<void> {
    const { id, version } = parseDbRef(storageRef);
    await this.db
      .deleteFrom('asset_blobs')
      .where('asset_id', '=', id)
      .where('version', '=', version)
      .execute();
  }
}

function parseDbRef(ref: string): { id: Buffer; version: number } {
  const parts = ref.split(':');
  if (parts.length !== 3 || parts[0] !== 'db') {
    throw new Error(`Not a db storage_ref: ${ref}`);
  }
  return { id: Buffer.from(parts[1] as string, 'hex'), version: Number(parts[2]) };
}
