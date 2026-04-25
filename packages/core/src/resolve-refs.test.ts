import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Core } from './core.js';
import { SqliteStorage } from '@ledric/storage';
import {
  extractInlineRefs,
  collectInlineRefs,
  resolveInlineRefs
} from './resolve-refs.js';
import { defineType, field } from '@ledric/schema';

describe('extractInlineRefs', () => {
  it('parses a simple :::ref{to=...}::: directive', () => {
    expect(extractInlineRefs('see :::ref{to="blog_post/hello"}::: maybe')).toEqual([
      { to: 'blog_post/hello' }
    ]);
  });

  it('parses multiple refs in one body', () => {
    const md = `:::ref{to="a/b"}::: and :::ref{to="c/d"}:::`;
    expect(extractInlineRefs(md)).toEqual([{ to: 'a/b' }, { to: 'c/d' }]);
  });

  it('supports version and locale attrs', () => {
    expect(
      extractInlineRefs(`:::ref{to="blog_post/x" version=42 locale="fr"}:::`)
    ).toEqual([{ to: 'blog_post/x', version: 42, locale: 'fr' }]);
  });

  it('returns empty for non-strings and ref-less markdown', () => {
    expect(extractInlineRefs('')).toEqual([]);
    expect(extractInlineRefs('plain prose, no refs')).toEqual([]);
  });
});

describe('collectInlineRefs', () => {
  const Post = defineType('post', {
    title: field.string({ required: true }),
    slug: field.slug({ from: 'title' }),
    body: field.markdown(),
    summary: field.markdown()
  });

  it('walks every markdown field', () => {
    const refs = collectInlineRefs(
      {
        title: 'X',
        body: '... :::ref{to="post/a"}::: ...',
        summary: ':::ref{to="post/b"}:::'
      },
      Post
    );
    expect(refs.map((r) => r.to)).toEqual(['post/a', 'post/b']);
    expect(refs.map((r) => r.in_field).sort()).toEqual(['body', 'summary']);
  });
});

describe('resolveInlineRefs (round trip)', () => {
  let storage: SqliteStorage;
  let core: Core;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    core = new Core(storage);
    await core.createType({
      name: 'post',
      fields: {
        title: { type: 'string', required: true, max: 200 },
        slug: { type: 'slug', from: 'title' },
        body: { type: 'markdown' }
      },
      opts: { display_field: 'title', identifier_field: 'slug' }
    });
    await core.draft({ type: 'post', fields: { title: 'First', body: 'first body' } });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('returns _refs sidecar with the resolved entry on read({resolve_refs: true})', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'Second',
        body: 'See :::ref{to="post/first"}::: for context.'
      }
    });
    const r = await core.read({
      ref: { type: 'post', slug: 'second' },
      resolve_refs: true
    });
    expect(r?._refs).toHaveLength(1);
    const [ref] = r!._refs!;
    expect(ref?.to).toBe('post/first');
    expect(ref?.found).toBe(true);
    expect(ref?.display).toBe('First');
    expect(ref?.url).toBe('/entries/post/first');
  });

  it('marks dangling refs as found:false', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'Dangler',
        body: 'See :::ref{to="post/missing"}:::'
      }
    });
    const r = await core.read({
      ref: { type: 'post', slug: 'dangler' },
      resolve_refs: true
    });
    expect(r?._refs?.[0]).toEqual({ to: 'post/missing', found: false });
  });

  it('dedupes identical refs and applies _refs across find()', async () => {
    await core.draft({
      type: 'post',
      fields: {
        title: 'Triple',
        body:
          ':::ref{to="post/first"}::: a :::ref{to="post/first"}::: b :::ref{to="post/missing"}:::'
      }
    });
    const list = await core.find({ type: 'post', resolve_refs: true });
    const triple = list.results.find((r) => r.slug === 'triple');
    expect(triple?._refs).toHaveLength(2);
    expect(triple?._refs?.find((r) => r.to === 'post/first')?.found).toBe(true);
    expect(triple?._refs?.find((r) => r.to === 'post/missing')?.found).toBe(false);
  });

  it('does not attach _refs when resolve_refs is omitted', async () => {
    const r = await core.read({ ref: { type: 'post', slug: 'first' } });
    expect(r?._refs).toBeUndefined();
  });
});
