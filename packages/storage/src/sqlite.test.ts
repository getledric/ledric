import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineType, field } from '@ledric/schema';
import { SqliteStorage } from './sqlite.js';

describe('SqliteStorage', () => {
  let storage: SqliteStorage;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('seeds the main env on open', () => {
    const envs = storage.db
      .prepare('SELECT name FROM envs')
      .all() as Array<{ name: string }>;
    expect(envs.map((e) => e.name)).toEqual(['main']);
  });

  it('creates a type and returns version 1', async () => {
    const def = defineType('product', {
      title: field.string({ required: true }),
      price: field.number({ min: 0 })
    });
    const result = await storage.createType({ definition: def });
    expect(result.name).toBe('product');
    expect(result.version).toBe(1);
    expect(result.id).toBeInstanceOf(Uint8Array);
    expect(result.id.byteLength).toBe(16);
  });

  it('lists created types', async () => {
    const product = defineType('product', { title: field.string() });
    const article = defineType('article', { title: field.string() });
    await storage.createType({ definition: product });
    await storage.createType({ definition: article });

    const types = await storage.listTypes();
    expect(types.map((t) => t.name).sort()).toEqual(['article', 'product']);
    expect(types.every((t) => t.current_version === 1)).toBe(true);
  });

  it('reads back a type definition via getType', async () => {
    const def = defineType(
      'product',
      {
        title: field.string({ max: 120 }),
        slug: field.slug({ from: 'title' }),
        tags: field.array({ of: field.string(), max: 20 })
      },
      {
        summary_fields: ['title', 'slug']
      }
    );
    await storage.createType({ definition: def });

    const detail = await storage.getType('product');
    expect(detail).not.toBeNull();
    expect(detail?.current_version).toBe(1);
    expect(detail?.schema_version).toBe(1);
    expect(detail?.definition).toEqual(def);
  });

  it('returns null for an unknown type', async () => {
    expect(await storage.getType('missing')).toBeNull();
  });

  it('refuses to create a type that already exists', async () => {
    const def = defineType('product', { title: field.string() });
    await storage.createType({ definition: def });
    await expect(storage.createType({ definition: def })).rejects.toThrow(/already exists/);
  });

  it('round-trips an asset through the db backend', async () => {
    const bytes = Buffer.from('hello asset world', 'utf8');
    const write = await storage.createAsset({
      kind: 'file',
      bytes,
      meta: { mime: 'text/plain', alt: 'greeting' }
    });
    expect(write.version).toBe(1);
    expect(write.storage_ref.startsWith('db:')).toBe(true);
    expect(write.meta.size).toBe(bytes.byteLength);

    const detail = await storage.getAsset(write.id);
    expect(detail).not.toBeNull();
    expect(detail?.kind).toBe('file');
    expect(detail?.meta.mime).toBe('text/plain');

    const read = await storage.readAssetBytes(write.id);
    expect(read.equals(bytes)).toBe(true);
  });

  it('round-trips an asset through the local backend', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ledric-assets-'));
    try {
      await storage.close();
      storage = await SqliteStorage.open({
        path: ':memory:',
        assets: { backend: 'local', root: dir }
      });
      const bytes = Buffer.from('hello local backend', 'utf8');
      const write = await storage.createAsset({
        kind: 'file',
        bytes,
        meta: { mime: 'text/plain' }
      });
      expect(write.storage_ref.startsWith('local:')).toBe(true);

      const read = await storage.readAssetBytes(write.id);
      expect(read.equals(bytes)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists assets with kind filter', async () => {
    await storage.createAsset({ kind: 'image', bytes: Buffer.from([1, 2, 3]) });
    await storage.createAsset({ kind: 'image', bytes: Buffer.from([4, 5, 6]) });
    await storage.createAsset({ kind: 'file', bytes: Buffer.from([7, 8, 9]) });

    const images = await storage.listAssets({ kind: 'image' });
    expect(images.total).toBe(2);
    expect(images.results.every((r) => r.kind === 'image')).toBe(true);

    const all = await storage.listAssets();
    expect(all.total).toBe(3);
  });

  it('is idempotent on migrations (re-opening the same file is fine)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ledric-'));
    const dbPath = join(dir, 'test.db');
    try {
      const s1 = await SqliteStorage.open({ path: dbPath });
      await s1.createType({ definition: defineType('t', { a: field.string() }) });
      await s1.close();

      const s2 = await SqliteStorage.open({ path: dbPath });
      const types = await s2.listTypes();
      expect(types.map((t) => t.name)).toEqual(['t']);
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
