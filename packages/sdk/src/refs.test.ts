import { describe, it, expect } from 'vitest';
import { refAttrs, refAttrsHtml } from './refs.js';

describe('refAttrs', () => {
  it('returns the data-ledric-ref attribute for a complete entry', () => {
    expect(refAttrs({ type: 'blog_post', slug: 'hello-world' })).toEqual({
      'data-ledric-ref': 'blog_post/hello-world'
    });
  });

  it('adds data-ledric-field when a field name is given', () => {
    expect(refAttrs({ type: 'note', slug: 'a' }, 'title')).toEqual({
      'data-ledric-ref': 'note/a',
      'data-ledric-field': 'title'
    });
  });

  it('ignores empty field name', () => {
    expect(refAttrs({ type: 'note', slug: 'a' }, '')).toEqual({
      'data-ledric-ref': 'note/a'
    });
  });

  it('returns {} for null or undefined input — safe for templates', () => {
    expect(refAttrs(null)).toEqual({});
    expect(refAttrs(undefined)).toEqual({});
  });

  it('returns {} when type or slug are missing', () => {
    expect(refAttrs({ type: 'note' } as unknown as { type: string; slug: string })).toEqual({});
    expect(refAttrs({ slug: 'a' } as unknown as { type: string; slug: string })).toEqual({});
  });

  it('accepts richer Entry-shaped objects without complaint', () => {
    const entry = { id: 'x', type: 'note', slug: 'a', version: 1, fields: { title: 'A' } };
    expect(refAttrs(entry)).toEqual({ 'data-ledric-ref': 'note/a' });
  });
});

describe('refAttrsHtml', () => {
  it('renders attributes as a single string for HTML interpolation', () => {
    expect(refAttrsHtml({ type: 'note', slug: 'a' })).toBe(
      'data-ledric-ref="note/a"'
    );
    expect(refAttrsHtml({ type: 'note', slug: 'a' }, 'title')).toBe(
      'data-ledric-ref="note/a" data-ledric-field="title"'
    );
  });

  it('escapes ref values defensively (slug should never contain quotes, but fail safe)', () => {
    expect(refAttrsHtml({ type: 't', slug: 'a"b' })).toBe(
      'data-ledric-ref="t/a&quot;b"'
    );
  });

  it('returns "" for missing input', () => {
    expect(refAttrsHtml(null)).toBe('');
    expect(refAttrsHtml(undefined)).toBe('');
  });
});
