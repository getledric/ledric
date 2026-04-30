import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Core } from '@ledric/core';
import { SqliteStorage } from '@ledric/storage';
import { runHttp } from '@ledric/http-server';
import { createLedricClient, LedricError } from './client.js';

describe('LedricClient', () => {
  let storage: SqliteStorage;
  let server: { url: string; close: () => Promise<void> };
  let client: ReturnType<typeof createLedricClient>;

  beforeAll(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    const core = new Core(storage);

    await core.createType({
      name: 'note',
      fields: {
        title: { type: 'string', required: true, max: 200 },
        slug: { type: 'slug', from: 'title' },
        body: { type: 'markdown' },
        hero: { type: 'asset', kinds: ['image'] }
      },
      opts: {
        identifier_field: 'slug',
        display_field: 'title',
        summary_fields: ['title', 'slug', 'hero']
      }
    });

    await core.draft({ type: 'note', fields: { title: 'Hello World', body: '## hi' } });
    await core.draft({ type: 'note', fields: { title: 'Second Note', body: 'second' } });
    await core.publish({ ref: { type: 'note', slug: 'hello-world' } });

    const asset = await core.uploadAsset({
      kind: 'image',
      bytes: Buffer.from('PNGFAKEBYTES'),
      meta: { mime: 'image/png', alt: 'placeholder' }
    });

    // Hand the asset id to the entry via migrate_entries (touches just the hero field).
    await core.migrateEntries({
      type: 'note',
      filter: { slug: 'hello-world' },
      merge_patch: { hero: Buffer.from(asset.id).toString('hex') }
    });

    server = await runHttp(core, { port: 0, host: '127.0.0.1' });
    client = createLedricClient({ baseUrl: server.url });
  });

  afterAll(async () => {
    await server.close();
    await storage.close();
  });

  it('read by "type/slug" string', async () => {
    const entry = await client.read('note/hello-world');
    expect(entry).not.toBeNull();
    expect(entry!.slug).toBe('hello-world');
    expect(entry!.fields.title).toBe('Hello World');
    expect(entry!.fields.hero).toMatch(/^[0-9a-f]{32}$/);
  });

  it('read by structured ref', async () => {
    const entry = await client.read({ type: 'note', slug: 'hello-world' });
    expect(entry?.fields.title).toBe('Hello World');
  });

  it('read returns null on 404', async () => {
    const entry = await client.read('note/missing');
    expect(entry).toBeNull();
  });

  it('find lists entries with summary projection', async () => {
    const list = await client.find('note', { limit: 10 });
    expect(list.total).toBe(2);
    const slugs = list.results.map((r) => r.slug).sort();
    expect(slugs).toEqual(['hello-world', 'second-note']);
  });

  it('types() returns the full content model', async () => {
    const model = await client.types();
    expect(model.types.note).toBeDefined();
    expect(model.types.note?.fields.title).toBeDefined();
  });

  it('type(name) returns a single type or null', async () => {
    expect((await client.type('note'))?.name).toBe('note');
    expect(await client.type('nope')).toBeNull();
  });

  it('asset(idOrRefKey) returns metadata + url for both lookup forms', async () => {
    const list = await client.assets();
    expect(list.total).toBe(1);
    const summary = list.results[0]!;
    expect(summary.ref_key).toMatch(/^[0-9a-f]{32}$/);

    // Look up by ref_key (preferred for URL-bearing things).
    const byRef = await client.asset(summary.ref_key);
    expect(byRef?.kind).toBe('image');
    expect(byRef?.url).toBe(`/assets/${summary.ref_key}`);

    // Look up by id (stable handle in entry content).
    const byId = await client.asset(summary.id);
    expect(byId?.kind).toBe('image');
    expect(byId?.ref_key).toBe(summary.ref_key);
  });

  it('assetUrl(asset) uses the asset object\'s ref_key', async () => {
    const list = await client.assets();
    const asset = list.results[0]!;
    const url = client.assetUrl(asset);
    expect(url).toBe(`${server.url}/assets/${asset.ref_key}`);
  });

  it('assetUrl(refKeyString) accepts a bare ref_key', () => {
    const url = client.assetUrl('019dc0b5deadbeefcafebabe00000000');
    expect(url).toBe(`${server.url}/assets/019dc0b5deadbeefcafebabe00000000`);
  });

  it('assetUrl encodes transform params for imgix-style requests', () => {
    const url = client.assetUrl('019dc0b5deadbeefcafebabe00000000', {
      w: 400,
      h: 300,
      fit: 'crop',
      q: 80,
      fm: 'webp',
      dpr: 2
    });
    const u = new URL(url);
    expect(u.pathname).toBe('/assets/019dc0b5deadbeefcafebabe00000000');
    expect(u.searchParams.get('w')).toBe('400');
    expect(u.searchParams.get('h')).toBe('300');
    expect(u.searchParams.get('fit')).toBe('crop');
    expect(u.searchParams.get('q')).toBe('80');
    expect(u.searchParams.get('fm')).toBe('webp');
    expect(u.searchParams.get('dpr')).toBe('2');
  });

  it('assetUrl includes auto=format when requested', () => {
    const url = client.assetUrl('019dc0b5deadbeefcafebabe00000000', { auto: 'format', w: 800 });
    const u = new URL(url);
    expect(u.searchParams.get('auto')).toBe('format');
    expect(u.searchParams.get('w')).toBe('800');
  });

  it('assetBytes(asset) returns the raw bytes', async () => {
    const list = await client.assets();
    const asset = list.results[0]!;
    const bytes = await client.assetBytes(asset);
    expect(bytes).not.toBeNull();
    expect(new TextDecoder().decode(bytes!)).toBe('PNGFAKEBYTES');
  });

  it('rpc tool surface throws LedricError on unknown tools', async () => {
    await expect(client.rpc('nonsense')).rejects.toThrow(LedricError);
  });

  it('rpc can drive write tools (draft a third note)', async () => {
    const result = await client.rpc<{ slug: string; version: number }>('draft', {
      type: 'note',
      fields: { title: 'Third Note' }
    });
    expect(result.slug).toBe('third-note');
    expect(result.version).toBe(1);
  });
});
