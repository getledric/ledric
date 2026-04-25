import { describe, it, expect } from 'vitest';
import { defineType, field } from '@ledric/schema';
import {
  projectForLocale,
  computeFallbackChain,
  extractLocaleSlugs
} from './locale.js';

describe('projectForLocale', () => {
  const Post = defineType(
    'post',
    {
      title: field.string({ required: true, localized: true }),
      slug: field.slug({ from: 'title', localized: true }),
      body: field.markdown({ localized: true }),
      published_at: field.date()
    },
    {
      locales: ['en', 'fr', 'de'],
      default_locale: 'en',
      fallback: { de: 'fr' }
    }
  );

  const stored = {
    title: 'Hello',
    slug: 'hello',
    body: '## hi',
    published_at: '2026-04-25',
    _locale: {
      fr: { title: 'Bonjour', slug: 'bonjour', body: '## salut' },
      de: { title: 'Hallo' } // sparse: no body, no slug
    }
  };

  it('returns the top-level shape unchanged for the default locale', () => {
    const out = projectForLocale(stored, Post, 'en');
    expect(out).toEqual({
      title: 'Hello',
      slug: 'hello',
      body: '## hi',
      published_at: '2026-04-25'
    });
    expect((out as Record<string, unknown>)._locale).toBeUndefined();
  });

  it('overlays a fully-translated locale', () => {
    const out = projectForLocale(stored, Post, 'fr');
    expect(out).toEqual({
      title: 'Bonjour',
      slug: 'bonjour',
      body: '## salut',
      published_at: '2026-04-25'
    });
  });

  it('walks fallback chain de → fr → en for missing fields', () => {
    const out = projectForLocale(stored, Post, 'de');
    expect(out.title).toBe('Hallo');         // direct
    expect(out.body).toBe('## salut');       // de missing → fr
    expect(out.slug).toBe('bonjour');        // de missing → fr
    expect(out.published_at).toBe('2026-04-25');
  });

  it('falls back to top-level for fields with no locale match anywhere', () => {
    const partial = { title: 'Hello', _locale: { fr: {} } };
    const out = projectForLocale(partial, Post, 'fr');
    expect(out.title).toBe('Hello');
  });

  it('throws on a locale not declared by the type', () => {
    expect(() => projectForLocale(stored, Post, 'es')).toThrow(/locales\[\]/);
  });

  it('returns content unchanged when locale is undefined', () => {
    const out = projectForLocale(stored, Post, undefined);
    expect(out._locale).toBeUndefined();
    expect(out.title).toBe('Hello');
  });
});

describe('computeFallbackChain', () => {
  const Post = defineType(
    'post',
    { title: field.string({ localized: true }) },
    {
      locales: ['en', 'fr', 'fr-CA', 'de'],
      default_locale: 'en',
      fallback: { 'fr-CA': 'fr', de: 'fr' }
    }
  );

  it('chains through declared fallbacks to the default', () => {
    expect(computeFallbackChain(Post, 'fr-CA')).toEqual(['fr-CA', 'fr', 'en']);
    expect(computeFallbackChain(Post, 'de')).toEqual(['de', 'fr', 'en']);
    expect(computeFallbackChain(Post, 'fr')).toEqual(['fr', 'en']);
    expect(computeFallbackChain(Post, 'en')).toEqual(['en']);
  });

  it('returns empty for non-localized types', () => {
    const Plain = defineType('plain', { title: field.string() });
    expect(computeFallbackChain(Plain, 'en')).toEqual([]);
  });
});

describe('extractLocaleSlugs', () => {
  const Post = defineType(
    'post',
    {
      title: field.string({ required: true, localized: true }),
      slug: field.slug({ from: 'title', localized: true })
    },
    { locales: ['en', 'fr', 'de'], default_locale: 'en' }
  );

  it('returns a map of non-default-locale slugs', () => {
    const out = extractLocaleSlugs(
      Post,
      {
        title: 'Hello',
        slug: 'hello',
        _locale: {
          fr: { slug: 'bonjour' },
          de: { slug: 'hallo' }
        }
      },
      'slug'
    );
    expect(out).toEqual({ fr: 'bonjour', de: 'hallo' });
  });

  it('skips the default locale entry even if present', () => {
    const out = extractLocaleSlugs(
      Post,
      {
        title: 'Hello',
        slug: 'hello',
        _locale: { en: { slug: 'overridden' }, fr: { slug: 'bonjour' } }
      },
      'slug'
    );
    expect(out).toEqual({ fr: 'bonjour' });
  });

  it('returns undefined for non-localized types', () => {
    const Plain = defineType('plain', { title: field.string() });
    expect(extractLocaleSlugs(Plain, { title: 'x' }, 'slug')).toBeUndefined();
  });

  it('returns undefined when no _locale block is present', () => {
    expect(extractLocaleSlugs(Post, { title: 'x', slug: 'x' }, 'slug')).toBeUndefined();
  });
});
