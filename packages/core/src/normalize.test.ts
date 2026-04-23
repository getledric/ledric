import { describe, it, expect } from 'vitest';
import { defineType, field } from '@ledric/schema';
import { normalizeTypeDef, normalizeField } from './normalize.js';

describe('normalizeField', () => {
  it('fills html=sanitize on markdown when missing', () => {
    const normalized = normalizeField({ type: 'markdown' });
    expect(normalized).toEqual({ type: 'markdown', html: 'sanitize' });
  });

  it('leaves html alone on markdown when explicitly set', () => {
    const normalized = normalizeField({ type: 'markdown', html: 'allow' });
    expect(normalized).toEqual({ type: 'markdown', html: 'allow' });
  });

  it('fills pinning=auto on references when missing', () => {
    const normalized = normalizeField({ type: 'references', to: ['product'] });
    expect(normalized).toEqual({ type: 'references', to: ['product'], pinning: 'auto' });
  });

  it('recurses into array.of', () => {
    const normalized = normalizeField({
      type: 'array',
      of: { type: 'markdown' }
    });
    expect(normalized).toEqual({
      type: 'array',
      of: { type: 'markdown', html: 'sanitize' }
    });
  });

  it('leaves slug untouched (uniqueness is an invariant, not an option)', () => {
    const normalized = normalizeField({ type: 'slug', from: 'title' });
    expect(normalized).toEqual({ type: 'slug', from: 'title' });
  });
});

describe('normalizeTypeDef', () => {
  it('produces the same shape whether authored via builder or raw JSON', () => {
    const viaBuilder = defineType('blog_post', {
      title: field.string({ required: true }),
      slug: field.slug({ from: 'title' }),
      body: field.markdown()
    });

    const viaJson = {
      name: 'blog_post',
      fields: {
        title: { type: 'string', required: true },
        slug: { type: 'slug', from: 'title' },
        body: { type: 'markdown' }
      }
    } as ReturnType<typeof defineType>;

    const normalizedBuilder = normalizeTypeDef(viaBuilder);
    const normalizedJson = normalizeTypeDef(viaJson);
    expect(normalizedJson).toEqual(normalizedBuilder);
    expect(normalizedJson.fields.body).toEqual({ type: 'markdown', html: 'sanitize' });
  });
});
