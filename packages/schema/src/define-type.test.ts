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

  // Required-key presence: tags every error with code "VALIDATION" so the
  // MCP boundary returns a structured response instead of a TOOL_ERROR
  // wrapping a raw JS TypeError.

  it('rejects an array field missing "of" with a path-prefixed message', () => {
    expect(() =>
      defineType('page', {
        tags: { type: 'array', items: { type: 'string' } } as never
      })
    ).toThrow(/page.*field "tags" \(type "array"\) is missing required property "of"/);
  });

  it('rejects an object field missing "fields"', () => {
    expect(() =>
      defineType('page', {
        meta: { type: 'object' } as never
      })
    ).toThrow(/page.*field "meta" \(type "object"\) is missing required property "fields"/);
  });

  it('rejects an enum without "values"', () => {
    expect(() =>
      defineType('page', {
        status: { type: 'enum' } as never
      })
    ).toThrow(/page.*field "status" \(type "enum"\) is missing required property "values"/);
  });

  it('rejects an empty enum values array', () => {
    expect(() =>
      defineType('page', {
        status: { type: 'enum', values: [] } as never
      })
    ).toThrow(/non-empty array of strings/);
  });

  it('rejects a references field without "to"', () => {
    expect(() =>
      defineType('page', {
        related: { type: 'references' } as never
      })
    ).toThrow(/page.*field "related" \(type "references"\) is missing required property "to"/);
  });

  it('rejects a vector field without "dims"', () => {
    expect(() =>
      defineType('page', {
        embedding: { type: 'vector' } as never
      })
    ).toThrow(/page.*field "embedding" \(type "vector"\) is missing required property "dims"/);
  });

  it('tags validation errors with code "VALIDATION"', () => {
    let captured: unknown;
    try {
      defineType('page', {
        tags: { type: 'array', items: { type: 'string' } } as never
      });
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error & { code?: string }).code).toBe('VALIDATION');
  });

  it('rejects a leading-underscore type name with a sidecar reason', () => {
    expect(() => defineType('_probe', { title: field.string() })).toThrow(
      /reserved for content sidecars/
    );
  });

  // unique constraint — schema-side validation
  it('accepts unique:true on string, number, and date fields', () => {
    const t = defineType('product', {
      sku: field.string({ required: true, unique: true }),
      stock: field.number({ unique: true }),
      released_on: field.date({ unique: true })
    });
    expect((t.fields.sku as { unique?: boolean }).unique).toBe(true);
    expect((t.fields.stock as { unique?: boolean }).unique).toBe(true);
    expect((t.fields.released_on as { unique?: boolean }).unique).toBe(true);
  });

  it('rejects unique:true on non-scalar field types', () => {
    expect(() =>
      defineType('product', {
        title: field.string({ required: true }),
        body: field.markdown({ unique: true } as never)
      })
    ).toThrow(/unique:true is only allowed on string, number, or date/);

    expect(() =>
      defineType('product', {
        title: field.string({ required: true }),
        gallery: field.array({ of: field.string(), unique: true } as never)
      })
    ).toThrow(/unique:true is only allowed on string, number, or date/);
  });

  it('rejects unique combined with localized:true', () => {
    expect(() =>
      defineType(
        'product',
        {
          sku: field.string({ required: true, unique: true, localized: true })
        },
        { locales: ['en', 'fr'], default_locale: 'en' }
      )
    ).toThrow(/cannot be both unique and localized/);
  });

  // Asset constraint shape validation — checked at defineType, before the
  // type ever stores anything.

  it('accepts asset fields with size, mime, dimension, aspect_ratio constraints', () => {
    const t = defineType('post', {
      title: field.string({ required: true }),
      hero: field.asset({
        kinds: ['image'],
        mime_types: ['image/jpeg', 'image/png'],
        max_size_bytes: 5_000_000,
        min_width: 800,
        max_width: 4000,
        aspect_ratio: '16:9'
      })
    });
    expect(t.fields.hero).toMatchObject({
      kinds: ['image'],
      mime_types: ['image/jpeg', 'image/png'],
      max_size_bytes: 5_000_000,
      aspect_ratio: '16:9'
    });
  });

  it('rejects an empty mime_types array', () => {
    expect(() =>
      defineType('post', {
        title: field.string({ required: true }),
        hero: field.asset({ mime_types: [] as never })
      })
    ).toThrow(/non-empty array of MIME strings/);
  });

  it('rejects mime_types entries that don\'t look like MIME', () => {
    expect(() =>
      defineType('post', {
        title: field.string({ required: true }),
        hero: field.asset({ mime_types: ['jpeg'] })
      })
    ).toThrow(/must look like MIME types/);
  });

  it('rejects non-positive max_size_bytes', () => {
    expect(() =>
      defineType('post', {
        title: field.string({ required: true }),
        hero: field.asset({ max_size_bytes: 0 })
      })
    ).toThrow(/max_size_bytes must be a positive integer/);
  });

  it('rejects malformed aspect_ratio', () => {
    expect(() =>
      defineType('post', {
        title: field.string({ required: true }),
        hero: field.asset({ aspect_ratio: '16x9' })
      })
    ).toThrow(/aspect_ratio must be a "W:H" string/);
  });

  // searchable flag — schema-side validation
  it('accepts searchable:true on string and markdown fields', () => {
    const t = defineType('post', {
      title: field.string({ required: true, searchable: true }),
      body: field.markdown({ required: true, searchable: true })
    });
    expect((t.fields.title as { searchable?: boolean }).searchable).toBe(true);
    expect((t.fields.body as { searchable?: boolean }).searchable).toBe(true);
  });

  it('rejects searchable:true on non-text field types', () => {
    expect(() =>
      defineType('post', {
        title: field.string({ required: true }),
        score: field.number({ searchable: true } as never)
      })
    ).toThrow(/searchable:true is only allowed on string or markdown/);

    expect(() =>
      defineType('post', {
        title: field.string({ required: true }),
        tags: field.array({ of: field.string(), searchable: true } as never)
      })
    ).toThrow(/searchable:true is only allowed on string or markdown/);
  });

  // example shape validation — references in the example must use the
  // input shape (string["type/slug"]), not the resolved-object shape.

  it('accepts an example with references as string["type/slug"] (input shape)', () => {
    const t = defineType(
      'post',
      {
        title: field.string({ required: true }),
        slug: field.slug({ from: 'title' }),
        author: field.references({ to: ['author'], min: 1, max: 1 })
      },
      {
        example: {
          title: 'Hello',
          slug: 'hello',
          author: ['author/ada-lovelace']
        }
      }
    );
    expect(t.example).toMatchObject({ author: ['author/ada-lovelace'] });
  });

  it('rejects an example with references as objects (output shape)', () => {
    expect(() =>
      defineType(
        'post',
        {
          title: field.string({ required: true }),
          author: field.references({ to: ['author'], min: 1, max: 1 })
        },
        {
          example: {
            title: 'Hello',
            author: [{ type: 'author', slug: 'ada-lovelace' } as never]
          }
        }
      )
    ).toThrow(/references in examples take the input shape/);
  });

  it('rejects an example where references is a bare object (not an array)', () => {
    expect(() =>
      defineType(
        'post',
        {
          title: field.string({ required: true }),
          author: field.references({ to: ['author'], min: 1, max: 1 })
        },
        {
          example: {
            title: 'Hello',
            author: { type: 'author', slug: 'ada-lovelace' } as never
          }
        }
      )
    ).toThrow(/must be an array of "type\/slug" strings/);
  });
});
