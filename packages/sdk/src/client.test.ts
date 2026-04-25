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

  it('asset(id) returns metadata + url', async () => {
    const list = await client.assets();
    expect(list.total).toBe(1);
    const id = list.results[0]!.id;
    const asset = await client.asset(id);
    expect(asset?.kind).toBe('image');
    expect(asset?.meta.mime).toBe('image/png');
    expect(asset?.url).toContain(`/assets/${id}`);
  });

  it('assetUrl builds a deterministic URL without fetching', () => {
    const url = client.assetUrl('019dc0b5deadbeef');
    expect(url).toBe(`${server.url}/assets/019dc0b5deadbeef`);
  });

  it('assetBytes returns the raw bytes', async () => {
    const list = await client.assets();
    const id = list.results[0]!.id;
    const bytes = await client.assetBytes(id);
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
