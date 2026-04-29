import { describe, it, expect } from 'vitest';
import { defineType } from './define-type.js';
import { field } from './field.js';

describe('defineType', () => {
  const Product = defineType(
    'product',
    {
      title: field.string({ required: true, max: 120 }),
      slug: field.slug({ from: 'title' }),
      price: field.number({ min: 0 })
    },
    {
      summary_fields: ['title', 'slug', 'price'],
      display_field: 'title',
      identifier_field: 'slug',
      example: { title: 'Widget Pro', slug: 'widget-pro', price: 49 }
    }
  );

  it('returns the provided name', () => {
    expect(Product.name).toBe('product');
  });

  it('preserves fields', () => {
    expect(Object.keys(Product.fields).sort()).toEqual(['price', 'slug', 'title']);
    expect(Product.fields.title).toEqual({ type: 'string', required: true, max: 120 });
  });

  it('preserves options', () => {
    expect(Product.summary_fields).toEqual(['title', 'slug', 'price']);
    expect(Product.display_field).toBe('title');
    expect(Product.identifier_field).toBe('slug');
    expect(Product.example).toEqual({ title: 'Widget Pro', slug: 'widget-pro', price: 49 });
  });

  it('round-trips cleanly through JSON', () => {
    const json = JSON.stringify(Product);
    const parsed = JSON.parse(json) as typeof Product;
    expect(parsed.name).toBe('product');
    expect(parsed.fields.slug?.type).toBe('slug');
    if (parsed.fields.title && parsed.fields.title.type === 'string') {
      expect(parsed.fields.title.max).toBe(120);
    }
  });

  it('throws on an invalid type name', () => {
    expect(() => defineType('Bad-Name', { a: field.string() })).toThrow(/type name/);
  });

  it('throws on an invalid field name', () => {
    expect(() => defineType('ok_type', { 'bad-name': field.string() })).toThrow(/field name/);
  });

  it('throws on empty fields', () => {
    expect(() => defineType('ok_type', {})).toThrow(/at least one field/);
  });

  it('throws when summary_fields references an unknown field', () => {
    expect(() =>
      defineType(
        'product',
        { title: field.string() },
        { summary_fields: ['nope'] }
      )
    ).toThrow(/summary_fields.+nope/);
  });

  it('throws when identifier_field references an unknown field', () => {
    expect(() =>
      defineType(
        'product',
        { title: field.string() },
        { identifier_field: 'missing' }
      )
    ).toThrow(/identifier_field.+missing/);
  });

  it('rejects an unknown field type discriminator', () => {
    expect(() =>
      defineType('cta_band', {
        slug: field.string({ required: true }),
        cta: { type: 'object_pretender' } as unknown as Parameters<typeof defineType>[1]['cta']
      })
    ).toThrow(/unknown type/);
  });

  it('rejects an unknown nested field type inside an object', () => {
    expect(() =>
      defineType('cta_band', {
        slug: field.string({ required: true }),
        cta: field.object({
          fields: {
            label: field.string({ required: true }),
            mystery: { type: 'foo' } as unknown as Parameters<typeof defineType>[1]['mystery']
          }
        })
      })
    ).toThrow(/unknown type/);
  });

  it('accepts a fully-typed object field', () => {
    const T = defineType('cta_band', {
      slug: field.string({ required: true }),
      headline: field.string({ required: true, max: 200 }),
      cta: field.object({
        fields: {
          label: field.string({ required: true, max: 80 }),
          url: field.string({ required: true, max: 500 }),
          style: field.enum({ values: ['automatic', 'primary', 'secondary'] }),
          new_tab: field.boolean()
        }
      })
    }, { identifier_field: 'slug' });
    expect(T.fields.cta?.type).toBe('object');
  });

  it('throws when display_field references an unknown field', () => {
    expect(() =>
      defineType(
        'product',
        { title: field.string() },
        { display_field: 'missing' }
      )
    ).toThrow(/display_field.+missing/);
  });

  it('accepts jss and css fields with sensible defaults', () => {
    const T = defineType('block', {
      slug: field.string({ required: true }),
      style: field.jss({ default: { '.root': { color: 'red' } } }),
      raw_css: field.css({ max: 5000, default: '' })
    }, { identifier_field: 'slug' });
    expect(T.fields.style?.type).toBe('jss');
    expect(T.fields.raw_css?.type).toBe('css');
  });

  it('rejects a jss default that is not an object', () => {
    expect(() =>
      defineType('block', {
        slug: field.string({ required: true }),
        style: field.jss({ default: 'not an object' as unknown as Record<string, unknown> })
      })
    ).toThrow(/default value that doesn't match/);
  });

  it('rejects a css default that is not a string', () => {
    expect(() =>
      defineType('block', {
        slug: field.string({ required: true }),
        raw_css: field.css({ default: 42 as unknown as string })
      })
    ).toThrow(/default value that doesn't match/);
  });
});
