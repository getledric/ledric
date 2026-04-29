import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { field } from '@ledric/schema';
import { SqliteStorage } from '@ledric/storage';
import { Core } from './core.js';
import { FsTransformCache } from './transforms.js';

describe('Core', () => {
  let storage: SqliteStorage;
  let core: Core;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    core = new Core(storage);
  });

  afterEach(async () => {
    await storage.close();
  });

  it('describeModel on an empty DB returns no types', async () => {
    const result = await core.describeModel();
    expect(result.types).toEqual({});
    expect(result.schema_version).toBe(0);
    expect(result.capabilities.fts).toBe('fts5');
  });

  it('createType validates via defineType and persists', async () => {
    const result = await core.createType({
      name: 'product',
      fields: {
        title: field.string({ required: true, max: 120 }),
        slug: field.slug({ from: 'title' }),
        price: field.number({ min: 0 })
      },
      opts: { summary_fields: ['title', 'slug', 'price'] }
    });
    expect(result.name).toBe('product');
    expect(result.version).toBe(1);
    expect(result.summary_fields).toEqual(['title', 'slug', 'price']);
  });

  it('round-trips through describeModel', async () => {
    await core.createType({
      name: 'product',
      fields: {
        title: field.string({ required: true }),
        price: field.number()
      }
    });
    await core.createType({
      name: 'article',
      fields: {
        title: field.string({ required: true }),
        body: field.markdown()
      }
    });

    const result = await core.describeModel();
    expect(Object.keys(result.types).sort()).toEqual(['article', 'product']);
    expect(result.types.product?.version).toBe(1);
    expect(result.types.article?.fields.body?.type).toBe('markdown');
    expect(result.schema_version).toBe(2);
  });

  it('rejects an invalid type name at createType', async () => {
    await expect(
      core.createType({ name: 'Bad-Name', fields: { a: field.string() } })
    ).rejects.toThrow(/type name/);
  });

  it('rejects duplicate type creation', async () => {
    await core.createType({ name: 'product', fields: { a: field.string() } });
    await expect(
      core.createType({ name: 'product', fields: { a: field.string() } })
    ).rejects.toThrow(/already exists/);
  });
});

describe('Core.getTransformedAsset', () => {
  let storage: SqliteStorage;
  let cacheDir: string;
  let core: Core;

  async function makeRedPng(w = 200, h = 100): Promise<Buffer> {
    return sharp({
      create: { width: w, height: h, channels: 3, background: { r: 255, g: 0, b: 0 } }
    })
      .png()
      .toBuffer();
  }

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    cacheDir = mkdtempSync(join(tmpdir(), 'ledric-tx-core-'));
    core = new Core(storage, { transformCache: new FsTransformCache(cacheDir) });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns null for an unknown asset id', async () => {
    const r = await core.getTransformedAsset({
      id: '00000000000000000000000000000000',
      params: { w: 100 }
    });
    expect(r).toBeNull();
  });

  it('resizes a PNG and returns webp when fm=webp', async () => {
    const png = await makeRedPng();
    const written = await core.uploadAsset({
      kind: 'image',
      bytes: png,
      meta: { mime: 'image/png' }
    });
    const id = Buffer.from(written.id).toString('hex');

    const out = await core.getTransformedAsset({
      id,
      params: { w: 80, fm: 'webp' }
    });
    expect(out).not.toBeNull();
    expect(out!.mime).toBe('image/webp');
    expect(out!.passthrough).toBe(false);
    expect(out!.cached).toBe(false);

    const meta = await sharp(out!.bytes).metadata();
    expect(meta.width).toBe(80);
    expect(meta.format).toBe('webp');
  });

  it('serves identical cached bytes on the second request', async () => {
    const png = await makeRedPng();
    const written = await core.uploadAsset({
      kind: 'image',
      bytes: png,
      meta: { mime: 'image/png' }
    });
    const id = Buffer.from(written.id).toString('hex');

    const first = await core.getTransformedAsset({ id, params: { w: 80, fm: 'webp' } });
    const second = await core.getTransformedAsset({ id, params: { w: 80, fm: 'webp' } });
    expect(first?.cached).toBe(false);
    expect(second?.cached).toBe(true);
    expect(first?.bytes.equals(second!.bytes)).toBe(true);
  });

  it('passes non-image assets through unchanged', async () => {
    const written = await core.uploadAsset({
      kind: 'file',
      bytes: Buffer.from('hello pdf'),
      meta: { mime: 'application/pdf' }
    });
    const id = Buffer.from(written.id).toString('hex');

    const out = await core.getTransformedAsset({ id, params: { w: 100, fm: 'webp' } });
    expect(out?.passthrough).toBe(true);
    expect(out?.mime).toBe('application/pdf');
    expect(out?.bytes.toString()).toBe('hello pdf');
  });

  it('respects auto=format with Accept header for cache key separation', async () => {
    const png = await makeRedPng();
    const written = await core.uploadAsset({
      kind: 'image',
      bytes: png,
      meta: { mime: 'image/png' }
    });
    const id = Buffer.from(written.id).toString('hex');

    const webpFromAccept = await core.getTransformedAsset({
      id,
      params: { w: 80, auto: 'format' },
      accept: 'image/webp,image/*,*/*'
    });
    const pngDefault = await core.getTransformedAsset({
      id,
      params: { w: 80, auto: 'format' },
      accept: 'image/jpeg,*/*'
    });

    expect(webpFromAccept?.mime).toBe('image/webp');
    expect(pngDefault?.mime).toBe('image/png');
    // Should land in different cache slots — neither should be a cache hit.
    expect(webpFromAccept?.cached).toBe(false);
    expect(pngDefault?.cached).toBe(false);

    // Repeat one of them to confirm cache works per-format.
    const webpAgain = await core.getTransformedAsset({
      id,
      params: { w: 80, auto: 'format' },
      accept: 'image/webp,image/*,*/*'
    });
    expect(webpAgain?.cached).toBe(true);
  });
});
