import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineType, field } from '@ledric/schema';
import { openSqlite } from './dialects/sqlite.js';
import type { LedricStorage } from './storage.js';

describe('LedricStorage (sqlite)', () => {
  let storage: LedricStorage;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('seeds the main env on open', async () => {
    const envs = await storage.db.selectFrom('envs').select('name').execute();
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
      storage = await openSqlite({
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

  describe('tags', () => {
    it('add/remove/list flow on an asset, with filter by tag', async () => {
      const a = await storage.createAsset({ kind: 'image', bytes: Buffer.from([1]), tags: ['#Featured Event', 'hero'] });
      const b = await storage.createAsset({ kind: 'image', bytes: Buffer.from([2]), tags: ['hero'] });

      // initial tags from createAsset wired through and projected
      const aTags = await storage.getAssetTags(a.id);
      expect(aTags.map((t) => t.slug).sort()).toEqual(['featured-event', 'hero']);
      // the case of the original input is preserved as the label
      expect(aTags.find((t) => t.slug === 'featured-event')?.label).toBe('Featured Event');

      // adding a duplicate (different case + leading #) is a no-op
      await storage.addAssetTags(a.id, ['#FEATURED EVENT']);
      expect((await storage.getAssetTags(a.id)).length).toBe(2);

      // filter by tag — AND semantics
      const both = await storage.listAssets({ tags: ['hero', 'featured event'] });
      expect(both.results.map((r) => Buffer.from(r.id).toString('hex'))).toEqual([
        Buffer.from(a.id).toString('hex')
      ]);
      const justHero = await storage.listAssets({ tags: ['hero'] });
      expect(justHero.total).toBe(2);

      // remove
      const removed = await storage.removeAssetTags(a.id, ['#Featured Event']);
      expect(removed).toBe(1);
      expect((await storage.getAssetTags(a.id)).map((t) => t.slug)).toEqual(['hero']);

      // listAssets results carry tags
      const list = await storage.listAssets();
      const aRow = list.results.find((r) => Buffer.from(r.id).toString('hex') === Buffer.from(a.id).toString('hex'));
      expect(aRow?.tags.map((t) => t.slug)).toEqual(['hero']);

      // listTags has counts
      const tags = await storage.listTags();
      const heroTag = tags.find((t) => t.slug === 'hero');
      expect(heroTag?.asset_uses).toBe(2);
      expect(heroTag?.entry_uses).toBe(0);
    });

    it('parallel flow on entries, plus updateTag relabels in place', async () => {
      const def = (await import('@ledric/schema')).defineType('post', {
        title: (await import('@ledric/schema')).field.string({ required: true })
      });
      await storage.createType({ definition: def });
      const e1 = await storage.createEntry({
        type: 'post', slug: 'a', content: { title: 'A' }, schema_version: 1, tags: ['Featured Event']
      });
      await storage.createEntry({
        type: 'post', slug: 'b', content: { title: 'B' }, schema_version: 1, tags: ['featured event', 'q4']
      });

      // findEntries filter
      const filtered = await storage.findEntries({ type: 'post', tags: ['featured-event'] });
      expect(filtered.total).toBe(2);
      // results carry tags
      expect(filtered.results.every((r) => r.tags.length > 0)).toBe(true);

      // updateTag relabels but slug is stable
      const r = await storage.updateTag('featured-event', 'Featured Events');
      expect(r?.label).toBe('Featured Events');
      const tagsAfter = await storage.listTags();
      expect(tagsAfter.find((t) => t.slug === 'featured-event')?.label).toBe('Featured Events');

      // remove + counts update
      await storage.removeEntryTags(e1.id, ['Featured Event']);
      const tags = await storage.listTags();
      expect(tags.find((t) => t.slug === 'featured-event')?.entry_uses).toBe(1);
    });
  });

  describe('updateAsset / findAssetByRefKey', () => {
    it('mints a fresh ref_key on createAsset and lets findAssetByRefKey resolve it', async () => {
      const w = await storage.createAsset({
        kind: 'file',
        bytes: Buffer.from('v1', 'utf8'),
        meta: { mime: 'text/plain' }
      });
      expect(w.ref_key.byteLength).toBe(16);

      const found = await storage.findAssetByRefKey(w.ref_key);
      expect(found).not.toBeNull();
      expect(Buffer.from(found!.id).equals(Buffer.from(w.id))).toBe(true);
      expect(found!.version).toBe(1);
    });

    it('updateAsset bumps version, mints new ref_key, keeps id stable', async () => {
      const v1 = await storage.createAsset({
        kind: 'file',
        bytes: Buffer.from('v1', 'utf8'),
        meta: { mime: 'text/plain', alt: 'one' }
      });

      const v2 = await storage.updateAsset({
        id: v1.id,
        parent_version: 1,
        bytes: Buffer.from('v2-bytes-bigger', 'utf8')
      });

      expect(v2.version).toBe(2);
      // Same asset id…
      expect(Buffer.from(v2.id).equals(Buffer.from(v1.id))).toBe(true);
      // …new ref_key.
      expect(Buffer.from(v2.ref_key).equals(Buffer.from(v1.ref_key))).toBe(false);
      // Meta carried forward when not provided, with refreshed size.
      expect(v2.meta.alt).toBe('one');
      expect(v2.meta.size).toBe(15);

      // Old ref_key still resolves to v1's bytes.
      const refV1 = await storage.findAssetByRefKey(v1.ref_key);
      expect(refV1?.version).toBe(1);
      const refV2 = await storage.findAssetByRefKey(v2.ref_key);
      expect(refV2?.version).toBe(2);

      // Bytes at each version match.
      const b1 = await storage.readAssetBytes(v1.id, { version: 1 });
      const b2 = await storage.readAssetBytes(v1.id, { version: 2 });
      expect(b1.toString()).toBe('v1');
      expect(b2.toString()).toBe('v2-bytes-bigger');
    });

    it('updateAsset replaces meta entirely when provided (not a merge)', async () => {
      const v1 = await storage.createAsset({
        kind: 'image',
        bytes: Buffer.from([1, 2, 3]),
        meta: { mime: 'image/png', alt: 'before', dims: { w: 10, h: 10 } }
      });
      const v2 = await storage.updateAsset({
        id: v1.id,
        parent_version: 1,
        bytes: Buffer.from([4, 5, 6, 7]),
        meta: { mime: 'image/jpeg' } // explicit narrow meta — drops alt + dims
      });
      expect(v2.meta.mime).toBe('image/jpeg');
      expect(v2.meta.alt).toBeUndefined();
      expect(v2.meta.dims).toBeUndefined();
      expect(v2.meta.size).toBe(4);
    });

    it('updateAsset rejects on parent_version mismatch (VERSION_CONFLICT)', async () => {
      const v1 = await storage.createAsset({
        kind: 'file',
        bytes: Buffer.from('a')
      });
      await expect(
        storage.updateAsset({ id: v1.id, parent_version: 99, bytes: Buffer.from('b') })
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('updateAsset NOT_FOUND for unknown id', async () => {
      const id = new Uint8Array(16);
      await expect(
        storage.updateAsset({ id, parent_version: 1, bytes: Buffer.from('x') })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('findAssetByRefKey returns null for unknown ref_key', async () => {
      expect(await storage.findAssetByRefKey(new Uint8Array(16))).toBeNull();
    });
  });

  describe('deleteType / deleteEntry', () => {
    it('soft-deletes an empty type and frees subsequent listTypes()', async () => {
      const def = defineType('product', { title: field.string() });
      await storage.createType({ definition: def });

      const r = await storage.deleteType({ name: 'product', parent_version: 1 });
      expect(r.name).toBe('product');
      expect(r.entries_deleted).toBe(0);
      expect(r.deleted_at).toBeGreaterThan(0);

      const live = await storage.listTypes();
      expect(live.find((t) => t.name === 'product')).toBeUndefined();

      const all = await storage.listTypes({ includeDeleted: true });
      expect(all.find((t) => t.name === 'product')?.deleted_at).toBeGreaterThan(0);
    });

    it('refuses to delete a type with live entries unless cascade is set', async () => {
      const def = defineType('product', { title: field.string({ required: true }) });
      await storage.createType({ definition: def });
      await storage.createEntry({
        type: 'product',
        slug: 'a',
        content: { title: 'A' },
        schema_version: 1
      });

      await expect(
        storage.deleteType({ name: 'product', parent_version: 1 })
      ).rejects.toMatchObject({ code: 'TYPE_NOT_EMPTY', entry_count: 1 });
    });

    it('cascade-soft-deletes the type and its entries in one shot', async () => {
      const def = defineType('product', { title: field.string({ required: true }) });
      await storage.createType({ definition: def });
      await storage.createEntry({ type: 'product', slug: 'a', content: { title: 'A' }, schema_version: 1 });
      await storage.createEntry({ type: 'product', slug: 'b', content: { title: 'B' }, schema_version: 1 });

      const r = await storage.deleteType({ name: 'product', parent_version: 1, cascade: true });
      expect(r.entries_deleted).toBe(2);

      // Reads stop seeing the cascaded entries.
      expect(await storage.readEntry({ type: 'product', slug: 'a' })).toBeNull();
    });

    it('parent_version mismatch raises VERSION_CONFLICT', async () => {
      const def = defineType('product', { title: field.string() });
      await storage.createType({ definition: def });
      await expect(
        storage.deleteType({ name: 'product', parent_version: 99 })
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('NOT_FOUND when the type is missing or already deleted', async () => {
      await expect(
        storage.deleteType({ name: 'nope', parent_version: 1 })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      const def = defineType('p', { title: field.string() });
      await storage.createType({ definition: def });
      await storage.deleteType({ name: 'p', parent_version: 1 });
      await expect(
        storage.deleteType({ name: 'p', parent_version: 1 })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('soft-deletes an entry and reads stop seeing it', async () => {
      const def = defineType('product', { title: field.string({ required: true }) });
      await storage.createType({ definition: def });
      const created = await storage.createEntry({
        type: 'product',
        slug: 'a',
        content: { title: 'A' },
        schema_version: 1
      });

      const r = await storage.deleteEntry({
        ref: { type: 'product', slug: 'a' },
        parent_version: created.version
      });
      expect(r.slug).toBe('a');
      expect(r.deleted_at).toBeGreaterThan(0);

      expect(await storage.readEntry({ type: 'product', slug: 'a' })).toBeNull();
    });

    it('deleteEntry refuses on parent_version mismatch', async () => {
      const def = defineType('product', { title: field.string() });
      await storage.createType({ definition: def });
      await storage.createEntry({
        type: 'product',
        slug: 'a',
        content: { title: 'A' },
        schema_version: 1
      });
      await expect(
        storage.deleteEntry({ ref: { type: 'product', slug: 'a' }, parent_version: 99 })
      ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
    });

    it('deleteEntry NOT_FOUND on already-deleted entries', async () => {
      const def = defineType('product', { title: field.string() });
      await storage.createType({ definition: def });
      const created = await storage.createEntry({
        type: 'product',
        slug: 'a',
        content: { title: 'A' },
        schema_version: 1
      });
      await storage.deleteEntry({
        ref: { type: 'product', slug: 'a' },
        parent_version: created.version
      });
      await expect(
        storage.deleteEntry({
          ref: { type: 'product', slug: 'a' },
          parent_version: created.version
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('api_keys', () => {
    it('starts with no active keys (auth-off mode)', async () => {
      expect(await storage.countActiveApiKeys()).toBe(0);
    });

    it('round-trips an admin key by hash lookup', async () => {
      const { generateApiKey } = await import('./keys.js');
      const k = generateApiKey('admin');
      const written = await storage.createApiKey({
        role: 'admin',
        label: 'first',
        key_hash: k.hash,
        key_prefix: k.prefix
      });
      expect(written.id.byteLength).toBe(16);

      const found = await storage.findApiKeyByHash(k.hash);
      expect(found).not.toBeNull();
      expect(found!.role).toBe('admin');
      expect(found!.label).toBe('first');
      expect(found!.revoked_at).toBeNull();

      expect(await storage.countActiveApiKeys()).toBe(1);
    });

    it('returns null for an unknown hash', async () => {
      const wrong = new Uint8Array(32);
      expect(await storage.findApiKeyByHash(wrong)).toBeNull();
    });

    it('lists keys newest-first and excludes revoked by default', async () => {
      const { generateApiKey } = await import('./keys.js');
      const a = generateApiKey('admin');
      const b = generateApiKey('reader');
      const c = generateApiKey('admin');
      const wA = await storage.createApiKey({ role: 'admin', label: 'a', key_hash: a.hash, key_prefix: a.prefix });
      await new Promise((r) => setTimeout(r, 2));
      await storage.createApiKey({ role: 'reader', label: 'b', key_hash: b.hash, key_prefix: b.prefix });
      await new Promise((r) => setTimeout(r, 2));
      await storage.createApiKey({ role: 'admin', label: 'c', key_hash: c.hash, key_prefix: c.prefix });

      await storage.revokeApiKey(wA.id);

      const active = await storage.listApiKeys();
      expect(active.map((r) => r.label)).toEqual(['c', 'b']);

      const all = await storage.listApiKeys({ includeRevoked: true });
      expect(all.map((r) => r.label)).toEqual(['c', 'b', 'a']);
      expect(all[2]?.revoked_at).not.toBeNull();
      expect(await storage.countActiveApiKeys()).toBe(2);
    });

    it('revokeApiKey is idempotent and returns null for unknown ids', async () => {
      const { generateApiKey } = await import('./keys.js');
      const k = generateApiKey('admin');
      const w = await storage.createApiKey({ role: 'admin', key_hash: k.hash, key_prefix: k.prefix });
      const r1 = await storage.revokeApiKey(w.id);
      expect(r1).not.toBeNull();
      const r2 = await storage.revokeApiKey(w.id);
      expect(r2).not.toBeNull();
      const wrongId = new Uint8Array(16);
      expect(await storage.revokeApiKey(wrongId)).toBeNull();
    });

    it('markApiKeyUsed debounces writes within 60s', async () => {
      const { generateApiKey } = await import('./keys.js');
      const k = generateApiKey('admin');
      const w = await storage.createApiKey({ role: 'admin', key_hash: k.hash, key_prefix: k.prefix });

      const t0 = 1_000_000_000_000;
      await storage.markApiKeyUsed(w.id, t0);
      await storage.markApiKeyUsed(w.id, t0 + 30_000);
      const after1 = (await storage.listApiKeys())[0]!;
      expect(after1.last_used_at).toBe(t0);

      await storage.markApiKeyUsed(w.id, t0 + 70_000);
      const after2 = (await storage.listApiKeys())[0]!;
      expect(after2.last_used_at).toBe(t0 + 70_000);
    });
  });

  it('is idempotent on migrations (re-opening the same file is fine)', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = mkdtempSync(join(tmpdir(), 'ledric-'));
    const dbPath = join(dir, 'test.db');
    try {
      const s1 = await openSqlite({ path: dbPath });
      await s1.createType({ definition: defineType('t', { a: field.string() }) });
      await s1.close();

      const s2 = await openSqlite({ path: dbPath });
      const types = await s2.listTypes();
      expect(types.map((t) => t.name)).toEqual(['t']);
      await s2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('full-text search', () => {
    async function setupSearchableBlog() {
      const post = defineType(
        'post',
        {
          title: field.string({ required: true, searchable: true }),
          slug: field.slug({ required: true, from: 'title' }),
          body: field.markdown({ required: true, searchable: true })
        },
        { identifier_field: 'slug', display_field: 'title' }
      );
      await storage.createType({ definition: post });
    }

    it('finds an entry by a token from a searchable field', async () => {
      await setupSearchableBlog();
      await storage.createEntry({
        type: 'post',
        slug: 'kysely-migration',
        content: {
          title: 'Why I switched to Kysely',
          slug: 'kysely-migration',
          body: 'It was time. Raw SQL stopped scaling.'
        },
        schema_version: 1
      });
      await storage.createEntry({
        type: 'post',
        slug: 'about-coffee',
        content: {
          title: 'About coffee',
          slug: 'about-coffee',
          body: 'A morning routine essay.'
        },
        schema_version: 1
      });

      const result = await storage.findEntries({ type: 'post', q: 'kysely' });
      expect(result.total).toBe(1);
      expect(result.results[0]?.slug).toBe('kysely-migration');

      // Match in body, not title.
      const bodyMatch = await storage.findEntries({ type: 'post', q: 'morning' });
      expect(bodyMatch.results.map((r) => r.slug)).toEqual(['about-coffee']);

      // No match.
      const empty = await storage.findEntries({ type: 'post', q: 'unicorn' });
      expect(empty.total).toBe(0);
      expect(empty.results).toEqual([]);
    });

    it('updates the index when an entry is updated', async () => {
      await setupSearchableBlog();
      const created = await storage.createEntry({
        type: 'post',
        slug: 'first',
        content: { title: 'Original title', slug: 'first', body: 'Body about kittens.' },
        schema_version: 1
      });
      // Searchable for the original keyword.
      let r = await storage.findEntries({ type: 'post', q: 'kittens' });
      expect(r.total).toBe(1);

      // Update the body — old keyword should no longer match.
      await storage.updateEntry({
        ref: { type: 'post', slug: 'first' },
        parent_version: created.version,
        schema_version: 1,
        content: { title: 'Original title', slug: 'first', body: 'Body about giraffes.' }
      });

      r = await storage.findEntries({ type: 'post', q: 'kittens' });
      expect(r.total).toBe(0);
      r = await storage.findEntries({ type: 'post', q: 'giraffes' });
      expect(r.total).toBe(1);
    });
  });
});
