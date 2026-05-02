// Per-field-type metadata: required keys, optional keys, and a complete
// example for each discriminator. The same source feeds two consumers:
//
//   - `validateFieldDef` uses `required` to surface clear errors when a
//     mandatory sub-property is missing (e.g. array without `of`,
//     references without `to`).
//   - `Core.describeModel()` projects the whole catalogue into its
//     response, so an LLM constructing a new type never has to guess
//     which keys belong on which discriminator.
//
// Keep the example values valid against the field's TypeScript type —
// they're verbatim what an agent sees and is likely to copy.

import type { FieldDef, FieldType } from './types.js';

export interface FieldTypeSpec {
  /** One-line summary for the catalogue. */
  description: string;
  /** Keys required beyond the `type` discriminator. */
  required: readonly string[];
  /** Optional keys specific to this field type, plus the FieldCommon ones. */
  optional: readonly string[];
  /** A complete, valid field definition usable as a copy-paste template. */
  example: FieldDef;
  /**
   * Wire shape — how this field's *value* (the data, not the field def)
   * looks on read and write. Encoded inline so an agent never has to
   * cross-reference SERVER_INSTRUCTIONS or prose docs to know whether
   * an `asset` is a stable id or an expanded object, or whether
   * `references` is a string array or an array of `{type, slug}` objects.
   *
   * Present only on field types where the input and output shapes
   * diverge or are non-obvious. Trivial mappings (`string` → string,
   * `number` → number) omit it.
   */
  wire_shape?: WireShape;
}

export interface WireShape {
  /** How an agent should *write* the value (input shape). */
  input: string;
  /** A concrete, valid input. Must round-trip through validation. */
  input_example: unknown;
  /** How the value comes back from `read` / `find` (output shape). */
  output: string;
  /** When read with the relevant resolution param, the projected shape. */
  output_example_resolved?: unknown;
  /** Anything else worth knowing — gotchas, related query params. */
  notes?: string;
}

const COMMON_OPTIONAL = [
  'required',
  'default',
  'description',
  'localized',
  'indexed',
  'deprecated',
  'private'
] as const;

