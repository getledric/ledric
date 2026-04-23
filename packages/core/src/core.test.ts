import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { field } from '@ledric/schema';
import { SqliteStorage } from '@ledric/storage';
import { Core } from './core.js';

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
