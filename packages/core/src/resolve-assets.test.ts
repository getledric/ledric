import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Core } from './core.js';
import { openSqlite, type LedricStorage } from '@ledric/storage';

describe('resolveAssets', () => {
  let storage: LedricStorage;
  let core: Core;
  let assetId: string;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    core = new Core(storage);

    await core.createType({
      name: 'product',
      fields: {
        title: { type: 'string', required: true, max: 200 },
        slug: { type: 'slug', from: 'title' },
        hero: { type: 'asset', kinds: ['image'] },
        gallery: { type: 'array', of: { type: 'asset' }, max: 10 }
      },
      opts: { identifier_field: 'slug' }
    });

    const upload = await core.uploadAsset({
      kind: 'image',
      bytes: Buffer.from('PNGFAKEBYTES'),
      meta: { mime: 'image/png', alt: 'hero shot', size: 12 }
    });
    assetId = Buffer.from(upload.id).toString('hex');
  });

  afterEach(async () => {
    await storage.close();
  });

  it('leaves assets as opaque ids when expand_assets is undefined', async () => {
    await core.draft({
      type: 'product',
      fields: { title: 'Widget', hero: assetId }
    });
    const r = await core.read({ ref: { type: 'product', slug: 'widget' } });
    expect(r?.content.hero).toBe(assetId);
  });

  it('expands a single asset field to { id, ref_key, kind, meta, url } when expand_assets=true', async () => {
    await core.draft({
      type: 'product',
      fields: { title: 'Widget', hero: assetId }
    });
    const r = await core.read({
      ref: { type: 'product', slug: 'widget' },
      expand_assets: true
    });
    const hero = r?.content.hero as Record<string, unknown>;
    expect(hero.id).toBe(assetId);
    expect(hero.kind).toBe('image');
    expect(hero.ref_key).toMatch(/^[0-9a-f]{32}$/);
    expect(hero.url).toBe(`/assets/${hero.ref_key}`);
    expect((hero.meta as Record<string, unknown>).alt).toBe('hero shot');
  });

  it('expands an array-of-assets field', async () => {
    const a2 = await core.uploadAsset({
      kind: 'image',
      bytes: Buffer.from('SECOND'),
      meta: { mime: 'image/png' }
    });
    const id2 = Buffer.from(a2.id).toString('hex');

    await core.draft({
      type: 'product',
      fields: { title: 'Widget', gallery: [assetId, id2] }
    });
    const r = await core.read({
      ref: { type: 'product', slug: 'widget' },
      expand_assets: true
    });
    const gallery = r?.content.gallery as Array<Record<string, unknown>>;
    expect(Array.isArray(gallery)).toBe(true);
    expect(gallery.length).toBe(2);
    expect(gallery[0]?.id).toBe(assetId);
    expect(gallery[1]?.id).toBe(id2);
  });

  it('respects a string[] selection — only listed fields expand', async () => {
    await core.draft({
      type: 'product',
      fields: { title: 'Widget', hero: assetId, gallery: [assetId] }
    });
    const r = await core.read({
      ref: { type: 'product', slug: 'widget' },
      expand_assets: ['hero']
    });
    expect(typeof r?.content.hero).toBe('object');
    // gallery left as raw ids
    expect(Array.isArray(r?.content.gallery)).toBe(true);
    expect((r?.content.gallery as string[])[0]).toBe(assetId);
  });

  it('returns null for placeholder ids that do not match a real asset', async () => {
    await core.draft({
      type: 'product',
      fields: { title: 'Widget', hero: 'asset:placeholder-not-real' }
    });
    const r = await core.read({
      ref: { type: 'product', slug: 'widget' },
      expand_assets: true
    });
    expect(r?.content.hero).toBeNull();
  });

  it('expands across find()', async () => {
    await core.draft({ type: 'product', fields: { title: 'A', hero: assetId } });
    await core.draft({ type: 'product', fields: { title: 'B', hero: assetId } });
    const list = await core.find({ type: 'product', expand_assets: true });
    expect(list.results.length).toBe(2);
    for (const r of list.results) {
      const hero = r.content.hero as Record<string, unknown>;
      expect(hero.id).toBe(assetId);
      expect(hero.url).toBe(`/assets/${hero.ref_key}`);
    }
  });
});
