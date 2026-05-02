import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { field } from '@ledric/schema';
import { openSqlite, type LedricStorage } from '@ledric/storage';
import { Core } from './core.js';
import { FsTransformCache } from './transforms.js';

describe('Core', () => {
  let storage: LedricStorage;
  let core: Core;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
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

  it('describeModel surfaces feature capabilities and the field-type catalogue', async () => {
    const result = await core.describeModel();
    expect(result.capabilities.imageTransforms).toBe(true);
    expect(result.capabilities.refValidation).toBe(true);
    expect(result.capabilities.fieldTypes).toContain('jss');
    expect(result.capabilities.fieldTypes).toContain('css');
    expect(result.capabilities.fieldTypes).toContain('object');
    expect(result.capabilities.fieldTypes).toContain('markdown');
  });

  it('describeModel ships a structured field-type catalogue with required keys + examples', async () => {
    const result = await core.describeModel();
    const specs = result.capabilities.fieldTypeSpecs;
    expect(specs.array).toBeDefined();
    expect(specs.array?.required).toContain('of');
    expect(specs.array?.example).toMatchObject({ type: 'array', of: { type: 'string' } });
    expect(specs.object?.required).toContain('fields');
    expect(specs.references?.required).toContain('to');
    expect(specs.vector?.required).toContain('dims');
    expect(specs.enum?.required).toContain('values');
    // Plain types have no required keys beyond the discriminator.
    expect(specs.string?.required).toEqual([]);
    expect(specs.number?.required).toEqual([]);
  });

  it('describeModel surfaces the naming conventions and reserved sidecar keys', async () => {
    const result = await core.describeModel();
    expect(result.conventions.name_pattern).toBe('^[a-z][a-z0-9_]*$');
    expect(result.conventions.reserved_content_keys).toEqual(
      expect.arrayContaining(['_locale', '_redirect', '_refs', '_warnings'])
    );
    expect(result.conventions.notes).toMatch(/leading underscore/i);
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

  it('enforces unique:true on draft create — second entry with same value is rejected', async () => {
    await core.createType({
      name: 'product',
      fields: {
        sku: field.string({ required: true, unique: true }),
        title: field.string({ required: true })
      },
      opts: { identifier_field: 'sku', display_field: 'title' }
    });
    await core.draft({
      type: 'product',
      fields: { sku: 'WIDGET-1', title: 'Widget' }
    });
    await expect(
      core.draft({
        type: 'product',
        fields: { sku: 'WIDGET-1', title: 'Widget Pro' }
      })
    ).rejects.toMatchObject({
      code: 'UNIQUE_VIOLATION',
      type: 'product',
      field: 'sku',
      value: 'WIDGET-1',
      conflicting_slug: 'WIDGET-1'
    });
  });

  it('allows updating an entry without tripping its own unique value', async () => {
    await core.createType({
      name: 'product',
      fields: {
        sku: field.string({ required: true, unique: true }),
        title: field.string({ required: true })
      },
      opts: { identifier_field: 'sku', display_field: 'title' }
    });
    const created = await core.draft({
      type: 'product',
      fields: { sku: 'WIDGET-1', title: 'Widget' }
    });
    // Updating the same row with the same unique value must not collide.
    const updated = await core.draft({
      type: 'product',
      ref: { type: 'product', slug: 'WIDGET-1' },
      parent_version: created.version,
      fields: { sku: 'WIDGET-1', title: 'Widget Mk II' }
    });
    expect(updated.version).toBe(2);
  });

  it('strips private:true fields from read responses by default', async () => {
    await core.createType({
      name: 'page',
      fields: {
        title: field.string({ required: true }),
        slug: field.slug({ required: true, from: 'title' }),
        body: field.string({ required: true }),
        internal_notes: field.string({ private: true })
      },
      opts: { identifier_field: 'slug', display_field: 'title' }
    });
    await core.draft({
      type: 'page',
      fields: {
        title: 'Hello',
        slug: 'hello',
        body: 'public body',
        internal_notes: 'editor scratchpad'
      }
    });
    const publicView = await core.read({ ref: { type: 'page', slug: 'hello' } });
    expect(publicView).not.toBeNull();
    expect(publicView?.content.title).toBe('Hello');
    expect(publicView?.content.body).toBe('public body');
    expect(publicView?.content.internal_notes).toBeUndefined();

    const adminView = await core.read({
      ref: { type: 'page', slug: 'hello' },
      include_private: true
    });
    expect(adminView?.content.internal_notes).toBe('editor scratchpad');
  });

  it('strips private fields from find results too', async () => {
    await core.createType({
      name: 'page',
      fields: {
        title: field.string({ required: true }),
        slug: field.slug({ required: true, from: 'title' }),
        body: field.string({ required: true }),
        internal_notes: field.string({ private: true })
      },
      opts: { identifier_field: 'slug', display_field: 'title' }
    });
    await core.draft({
      type: 'page',
      fields: { title: 'A', slug: 'a', body: 'a-body', internal_notes: 'a-notes' }
    });
    await core.draft({
      type: 'page',
      fields: { title: 'B', slug: 'b', body: 'b-body', internal_notes: 'b-notes' }
    });
    const publicList = await core.find({ type: 'page' });
    for (const r of publicList.results) {
      expect((r.content as Record<string, unknown>).internal_notes).toBeUndefined();
    }
    const adminList = await core.find({ type: 'page', include_private: true });
    for (const r of adminList.results) {
      expect((r.content as Record<string, unknown>).internal_notes).toMatch(/-notes$/);
    }
  });
});

describe('Core.getTransformedAsset', () => {
  let storage: LedricStorage;
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
    storage = await openSqlite({ path: ':memory:' });
    cacheDir = mkdtempSync(join(tmpdir(), 'ledric-tx-core-'));
    core = new Core(storage, { transformCache: new FsTransformCache(cacheDir) });
  });

  afterEach(async () => {
    await storage.close();
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('returns null for an unknown ref_key', async () => {
    const r = await core.getTransformedAsset({
      ref_key: '00000000000000000000000000000000',
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
    const refKey = Buffer.from(written.ref_key).toString('hex');

    const out = await core.getTransformedAsset({
      ref_key: refKey,
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
    const refKey = Buffer.from(written.ref_key).toString('hex');

    const first = await core.getTransformedAsset({ ref_key: refKey, params: { w: 80, fm: 'webp' } });
    const second = await core.getTransformedAsset({ ref_key: refKey, params: { w: 80, fm: 'webp' } });
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
    const refKey = Buffer.from(written.ref_key).toString('hex');

    const out = await core.getTransformedAsset({ ref_key: refKey, params: { w: 100, fm: 'webp' } });
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
    const refKey = Buffer.from(written.ref_key).toString('hex');

    const webpFromAccept = await core.getTransformedAsset({
      ref_key: refKey,
      params: { w: 80, auto: 'format' },
      accept: 'image/webp,image/*,*/*'
    });
    const pngDefault = await core.getTransformedAsset({
      ref_key: refKey,
      params: { w: 80, auto: 'format' },
      accept: 'image/jpeg,*/*'
    });

    expect(webpFromAccept?.mime).toBe('image/webp');
    expect(pngDefault?.mime).toBe('image/png');
    expect(webpFromAccept?.cached).toBe(false);
    expect(pngDefault?.cached).toBe(false);

    const webpAgain = await core.getTransformedAsset({
      ref_key: refKey,
      params: { w: 80, auto: 'format' },
      accept: 'image/webp,image/*,*/*'
    });
    expect(webpAgain?.cached).toBe(true);
  });

  it('updateAsset bumps version, mints new ref_key, transform cache misses → re-renders', async () => {
    const v1Bytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 255, g: 0, b: 0 } }
    })
      .png()
      .toBuffer();
    const v1 = await core.uploadAsset({
      kind: 'image',
      bytes: v1Bytes,
      meta: { mime: 'image/png' }
    });
    const v1RefKey = Buffer.from(v1.ref_key).toString('hex');
    const v1Id = Buffer.from(v1.id).toString('hex');

    // Cache the v1 transform.
    const t1 = await core.getTransformedAsset({
      ref_key: v1RefKey,
      params: { w: 50, fm: 'webp' }
    });
    expect(t1?.cached).toBe(false);
    expect(t1?.version).toBe(1);

    // Replace the bytes (different color → different output).
    const v2Bytes = await sharp({
      create: { width: 100, height: 100, channels: 3, background: { r: 0, g: 0, b: 255 } }
    })
      .png()
      .toBuffer();
    const v2 = await core.updateAsset({
      id: v1Id,
      parent_version: 1,
      bytes: v2Bytes
    });
    expect(v2.version).toBe(2);
    expect(v2.id).toBe(v1Id);
    expect(v2.ref_key).not.toBe(v1RefKey);

    // The v1 ref_key still serves v1 bytes (version-pinned forever).
    const v1Again = await core.getTransformedAsset({
      ref_key: v1RefKey,
      params: { w: 50, fm: 'webp' }
    });
    expect(v1Again?.cached).toBe(true);
    expect(v1Again?.version).toBe(1);

    // The new ref_key is a fresh cache slot — first hit re-renders.
    const t2 = await core.getTransformedAsset({
      ref_key: v2.ref_key,
      params: { w: 50, fm: 'webp' }
    });
    expect(t2?.cached).toBe(false);
    expect(t2?.version).toBe(2);
    expect(t2?.bytes.equals(t1!.bytes)).toBe(false);
  });
});
