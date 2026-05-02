import { describe, it, expect } from 'vitest';
import { generateTypes } from './types.js';
import type { DescribeModelResult } from '@ledric/core';

const baseCapabilities = {
  vectorSearch: false,
  nativePubSub: false,
  fts: 'fts5' as const,
  imageTransforms: { enabled: true as const, params: {}, example: '' },
  refValidation: true,
  fieldTypes: [],
  fieldTypeSpecs: {},
  consumer_guidance: ''
};
const baseConventions = { name_pattern: '', reserved_content_keys: [], notes: '' };

function modelWith(types: DescribeModelResult['types']): DescribeModelResult {
  return {
    schema_version: 1,
    types,
    capabilities: baseCapabilities,
    conventions: baseConventions
  };
}

describe('generateTypes', () => {
  it('emits branded primitives and the Entry<F> envelope', () => {
    const out = generateTypes(modelWith({}));
    expect(out).toContain('export type AssetId =');
    expect(out).toContain('export type EntryRef<T extends string = string>');
    expect(out).toContain('export type DateString =');
    expect(out).toContain('export type MarkdownString =');
    expect(out).toContain('export interface Entry<F>');
    expect(out).toContain('fields: F;');
  });

  it('maps primitive field types to TS scalars', () => {
    const out = generateTypes(
      modelWith({
        post: {
          name: 'post',
          version: 1,
          fields: {
            title: { type: 'string', required: true },
            count: { type: 'number' },
            published: { type: 'boolean', required: true },
            published_at: { type: 'date' },
            slug: { type: 'slug' },
            body: { type: 'markdown' },
            hero: { type: 'asset' }
          }
        }
      })
    );
    expect(out).toContain('export interface Post {');
    expect(out).toContain('title: string;');
    expect(out).toContain('count?: number;');
    expect(out).toContain('published: boolean;');
    expect(out).toContain('published_at?: DateString;');
    expect(out).toContain('slug?: string;');
    expect(out).toContain('body?: MarkdownString;');
    expect(out).toContain('hero?: AssetId;');
  });

  it('emits enum as a string-literal union', () => {
    const out = generateTypes(
      modelWith({
        cta: {
          name: 'cta',
          version: 1,
          fields: {
            style: { type: 'enum', values: ['primary', 'ghost', 'link'], required: true }
          }
        }
      })
    );
    expect(out).toContain('style: "primary" | "ghost" | "link";');
  });

  it('emits references as EntryRef<T>[] with the union of allowed types', () => {
    const out = generateTypes(
      modelWith({
        post: {
          name: 'post',
          version: 1,
          fields: {
            authors: { type: 'references', to: ['author', 'editor'], required: true }
          }
        }
      })
    );
    expect(out).toContain("authors: EntryRef<'author' | 'editor'>[];");
  });

  it('recurses into object fields', () => {
    const out = generateTypes(
      modelWith({
        page: {
          name: 'page',
          version: 1,
          fields: {
            cta: {
              type: 'object',
              fields: {
                label: { type: 'string', required: true },
                url: { type: 'string', required: true },
                style: { type: 'enum', values: ['primary', 'ghost'] }
              }
            }
          }
        }
      })
    );
    expect(out).toMatch(/cta\?: \{[\s\S]*label: string;[\s\S]*url: string;[\s\S]*style\?: "primary" \| "ghost";[\s\S]*\};/);
  });

  it('wraps array of unions in parentheses for valid TS parsing', () => {
    const out = generateTypes(
      modelWith({
        post: {
          name: 'post',
          version: 1,
          fields: {
            modes: { type: 'array', of: { type: 'enum', values: ['a', 'b'] }, required: true }
          }
        }
      })
    );
    expect(out).toContain('modes: ("a" | "b")[];');
  });

  it('emits the Entries map keyed by type name', () => {
    const out = generateTypes(
      modelWith({
        blog_post: { name: 'blog_post', version: 1, fields: { title: { type: 'string' } } },
        author: { name: 'author', version: 1, fields: { name: { type: 'string' } } }
      })
    );
    expect(out).toContain('export interface Entries {');
    expect(out).toContain('blog_post: BlogPost;');
    expect(out).toContain('author: Author;');
  });

  it('augments @ledric/sdk when augmentSdk: true', () => {
    const out = generateTypes(modelWith({ post: { name: 'post', version: 1, fields: {} } }), {
      augmentSdk: true
    });
    expect(out).toContain("declare module '@ledric/sdk'");
    expect(out).toContain('interface LedricEntries extends Entries {}');
  });

  it('produces deterministic output regardless of insertion order', () => {
    const a = generateTypes(
      modelWith({
        b_type: { name: 'b_type', version: 1, fields: { x: { type: 'string' } } },
        a_type: { name: 'a_type', version: 1, fields: { y: { type: 'string' } } }
      })
    );
    const b = generateTypes(
      modelWith({
        a_type: { name: 'a_type', version: 1, fields: { y: { type: 'string' } } },
        b_type: { name: 'b_type', version: 1, fields: { x: { type: 'string' } } }
      })
    );
    expect(a).toBe(b);
  });
});