export const FIELD_TYPE_SPECS: Record<FieldType, FieldTypeSpec> = {
  string: {
    description: 'Plain text. Stored as TEXT.',
    required: [],
    optional: ['min', 'max', 'pattern', 'unique', 'searchable', ...COMMON_OPTIONAL],
    example: { type: 'string', required: true, max: 120 }
  },
  number: {
    description: 'Numeric. Stored as REAL (or INTEGER when integer:true).',
    required: [],
    optional: ['min', 'max', 'integer', 'unique', ...COMMON_OPTIONAL],
    example: { type: 'number', min: 0, max: 100 }
  },
  boolean: {
    description: 'True or false.',
    required: [],
    optional: [...COMMON_OPTIONAL],
    example: { type: 'boolean', default: false }
  },
  date: {
    description: 'ISO 8601 date string (YYYY-MM-DD) or datetime.',
    required: [],
    optional: ['unique', ...COMMON_OPTIONAL],
    example: { type: 'date' },
    wire_shape: {
      input: 'YYYY-MM-DD string (or full ISO datetime). NOT a JS Date object.',
      input_example: '2026-05-01',
      output: 'Same string, untouched.',
      notes:
        "Watch out for `new Date('YYYY-MM-DD')` — that parses as UTC midnight, which renders as the previous day in negative-UTC timezones. Parse manually if the local-day matters: `const [y,m,d]=iso.split('-').map(Number); new Date(y,m-1,d)`."
    }
  },
  slug: {
    description:
      'URL-safe identifier. Lowercase alphanumerics + hyphens. Auto-derives from another field via "from".',
    required: [],
    optional: ['from', 'on_change', ...COMMON_OPTIONAL],
    example: { type: 'slug', required: true, from: 'title' }
  },
  enum: {
    description: 'One value from a fixed list of strings.',
    required: ['values'],
    optional: [...COMMON_OPTIONAL],
    example: { type: 'enum', values: ['draft', 'published'], default: 'draft' }
  },
  markdown: {
    description:
      'Rich text as Markdown (string). Per-field HTML policy; defaults to "sanitize".',
    required: [],
    optional: ['html', 'max', 'searchable', ...COMMON_OPTIONAL],
    example: { type: 'markdown', required: true },
    wire_shape: {
      input: 'Raw Markdown source as a string.',
      input_example: '# Hello\n\nA paragraph with a :::ref{to="blog_post/why-kysely"}::: directive.',
      output: 'Same raw Markdown source — ledric does not render to HTML.',
      output_example_resolved:
        '(unchanged body, plus a sibling `_refs` sidecar listing resolved targets when read with resolve_refs:true)',
      notes:
        'Inline references use the directive `:::ref{to="type/slug"}:::` (optionally `@version` pin). Pass `resolve_refs: true` on read/find to get a `_refs` sidecar — the body itself is never rewritten.'
    }
  },
  asset: {
    description:
      'Reference to an uploaded file by 32-char hex id. Optional kind / MIME / size / dimension constraints checked when the field is set.',
    required: [],
    optional: [
      'kinds',
      'multiple',
      'mime_types',
      'max_size_bytes',
      'min_width',
      'max_width',
      'min_height',
      'max_height',
      'aspect_ratio',
      ...COMMON_OPTIONAL
    ],
    example: {
      type: 'asset',
      kinds: ['image'],
      mime_types: ['image/jpeg', 'image/png', 'image/webp'],
      max_size_bytes: 5_000_000,
      min_width: 800
    },
    wire_shape: {
      input: '32-char hex stable asset id (the value POST /assets returns as `id`).',
      input_example: '0193ec4b8a1c7d3e9f2b6c5d4a8e7f0d',
      output:
        'Same 32-char hex id by default — opaque to the consumer. Pass `expand_assets: true` (or a list of field names) on read/find to inline the resolved object.',
      output_example_resolved: {
        id: '0193ec4b8a1c7d3e9f2b6c5d4a8e7f0d',
        ref_key: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
        kind: 'image',
        version: 1,
        meta: { mime: 'image/jpeg', filename: 'hero.jpg', alt: 'Team photo' },
        url: '/assets/a1b2c3d4e5f60718293a4b5c6d7e8f90'
      },
      notes:
        'Bytes URLs are keyed on `ref_key` (per-version, immutable). The id is stable across versions; ledric serves `/assets/<id>` as a 302 to the current ref_key URL when used directly. Image transforms (`?w=400&fm=webp&...`) attach to the URL.'
    }
  },
  references: {
    description:
      'Reference(s) to other entries. Cross-type, cardinality-aware, optional version pinning.',
    required: ['to'],
    optional: ['min', 'max', 'pinning', ...COMMON_OPTIONAL],
    example: { type: 'references', to: ['author'], min: 1, max: 1 },
    wire_shape: {
      input:
        'Array of "type/slug" strings, optionally "type/slug@version" to pin. ALWAYS strings — never an array of objects.',
      input_example: ['blog_post/hello', 'blog_post/world@3'],
      output:
        'Same array of strings by default. Pass `resolve_references: true` (or a list of field names) on read/find to inline each ref as an Entry envelope.',
      output_example_resolved: [
        {
          id: '0193cf2c1234567890abcdef12345678',
          type: 'blog_post',
          slug: 'hello',
          version: 4,
          fields: { title: 'Hello, world' }
        }
      ],
      notes:
        'Dangling or wrong-typed refs surface as warnings on draft (the draft saves) and errors on publish (VALIDATION_FAILED).'
    }
  },
  array: {
    description:
      'List of any field type. The element shape goes in "of" (NOT "items").',
    required: ['of'],
    optional: ['min', 'max', ...COMMON_OPTIONAL],
    example: { type: 'array', of: { type: 'string' } }
  },
  object: {
    description:
      'Nested key/value with its own field schema in "fields". Strict by default.',
    required: ['fields'],
    optional: ['strict', ...COMMON_OPTIONAL],
    example: {
      type: 'object',
      fields: { name: { type: 'string' } }
    }
  },
  vector: {
    description:
      'Embedding column for similarity search. Opaque to ledric — pick your own model.',
    required: ['dims'],
    optional: ['byo', ...COMMON_OPTIONAL],
    example: { type: 'vector', dims: 1536, byo: true },
    wire_shape: {
      input: 'Array of finite numbers with length === dims.',
      input_example: '[0.0123, -0.0456, 0.0789, ...]  (length must match the field def\'s `dims`)',
      output: 'Same array.',
      notes:
        'You generate these in your embedding pipeline and write them through draft. Ledric does not embed for you.'
    }
  },
  jss: {
    description:
      'CSS-in-JS object stored as JSON. Top-level keys are CSS selectors; values are rule objects.',
    required: [],
    optional: [...COMMON_OPTIONAL],
    example: { type: 'jss' }
  },
  css: {
    description: 'Raw CSS source string.',
    required: [],
    optional: ['max', ...COMMON_OPTIONAL],
    example: { type: 'css', max: 4096 }
  }
};
