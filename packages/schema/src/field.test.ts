import { describe, it, expect } from 'vitest';
import { field } from './field.js';

describe('field builders', () => {
  it('string returns the requested shape', () => {
    expect(field.string({ max: 120, required: true })).toEqual({
      type: 'string',
      max: 120,
      required: true
    });
  });

  it('string with no opts has just a type discriminator', () => {
    expect(field.string()).toEqual({ type: 'string' });
  });

  it('number accepts min/max/integer', () => {
    expect(field.number({ min: 0, max: 100, integer: true })).toEqual({
      type: 'number',
      min: 0,
      max: 100,
      integer: true
    });
  });

  it('slug defaults unique to true', () => {
    expect(field.slug().unique).toBe(true);
  });

  it('slug respects an explicit unique override', () => {
    expect(field.slug({ unique: false }).unique).toBe(false);
  });

  it('markdown defaults html to sanitize', () => {
    expect(field.markdown().html).toBe('sanitize');
  });

  it('markdown respects an explicit html override', () => {
    expect(field.markdown({ html: 'allow' }).html).toBe('allow');
  });

  it('references defaults pinning to auto', () => {
    expect(field.references({ to: ['product'] }).pinning).toBe('auto');
  });

  it('array composes with an inner field', () => {
    const tags = field.array({ of: field.string({ max: 40 }), max: 20 });
    expect(tags.type).toBe('array');
    expect(tags.of).toEqual({ type: 'string', max: 40 });
    expect(tags.max).toBe(20);
  });

  it('vector carries dims and byo', () => {
    expect(field.vector({ dims: 1536, byo: true })).toEqual({
      type: 'vector',
      dims: 1536,
      byo: true
    });
  });

  it('enum carries values', () => {
    expect(field.enum({ values: ['draft', 'published'] })).toEqual({
      type: 'enum',
      values: ['draft', 'published']
    });
  });

  it('builder output is JSON-serializable', () => {
    const def = field.string({ max: 10 });
    const parsed = JSON.parse(JSON.stringify(def)) as typeof def;
    expect(parsed).toEqual(def);
  });
});
