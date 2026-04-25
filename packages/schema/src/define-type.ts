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

  if (opts.locales !== undefined) {
    if (opts.locales.length === 0) {
      throw new Error(`defineType("${name}"): locales[] cannot be empty`);
    }
    for (const loc of opts.locales) {
      if (!/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(loc)) {
        throw new Error(
          `defineType("${name}"): locale "${loc}" must look like an IETF tag (e.g. "en", "fr-CA")`
        );
      }
    }
    if (opts.default_locale !== undefined && !opts.locales.includes(opts.default_locale)) {
      throw new Error(
        `defineType("${name}"): default_locale "${opts.default_locale}" must be in locales[]`
      );
    }
    if (opts.fallback !== undefined) {
      for (const [from, to] of Object.entries(opts.fallback)) {
        if (!opts.locales.includes(from)) {
          throw new Error(
            `defineType("${name}"): fallback key "${from}" is not in locales[]`
          );
        }
        if (!opts.locales.includes(to)) {
          throw new Error(
            `defineType("${name}"): fallback target "${to}" (for "${from}") is not in locales[]`
          );
        }
      }
    }
  } else {
    // Without `locales` declared, no field may be localized.
    for (const [fieldName, field] of Object.entries(fields)) {
      if (field.localized === true) {
        throw new Error(
          `defineType("${name}"): field "${fieldName}" is localized, but the type has no locales[] declared`
        );
      }
    }
  }

  return { name, fields, ...opts };
}
