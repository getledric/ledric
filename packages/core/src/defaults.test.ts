import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { defineType, field } from '@ledric/schema';
import { Core } from './core.js';
import { SqliteStorage } from '@ledric/storage';
import { deriveContent } from './derive.js';
import { validateContent } from './validate.js';

describe('field defaults', () => {
  describe('defineType validation', () => {
    it('rejects a string default that is not a string', () => {
      expect(() =>
        defineType('t', {
          slug: field.string({ required: true }),
          // `default: unknown` widens enough that TS is happy; runtime rejects.
          n: field.string({ default: 42 as unknown as string })
        })
      ).toThrow(/default value/);
    });

    it('rejects an enum default that is not in values', () => {
      expect(() =>
        defineType('t', {
          slug: field.string({ required: true }),
          style: field.enum({ values: ['a', 'b'], default: 'c' })
        })
      ).toThrow(/default value/);
    });

    it('accepts well-typed defaults', () => {
      const T = defineType('t', {
        slug: field.string({ required: true }),
        title: field.string({ default: 'Untitled' }),
        published: field.boolean({ default: false }),
        priority: field.number({ default: 0, min: 0 }),
        style: field.enum({ values: ['a', 'b'], default: 'a' }),
        tags: field.array({ of: field.string(), default: [] })
      });
      expect(T.fields.title?.default).toBe('Untitled');
      expect(T.fields.style?.default).toBe('a');
    });
  });

  describe('write-time application', () => {
    const Post = defineType(
      'post',
      {
        slug: field.string({ required: true }),
        title: field.string({ default: 'Untitled' }),
        published: field.boolean({ default: false }),
        priority: field.number({ default: 0 }),
        tags: field.array({ of: field.string(), default: [] })
      },
      { identifier_field: 'slug' }
    );

    it('fills in scalar defaults when content omits them', () => {
      const out = deriveContent(Post, { slug: 'x' });
      expect(out.title).toBe('Untitled');
      expect(out.published).toBe(false);
      expect(out.priority).toBe(0);
      expect(out.tags).toEqual([]);
    });

    it('does not override an explicit value', () => {
      const out = deriveContent(Post, {
        slug: 'x',
        title: 'Real Title',
        published: true,
        priority: 5
      });
      expect(out.title).toBe('Real Title');
      expect(out.published).toBe(true);
      expect(out.priority).toBe(5);
    });

    it('treats null as absent — the default applies', () => {
      const out = deriveContent(Post, { slug: 'x', title: null });
      expect(out.title).toBe('Untitled');
    });

    it('clones object/array defaults — never the same reference twice', () => {
      const out1 = deriveContent(Post, { slug: 'a' }) as { tags: string[] };
      const out2 = deriveContent(Post, { slug: 'b' }) as { tags: string[] };
      out1.tags.push('mutated');
      expect(out2.tags).toEqual([]);
    });
  });

  describe('object field nested defaults — the user repro', () => {
    const CtaBand = defineType(
      'cta_band',
      {
        slug: field.string({ required: true, max: 200 }),
        headline: field.string({ required: true, max: 200 }),
        cta: field.object({
          fields: {
            label: field.string({ required: true, max: 80 }),
            url: field.string({ required: true, max: 500 }),
            style: field.enum({
              values: ['automatic', 'primary', 'secondary'],
              default: 'automatic'
            }),
            new_tab: field.boolean({ default: false })
          }
        })
      },
      { identifier_field: 'slug' }
    );

    it('case 3 — {label, url} fills style + new_tab from defaults', () => {
      const derived = deriveContent(CtaBand, {
        slug: 'home',
        headline: 'Get going',
        cta: { label: 'Sign up', url: 'https://x' }
      });
      expect((derived.cta as Record<string, unknown>).style).toBe('automatic');
      expect((derived.cta as Record<string, unknown>).new_tab).toBe(false);
      const v = validateContent(CtaBand, derived);
      expect(v.ok).toBe(true);
    });

    it('case 4 — {} still flags label + url as missing required', () => {
      const derived = deriveContent(CtaBand, {
        slug: 'home',
        headline: 'Get going',
        cta: {}
      });
      // The defaults for style + new_tab still apply...
      expect((derived.cta as Record<string, unknown>).style).toBe('automatic');
      expect((derived.cta as Record<string, unknown>).new_tab).toBe(false);
      // ...but label + url stay missing and validation fails clearly.
      const v = validateContent(CtaBand, derived);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      const codes = v.errors.map((e) => e.code).sort();
      expect(codes).toEqual(['required', 'required']);
    });

    it('does not auto-create the outer cta when it is omitted entirely', () => {
      // No default on `cta` itself; user omits it. Stays absent.
      const derived = deriveContent(CtaBand, { slug: 'home', headline: 'h' });
      expect(derived.cta).toBeUndefined();
    });
  });

  describe('end-to-end through Core.draft', () => {
    let storage: SqliteStorage;
    let core: Core;

    beforeEach(async () => {
      storage = await SqliteStorage.open({ path: ':memory:' });
      core = new Core(storage);
      await core.createType({
        name: 'cta_band',
        fields: {
          slug: { type: 'string', required: true, max: 200 },
          headline: { type: 'string', required: true, max: 200 },
          cta: {
            type: 'object',
            fields: {
              label: { type: 'string', required: true, max: 80 },
              url: { type: 'string', required: true, max: 500 },
              style: {
                type: 'enum',
                values: ['automatic', 'primary', 'secondary'],
                default: 'automatic'
              },
              new_tab: { type: 'boolean', default: false }
            }
          }
        },
        opts: { identifier_field: 'slug' }
      });
    });

    afterEach(async () => {
      await storage.close();
    });

    it('drafts succeed with the partial cta and the defaults are stored', async () => {
      const drafted = await core.draft({
        type: 'cta_band',
        fields: {
          slug: 'home',
          headline: 'Get going',
          cta: { label: 'Sign up', url: 'https://x' }
        }
      });
      const cta = drafted.content.cta as Record<string, unknown>;
      expect(cta.style).toBe('automatic');
      expect(cta.new_tab).toBe(false);

      // Defaults are persisted, not transient.
      const re = await core.read({ ref: { type: 'cta_band', slug: 'home' } });
      expect((re?.content.cta as Record<string, unknown>).style).toBe('automatic');
    });
  });
});
