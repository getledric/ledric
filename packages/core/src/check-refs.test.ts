import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineType, field } from '@ledric/schema';
import { SqliteStorage } from '@ledric/storage';
import { Core, ValidationFailedError } from './core.js';
import { parseRef } from './parse-ref.js';
import { checkStructuralRefs } from './check-refs.js';

describe('parseRef', () => {
  it('parses type/slug', () => {
    expect(parseRef('blog_post/why-we-built-ledric')).toEqual({
      type: 'blog_post',
      slug: 'why-we-built-ledric'
    });
  });

  it('parses type/slug@N', () => {
    expect(parseRef('blog_post/hello@2')).toEqual({
      type: 'blog_post',
      slug: 'hello',
      version: 2
    });
  });

  it('returns null for malformed input', () => {
    expect(parseRef('')).toBeNull();
    expect(parseRef('no-slash')).toBeNull();
    expect(parseRef('/empty-type')).toBeNull();
    expect(parseRef('type/')).toBeNull();
    expect(parseRef('type/slug@notanumber')).toBeNull();
  });
});

describe('checkStructuralRefs', () => {
  let storage: SqliteStorage;
  let core: Core;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    core = new Core(storage);

    await core.createType({
      name: 'block',
      fields: {
        slug: { type: 'string', required: true, max: 200 },
        body: { type: 'markdown' }
      },
      opts: { identifier_field: 'slug' }
    });

    await core.createType({
      name: 'page',
      fields: {
        slug: { type: 'string', required: true, max: 200 },
        title: { type: 'string', required: true, max: 200 },
        sections: {
          type: 'references',
          to: ['block']
        }
      },
      opts: { identifier_field: 'slug' }
    });

    await core.draft({
      type: 'block',
      fields: { slug: 'b1', body: 'hi' }
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  async function checkPage(sections: unknown[]): Promise<unknown[]> {
    const typeDetail = await storage.getType('page');
    if (!typeDetail) throw new Error('page type missing');
    return checkStructuralRefs(
      { slug: 'p', title: 'P', sections },
      typeDetail.definition,
      storage
    );
  }

  it('passes when every ref resolves to an allowed type', async () => {
    const issues = await checkPage(['block/b1']);
    expect(issues).toEqual([]);
  });

  it('flags unparseable strings as unrecognized_ref_format', async () => {
    const issues = await checkPage(['just-a-slug']);
    expect(issues).toHaveLength(1);
    expect((issues[0] as { code: string }).code).toBe('unrecognized_ref_format');
  });

  it('flags missing targets as reference_not_found', async () => {
    const issues = await checkPage(['block/missing']);
    expect(issues).toHaveLength(1);
    const issue = issues[0] as { code: string; path: string };
    expect(issue.code).toBe('reference_not_found');
    expect(issue.path).toBe('/sections/0');
  });

  it('flags wrong-type targets as reference_type_not_allowed', async () => {
    // Create another type that we'll point at incorrectly.
    await core.createType({
      name: 'tag',
      fields: { slug: { type: 'string', required: true, max: 200 } },
      opts: { identifier_field: 'slug' }
    });
    await core.draft({ type: 'tag', fields: { slug: 't1' } });

    const issues = await checkPage(['tag/t1']);
    expect(issues).toHaveLength(1);
    const issue = issues[0] as { code: string; expected: unknown };
    expect(issue.code).toBe('reference_type_not_allowed');
    expect(issue.expected).toEqual(['block']);
  });

  it('checks the pinned version of a type/slug@N ref', async () => {
    // Create v2 of b1 by drafting again with parent_version.
    await core.draft({
      type: 'block',
      ref: { type: 'block', slug: 'b1' },
      parent_version: 1,
      fields: { slug: 'b1', body: 'updated' }
    });
    // @1 still resolves; @99 doesn't.
    expect(await checkPage(['block/b1@1'])).toEqual([]);
    const issues = await checkPage(['block/b1@99']);
    expect(issues).toHaveLength(1);
    expect((issues[0] as { code: string }).code).toBe('reference_version_not_found');
  });

  it('skips non-string array entries silently (validator handles them)', async () => {
    const issues = await checkPage([42, null, undefined]);
    expect(issues).toEqual([]);
  });
});

describe('Core.draft / Core.publish — warn on draft, error on publish', () => {
  let storage: SqliteStorage;
  let core: Core;

  beforeEach(async () => {
    storage = await SqliteStorage.open({ path: ':memory:' });
    core = new Core(storage);
    await core.createType({
      name: 'block',
      fields: { slug: { type: 'string', required: true, max: 200 } },
      opts: { identifier_field: 'slug' }
    });
    await core.createType({
      name: 'page',
      fields: {
        slug: { type: 'string', required: true, max: 200 },
        title: { type: 'string', required: true, max: 200 },
        sections: { type: 'references', to: ['block'] }
      },
      opts: { identifier_field: 'slug' }
    });
  });

  afterEach(async () => {
    await storage.close();
  });

  it('draft accepts a page whose sections target missing blocks, and surfaces warnings', async () => {
    const result = await core.draft({
      type: 'page',
      fields: {
        slug: 'home',
        title: 'Home',
        sections: ['block/not-yet', 'block/also-missing']
      }
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings.every((w) => w.code === 'reference_not_found')).toBe(true);
  });

  it('publish refuses when warnings remain — same issue, escalated', async () => {
    await core.draft({
      type: 'page',
      fields: {
        slug: 'home',
        title: 'Home',
        sections: ['block/not-yet']
      }
    });
    await expect(
      core.publish({ ref: { type: 'page', slug: 'home' } })
    ).rejects.toThrow(ValidationFailedError);
  });

  it('publish succeeds once the targets exist', async () => {
    await core.draft({
      type: 'block',
      fields: { slug: 'b1' }
    });
    await core.draft({
      type: 'page',
      fields: {
        slug: 'home',
        title: 'Home',
        sections: ['block/b1']
      }
    });
    const published = await core.publish({
      ref: { type: 'page', slug: 'home' }
    });
    expect(published.published_version).toBe(1);
  });

  it('Core.read attaches _warnings when stored content has dangling refs', async () => {
    await core.draft({
      type: 'page',
      fields: {
        slug: 'home',
        title: 'Home',
        sections: ['block/ghost']
      }
    });
    const r = await core.read({ ref: { type: 'page', slug: 'home' } });
    expect(r?._warnings).toHaveLength(1);
    expect(r?._warnings?.[0]?.code).toBe('reference_not_found');
  });
});
