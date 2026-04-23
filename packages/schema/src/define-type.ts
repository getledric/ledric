import type { FieldDef, TypeDef, TypeDefOptions } from './types.js';

const SLUG_NAME_RE = /^[a-z][a-z0-9_]*$/;

export function defineType(
  name: string,
  fields: Record<string, FieldDef>,
  opts: TypeDefOptions = {}
): TypeDef {
  if (!SLUG_NAME_RE.test(name)) {
    throw new Error(
      `defineType: type name "${name}" must match ${SLUG_NAME_RE.source} (lowercase, starts with a letter, underscores allowed)`
    );
  }

  if (Object.keys(fields).length === 0) {
    throw new Error(`defineType("${name}"): at least one field is required`);
  }

  for (const fieldName of Object.keys(fields)) {
    if (!SLUG_NAME_RE.test(fieldName)) {
      throw new Error(
        `defineType("${name}"): field name "${fieldName}" must match ${SLUG_NAME_RE.source}`
      );
    }
  }

  const refsKnown = (key: 'summary_fields' | 'identifier_field' | 'display_field', value: string) => {
    if (!(value in fields)) {
      throw new Error(
        `defineType("${name}"): ${key} references unknown field "${value}"`
      );
    }
  };

  if (opts.summary_fields) {
    for (const f of opts.summary_fields) refsKnown('summary_fields', f);
  }
  if (opts.identifier_field !== undefined) {
    refsKnown('identifier_field', opts.identifier_field);
  }
  if (opts.display_field !== undefined) {
    refsKnown('display_field', opts.display_field);
  }

  return { name, fields, ...opts };
}
