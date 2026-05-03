import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import pg from 'pg';
import { defineType, field } from '@ledric/schema';
import { openPostgres } from './dialects/postgres.js';
import type { LedricStorage } from './storage.js';

// Postgres tests run only when LEDRIC_TEST_POSTGRES_URL is set. The CI
// default is to skip — sqlite is the dialect we test on every run, this
// suite is for explicit "does the postgres adapter actually work" runs
// against a real postgres instance the developer points at.
const POSTGRES_URL = process.env.LEDRIC_TEST_POSTGRES_URL;

// Names of every table this codebase creates, in reverse-dependency
// order. We DROP ... CASCADE between tests so each test starts against a
// truly fresh schema — no migrations table, no envs row, nothing. Adding
// tables to migrations means adding the table here too.
const TABLES = [
  'fts_entries',
  'entry_tags',
  'asset_tags',
  'tags',
  'api_keys',
  'oidc_payloads',
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
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    // CASCADE handles FK references; IF EXISTS handles "first run, nothing
    // to drop." One statement per table — postgres rolls each back if it
    // fails, which we don't want, so individual statements + ignored
    // errors handle the "table doesn't exist" case cleanly.
    for (const t of TABLES) {
      await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
    }
  } finally {
    await client.end();
  }
}

describe.runIf(POSTGRES_URL !== undefined)('LedricStorage (postgres)', () => {
  let storage: LedricStorage;

  beforeAll(async () => {
    // One-time sanity check that we can actually connect before letting
    // the suite proceed. Better than a confusing per-test failure cascade
    // when the URL is wrong / the host is down / the user is bad.
    const client = new pg.Client({ connectionString: POSTGRES_URL });
    await client.connect();
    const { rows } = await client.query<{ version: string }>('SELECT version()');
    await client.end();
    if (!/PostgreSQL 1[2-9]|PostgreSQL [2-9][0-9]/.test(rows[0]?.version ?? '')) {
      throw new Error(
        `LEDRIC_TEST_POSTGRES_URL points at an unsupported postgres: ${rows[0]?.version}`
      );
    }
  });

  beforeEach(async () => {
    await resetSchema(POSTGRES_URL!);
    storage = await openPostgres({ connection: POSTGRES_URL! });
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

  // ─────────────────────────── assets (BYTEA) ───────────────────────────

  it('round-trips asset bytes through the db backend (BYTEA)', async () => {
    const written = await storage.createAsset({
      kind: 'image',
      bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), // arbitrary
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

  // ─────────────────────────── full-text search (tsvector + GIN) ───────────

  it('finds entries by FTS query — the postgres tsvector + plainto_tsquery path', async () => {
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
      label: 'pg-test',
      key_hash: hash,
      key_prefix: 'lka_test'
    });
    const found = await storage.findApiKeyByHash(hash);
    expect(found?.role).toBe('admin');
    expect(found?.label).toBe('pg-test');
  });
});
