import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Core } from './core.js';
import { openSqlite, type LedricStorage } from '@ledric/storage';

describe('resolveReferences', () => {
  let storage: LedricStorage;
  let core: Core;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    core = new Core(storage);

    // Author: simple type for the post to reference.
    await core.createType({
      name: 'author',
      fields: {
        name: { type: 'string', required: true },
        slug: { type: 'slug', from: 'name' },
        bio: { type: 'string' }
      },
      opts: { identifier_field: 'slug', display_field: 'name' }
    });

    // Post: has an author reference (single) and a related-posts list.
    await core.createType({
      name: 'post',
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'slug', from: 'title' },
        body: { type: 'markdown', required: true },
        author: {
          type: 'references',
          to: ['author'],
          min: 1,
          max: 1
        },
        related: {
          type: 'references',
          to: ['post'],
          max: 10
        }
      },
      opts: { identifier_field: 'slug', display_field: 'title' }
    });

    await core.draft({
      type: 'author',
      fields: { name: 'Ada Lovelace', bio: 'Mathematician.' }
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('leaves references as opaque "type/slug" strings when resolve_references is undefined', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'On computing',
        body: '# hi',
        author: ['author/ada-lovelace']
      }
    });
    const r = await core.read({ ref: { type: 'post', slug: 'on-computing' } });
    expect(r?.content.author).toEqual(['author/ada-lovelace']);
  });

  it('inlines references when resolve_references=true', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'On computing',
        body: '# hi',
        author: ['author/ada-lovelace']
      }
    });
    const r = await core.read({
      ref: { type: 'post', slug: 'on-computing' },
      resolve_references: true
    });
    const author = r?.content.author as Array<Record<string, unknown>>;
    expect(Array.isArray(author)).toBe(true);
    expect(author).toHaveLength(1);
    expect(author[0]).toMatchObject({
      type: 'author',
      slug: 'ada-lovelace',
      version: 1
    });
    expect((author[0]!.fields as Record<string, unknown>).name).toBe('Ada Lovelace');
  });

  it('respects a string[] selection — only listed fields resolve', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'A',
        body: '# a',
        author: ['author/ada-lovelace'],
        related: []
      }
    });
    await core.draft({
      type: 'post',
      fields: {
        title: 'B',
        body: '# b',
        author: ['author/ada-lovelace'],
        related: ['post/a']
      }
    });
    const b = await core.read({
      ref: { type: 'post', slug: 'b' },
      resolve_references: ['related']
    });
    // related: resolved
    const related = b?.content.related as Array<Record<string, unknown>>;
    expect(related).toHaveLength(1);
    expect(related[0]).toMatchObject({ type: 'post', slug: 'a' });
    // author: NOT in the list, stays as opaque string
    expect(b?.content.author).toEqual(['author/ada-lovelace']);
  });

  it('returns null in the array slot for unresolvable references', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'Dangling',
        body: '# d',
        author: ['author/ghost']
      }
    });
    const r = await core.read({
      ref: { type: 'post', slug: 'dangling' },
      resolve_references: true
    });
    expect((r?.content.author as unknown[])[0]).toBeNull();
  });

  it('expands across find()', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'Hello',
        body: '# h',
        author: ['author/ada-lovelace']
      }
    });
    const list = await core.find({ type: 'post', resolve_references: true });
    expect(list.results).toHaveLength(1);
    const author = (list.results[0]!.content as Record<string, unknown>).author as Array<
      Record<string, unknown>
    >;
    expect(author[0]).toMatchObject({ type: 'author', slug: 'ada-lovelace' });
  });
});
