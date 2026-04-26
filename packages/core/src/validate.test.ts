import { describe, it, expect } from 'vitest';
import { defineType, field } from '@ledric/schema';
import { validateContent } from './validate.js';

describe('validateContent — object field', () => {
  const CtaBand = defineType(
    'cta_band',
    {
      slug: field.string({ required: true, max: 200 }),
      headline: field.string({ required: true, max: 200 }),
      cta: field.object({
        fields: {
          label: field.string({ required: true, max: 80 }),
          url: field.string({ required: true, max: 500 }),
          style: field.enum({ values: ['automatic', 'primary', 'secondary'] }),
          new_tab: field.boolean()
        }
      })
    },
    { identifier_field: 'slug' }
  );

  it('accepts a fully-specified nested object', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: {
        label: 'Sign up',
        url: 'https://example.com',
        style: 'primary',
        new_tab: false
      }
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a partial object as long as required nested fields are present', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: { label: 'Sign up', url: 'https://example.com' }
    });
    expect(r.ok).toBe(true);
  });

  it('reports the SPECIFIC missing nested field for an empty object', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: {}
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.errors.map((e) => e.code).sort();
    expect(codes).toEqual(['required', 'required']);
    const paths = r.errors.map((e) => e.path).sort();
    expect(paths).toEqual(['/cta/label', '/cta/url']);
  });

  it('reports a wrong type cleanly when a non-object lands in an object field', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: 'not-an-object'
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.code).toBe('type');
    expect(r.errors[0]?.path).toBe('/cta');
    expect(r.errors[0]?.message).toMatch(/Expected object/);
  });

  it('treats a null object value as "not present" — same as a missing key', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: null
    });
    expect(r.ok).toBe(true);
  });

  it('rejects unknown nested keys when strict (the default)', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: {
        label: 'Sign up',
        url: 'https://example.com',
        mystery: 'unexpected'
      }
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const codes = r.errors.map((e) => e.code);
    expect(codes).toContain('unknown_field');
  });

  it('passes through unknown nested keys when strict: false', () => {
    const Loose = defineType(
      'loose',
      {
        slug: field.string({ required: true }),
        bag: field.object({
          fields: { kind: field.string() },
          strict: false
        })
      },
      { identifier_field: 'slug' }
    );
    const r = validateContent(Loose, {
      slug: 'x',
      bag: { kind: 'thing', extra1: 1, extra2: 'two' }
    });
    expect(r.ok).toBe(true);
  });

  it('reports nested validation errors with full JSON-Pointer paths', () => {
    const r = validateContent(CtaBand, {
      slug: 'home-cta',
      headline: 'Get started',
      cta: { label: 'a', url: 'b', style: 'not-a-valid-style' }
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const enumErr = r.errors.find((e) => e.code === 'enum');
    expect(enumErr).toBeDefined();
    expect(enumErr?.path).toBe('/cta/style');
  });
});
