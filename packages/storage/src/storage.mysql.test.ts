import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import mysql from 'mysql2/promise';
import { defineType, field } from '@ledric/schema';
import { openMysql } from './dialects/mysql.js';
import type { LedricStorage } from './storage.js';

// MySQL tests run only when LEDRIC_TEST_MYSQL_URL is set — same opt-in
// pattern as the postgres suite. Sqlite stays the default-CI dialect.
const MYSQL_URL = process.env.LEDRIC_TEST_MYSQL_URL;

// Same table list as postgres — reverse-dependency order. CASCADE isn't
// supported in MySQL DROP TABLE, but we use SET FOREIGN_KEY_CHECKS=0
// around the drops to bypass the constraint check during teardown.
const TABLES = [
  'fts_entries',
  'entry_tags',
  'asset_tags',
  'tags',
  'api_keys',
  'oauth_codes',
  'oauth_refresh_tokens',
  'oauth_clients',
  'oauth_keys',
  'entries_slugs',
  'slug_history',
  'asset_blobs',
  'asset_versions',
  'assets',
  'entry_versions',
  'entries',
  'type_versions',
  'types',
  'envs',
  '_migrations'
];

async function resetSchema(url: string): Promise<void> {
  const conn = await mysql.createConnection(url);
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of TABLES) {
      await conn.query(`DROP TABLE IF EXISTS \`${t}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await conn.end();
  }
}

describe.runIf(MYSQL_URL !== undefined)('LedricStorage (mysql)', () => {
  let storage: LedricStorage;

  beforeAll(async () => {
    // Connectivity / version sanity check up front. MySQL 8.0+ needed
    // for CTE support and a usable BOOLEAN-MODE FTS.
    const conn = await mysql.createConnection(MYSQL_URL!);
    const [rows] = (await conn.query('SELECT VERSION() AS version')) as unknown as [
      Array<{ version: string }>
    ];
    await conn.end();
    const ver = rows[0]?.version ?? '';
    if (!/^([89]|1[0-9])\./.test(ver)) {
      throw new Error(
        `LEDRIC_TEST_MYSQL_URL points at an unsupported mysql: ${ver} (need 8.0+)`
      );
    }
  });

  beforeEach(async () => {
    await resetSchema(MYSQL_URL!);
    storage = await openMysql({ connection: MYSQL_URL! });
  });

  afterEach(async () => {
    await storage.close();
  });

  // ─────────────────────────── core flows ───────────────────────────

  it('runs migrations and seeds the main env', async () => {
    const envs = await storage.db
      .selectFrom('envs')
      .select(['name'])
      .execute();
    expect(envs.map((e) => e.name)).toEqual(['main']);
  });

  it('creates a type and surfaces it via listTypes / getType', async () => {
    const t = defineType('product', {
      title: field.string({ required: true, max: 120 }),
      slug: field.slug({ from: 'title' }),
      price: field.number({ min: 0 })
    });
    await storage.createType({ definition: t });
    const types = await storage.listTypes();
    expect(types.map((x) => x.name)).toEqual(['product']);
    const got = await storage.getType('product');
    expect(got?.definition.fields.title).toMatchObject({ type: 'string', max: 120 });
  });

  it('round-trips an entry through createEntry → readEntry → findEntries', async () => {
    const t = defineType(
      'note',
      {
        title: field.string({ required: true }),
        slug: field.slug({ from: 'title' }),
        body: field.markdown({ required: true })
      },
      { identifier_field: 'slug', display_field: 'title' }
    );
    await storage.createType({ definition: t });
    await storage.createEntry({
      type: 'note',
      slug: 'hello',
      content: { title: 'Hello', slug: 'hello', body: '## hi' },
      schema_version: 1
    });
    const got = await storage.readEntry({ type: 'note', slug: 'hello' });
    expect(got?.slug).toBe('hello');
    expect(got?.content.title).toBe('Hello');
    const list = await storage.findEntries({ type: 'note' });
    expect(list.total).toBe(1);
  });

  // ─────────────────────────── assets (VARBINARY + MEDIUMBLOB) ─────────

  it('round-trips asset bytes through the db backend', async () => {
    const written = await storage.createAsset({
      kind: 'image',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
      meta: { mime: 'image/jpeg', size: 6, alt: 'nothing' }
    });
    const read = await storage.getAsset(written.id);
    expect(read).not.toBeNull();
    expect(read?.kind).toBe('image');
    expect(read?.meta.mime).toBe('image/jpeg');
    const bytes = await storage.readAssetBytes(written.id);
    expect(bytes.byteLength).toBe(6);
    expect(bytes[0]).toBe(0xff);
  });

  it('mints a fresh ref_key on createAsset and resolves via findAssetByRefKey', async () => {
    const written = await storage.createAsset({
      kind: 'image',
      bytes: Buffer.from('original'),
      meta: { mime: 'image/png' }
    });
    const got = await storage.findAssetByRefKey(written.ref_key);
    expect(got).not.toBeNull();
    expect(got?.id).toEqual(written.id);
  });

  // ─────────────────────────── tags ───────────────────────────

  it('attaches and lists entry tags + filters by tag', async () => {
    const t = defineType(
      'note',
      {
        title: field.string({ required: true }),
        slug: field.slug({ from: 'title' })
      },
      { identifier_field: 'slug', display_field: 'title' }
    );
    await storage.createType({ definition: t });

    const a = await storage.createEntry({
      type: 'note',
      slug: 'a',
      content: { title: 'A', slug: 'a' },
      schema_version: 1,
      tags: ['Featured']
    });
    await storage.createEntry({
      type: 'note',
      slug: 'b',
      content: { title: 'B', slug: 'b' },
      schema_version: 1
    });

    const featured = await storage.findEntries({ type: 'note', tags: ['featured'] });
    expect(featured.results.map((r) => r.slug)).toEqual(['a']);

    const allTags = await storage.listTags();
    expect(allTags.find((t) => t.slug === 'featured')?.entry_uses).toBe(1);

    await storage.removeEntryTags(a.id, ['featured']);
    const after = await storage.findEntries({ type: 'note', tags: ['featured'] });
    expect(after.total).toBe(0);
  });

  // ─────────────────────────── full-text search (FULLTEXT + BOOLEAN) ────

  it('finds entries by FTS query — the mysql FULLTEXT + BOOLEAN MODE path', async () => {
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

    const r = await storage.findEntries({ type: 'post', q: 'kysely' });
    expect(r.total).toBe(1);
    expect(r.results[0]?.slug).toBe('kysely-migration');

    const morningHit = await storage.findEntries({ type: 'post', q: 'morning' });
    expect(morningHit.results.map((x) => x.slug)).toEqual(['about-coffee']);

    const empty = await storage.findEntries({ type: 'post', q: 'unicorn' });
    expect(empty.total).toBe(0);
  });

  it('FTS index refreshes on updateEntry — old keyword stops matching', async () => {
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
    const created = await storage.createEntry({
      type: 'post',
      slug: 'first',
      content: { title: 'Title', slug: 'first', body: 'About kittens.' },
      schema_version: 1
    });
    expect((await storage.findEntries({ type: 'post', q: 'kittens' })).total).toBe(1);

    await storage.updateEntry({
      ref: { type: 'post', slug: 'first' },
      parent_version: created.version,
      schema_version: 1,
      content: { title: 'Title', slug: 'first', body: 'About giraffes.' }
    });

    expect((await storage.findEntries({ type: 'post', q: 'kittens' })).total).toBe(0);
    expect((await storage.findEntries({ type: 'post', q: 'giraffes' })).total).toBe(1);
  });

  // ─────────────────────────── api keys ───────────────────────────

  it('round-trips an api key by hash', async () => {
    const hash = new Uint8Array(32).fill(7);
    await storage.createApiKey({
      role: 'admin',
      label: 'mysql-test',
      key_hash: hash,
      key_prefix: 'lka_test'
    });
    const found = await storage.findApiKeyByHash(hash);
    expect(found?.role).toBe('admin');
    expect(found?.label).toBe('mysql-test');
  });
});
