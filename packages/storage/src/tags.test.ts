import { describe, it, expect } from 'vitest';
import { normalizeTag, normalizeTags } from './tags.js';

describe('normalizeTag', () => {
  it('preserves case in the label, lowercases the slug', () => {
    expect(normalizeTag('Featured Event')).toEqual({
      slug: 'featured-event',
      label: 'Featured Event'
    });
  });

  it('strips a leading # (any number of them)', () => {
    expect(normalizeTag('#hero')?.slug).toBe('hero');
    expect(normalizeTag('##hero')?.slug).toBe('hero');
    expect(normalizeTag('#  Featured Event')).toEqual({
      slug: 'featured-event',
      label: 'Featured Event'
    });
  });

  it('collapses whitespace runs and trims', () => {
    expect(normalizeTag('  Featured   Event   ')).toEqual({
      slug: 'featured-event',
      label: 'Featured Event'
    });
  });

  it('case variants all collapse to the same slug', () => {
    const a = normalizeTag('Featured Event');
    const b = normalizeTag('FEATURED EVENT');
    const c = normalizeTag('featured event');
    const d = normalizeTag('featured-event');
    expect(a?.slug).toBe(b?.slug);
    expect(a?.slug).toBe(c?.slug);
    expect(a?.slug).toBe(d?.slug);
    // Labels track whatever the caller wrote, in normalized whitespace form.
    expect(a?.label).toBe('Featured Event');
    expect(b?.label).toBe('FEATURED EVENT');
    expect(c?.label).toBe('featured event');
    expect(d?.label).toBe('featured-event');
  });

  it('drops unsupported punctuation from the slug but keeps a clean output', () => {
    expect(normalizeTag('q4! 2026')?.slug).toBe('q4-2026');
    expect(normalizeTag('hot/spot')?.slug).toBe('hotspot');
  });

  it('preserves underscores and hyphens', () => {
    expect(normalizeTag('snake_case-tag')?.slug).toBe('snake_case-tag');
  });

  it('rejects empty/whitespace-only/unsupported-only input', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('#')).toBeNull();
    expect(normalizeTag('@@@')).toBeNull();
    expect(normalizeTag('---')).toBeNull();
  });

  it('rejects non-strings', () => {
    expect(normalizeTag(null)).toBeNull();
    expect(normalizeTag(undefined)).toBeNull();
    expect(normalizeTag(42)).toBeNull();
    expect(normalizeTag({})).toBeNull();
  });

  it('accepts labels up to 64 chars', () => {
    expect(normalizeTag('a'.repeat(64))?.label).toHaveLength(64);
    expect(normalizeTag('a'.repeat(65))).toBeNull();
  });
});

describe('normalizeTags', () => {
  it('dedupes by slug and drops invalid entries', () => {
    const r = normalizeTags(['Featured Event', 'featured event', '#FEATURED EVENT', '@@@', null, '']);
    expect(r).toHaveLength(1);
    expect(r[0]?.slug).toBe('featured-event');
    // Whichever came first wins the label.
    expect(r[0]?.label).toBe('Featured Event');
  });

  it('preserves order of first appearance', () => {
    const r = normalizeTags(['hero', 'homepage', 'q4-launch', 'hero']);
    expect(r.map((t) => t.slug)).toEqual(['hero', 'homepage', 'q4-launch']);
  });
});
