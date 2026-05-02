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
    example: { type: 'date' }
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
    example: { type: 'markdown', required: true }
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
    }
  },
  references: {
    description:
      'Reference(s) to other entries. Cross-type, cardinality-aware, optional version pinning.',
    required: ['to'],
    optional: ['min', 'max', 'pinning', ...COMMON_OPTIONAL],
    example: { type: 'references', to: ['author'], min: 1, max: 1 }
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
    example: { type: 'vector', dims: 1536, byo: true }
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
