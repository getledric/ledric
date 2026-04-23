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

  it('throws when display_field references an unknown field', () => {
    expect(() =>
      defineType(
        'product',
        { title: field.string() },
        { display_field: 'missing' }
      )
    ).toThrow(/display_field.+missing/);
  });
});
