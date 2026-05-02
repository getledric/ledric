import type {
  FieldString,
  FieldNumber,
  FieldBoolean,
  FieldDate,
  FieldSlug,
  FieldMarkdown,
  FieldAsset,
  FieldReferences,
  FieldArray,
  FieldVector,
  FieldEnum,
  FieldObject,
  FieldJss,
  FieldCss
} from './types.js';

type OptsFor<T extends { type: string }> = Omit<T, 'type'>;

export const field = {
  string: (opts: OptsFor<FieldString> = {}): FieldString => ({
    type: 'string',
    ...opts
  }),

  number: (opts: OptsFor<FieldNumber> = {}): FieldNumber => ({
    type: 'number',
    ...opts
  }),

  boolean: (opts: OptsFor<FieldBoolean> = {}): FieldBoolean => ({
    type: 'boolean',
    ...opts
  }),

  date: (opts: OptsFor<FieldDate> = {}): FieldDate => ({
    type: 'date',
    ...opts
  }),



  slug: (opts: OptsFor<FieldSlug> = {}): FieldSlug => ({
    type: 'slug',
    ...opts
  }),

  markdown: (opts: OptsFor<FieldMarkdown> = {}): FieldMarkdown => ({
    type: 'markdown',
    html: 'sanitize',
    ...opts
  }),

  asset: (opts: OptsFor<FieldAsset> = {}): FieldAsset => ({
    type: 'asset',
    ...opts
  }),

  references: (opts: OptsFor<FieldReferences>): FieldReferences => ({
    type: 'references',
    pinning: 'auto',
    ...opts
  }),

  array: (opts: OptsFor<FieldArray>): FieldArray => ({
    type: 'array',
    ...opts
  }),

  vector: (opts: OptsFor<FieldVector>): FieldVector => ({
    type: 'vector',
    ...opts
  }),

  enum: (opts: OptsFor<FieldEnum>): FieldEnum => ({
    type: 'enum',
    ...opts
  }),

  object: (opts: OptsFor<FieldObject>): FieldObject => ({
    type: 'object',
    ...opts
  }),

  jss: (opts: OptsFor<FieldJss> = {}): FieldJss => ({
    type: 'jss',
    ...opts
  }),

  css: (opts: OptsFor<FieldCss> = {}): FieldCss => ({
    type: 'css',
    ...opts
  })
} as const;
