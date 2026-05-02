import type { FieldDef, TypeDef, TypeDefOptions } from './types.js';
import { FIELD_TYPES } from './types.js';
import { FIELD_TYPE_SPECS } from './field-specs.js';

const SLUG_NAME_RE = /^[a-z][a-z0-9_]*$/;
const VALID_TYPES = new Set<string>(FIELD_TYPES);

/**
 * Throw a validation error tagged with `code: 'VALIDATION'` so the MCP
 * boundary can return a structured response instead of a generic
 * TOOL_ERROR. The path-prefixed message points the caller at the exact
 * type / field that's wrong.
 */
function vfail(message: string): never {
  const err = new Error(message) as Error & { code: string };
  err.code = 'VALIDATION';
  throw err;
}

function validateFieldDef(
  pathLabel: string,
  fieldName: string,
  field: FieldDef
): void {
  if (!SLUG_NAME_RE.test(fieldName)) {
    vfail(
      `${pathLabel}: field name "${fieldName}" must match ${SLUG_NAME_RE.source}`
    );
  }
  const t = (field as { type?: unknown }).type;
  if (typeof t !== 'string' || !VALID_TYPES.has(t)) {
    const known = [...VALID_TYPES].join(', ');
    vfail(
      `${pathLabel}: field "${fieldName}" has unknown type "${String(t)}" — valid types are: ${known}`
    );
  }
  // Required-key presence check, driven by the same FIELD_TYPE_SPECS
  // catalogue that describeModel exposes. Catches `array` without `of`,
  // `object` without `fields`, `references` without `to`, etc., before
  // they reach unguarded property access below.
  const spec = FIELD_TYPE_SPECS[field.type];
  const fieldRecord = field as unknown as Record<string, unknown>;
  for (const key of spec.required) {
    if (fieldRecord[key] === undefined) {
      vfail(
        `${pathLabel}: field "${fieldName}" (type "${field.type}") is missing required property "${key}". Example: ${JSON.stringify(spec.example)}`
      );
    }
  }
  if (field.default !== undefined && !defaultMatchesType(field)) {
    vfail(
      `${pathLabel}: field "${fieldName}" has a default value that doesn't match its declared type "${field.type}"`
    );
  }
  // Recurse into nested object/array fields so deep schemas validate too.
  if (field.type === 'object') {
    if (field.fields === null || typeof field.fields !== 'object' || Array.isArray(field.fields)) {
      vfail(
        `${pathLabel}: field "${fieldName}".fields must be an object mapping field names to FieldDefs`
      );
    }
    for (const [nestedName, nestedField] of Object.entries(field.fields)) {
      validateFieldDef(`${pathLabel}/${fieldName}`, nestedName, nestedField);
    }
  } else if (field.type === 'array') {
    if (field.of === null || typeof field.of !== 'object' || Array.isArray(field.of)) {
      vfail(
        `${pathLabel}: field "${fieldName}".of must be a FieldDef object describing the element shape`
      );
    }
    const innerType = (field.of as { type?: unknown }).type;
    if (typeof innerType !== 'string' || !VALID_TYPES.has(innerType)) {
      const known = [...VALID_TYPES].join(', ');
      vfail(
        `${pathLabel}: field "${fieldName}".of has unknown type "${String(innerType)}" — valid types are: ${known}`
      );
    }
    // If the inner is itself an object, recurse into it.
    if (field.of.type === 'object') {
      for (const [nestedName, nestedField] of Object.entries(field.of.fields)) {
        validateFieldDef(`${pathLabel}/${fieldName}[]`, nestedName, nestedField);
      }
    }
  } else if (field.type === 'enum') {
    if (!Array.isArray(field.values) || field.values.length === 0) {
      vfail(
        `${pathLabel}: field "${fieldName}".values must be a non-empty array of strings`
      );
    }
    if (field.values.some((v) => typeof v !== 'string')) {
      vfail(
        `${pathLabel}: field "${fieldName}".values must contain only strings`
      );
    }
  } else if (field.type === 'references') {
    if (!Array.isArray(field.to) || field.to.length === 0) {
      vfail(
        `${pathLabel}: field "${fieldName}".to must be a non-empty array of type names`
      );
    }
  } else if (field.type === 'vector') {
    if (typeof field.dims !== 'number' || !Number.isInteger(field.dims) || field.dims <= 0) {
      vfail(
        `${pathLabel}: field "${fieldName}".dims must be a positive integer`
      );
    }
  }
}

function defaultMatchesType(field: FieldDef): boolean {
  const d = field.default;
  if (d === undefined) return true;
  switch (field.type) {
    case 'string':
    case 'date':
    case 'slug':
    case 'markdown':
    case 'asset':
    case 'css':
      return typeof d === 'string';
    case 'number':
      return typeof d === 'number' && Number.isFinite(d);
    case 'boolean':
      return typeof d === 'boolean';
    case 'enum':
      return typeof d === 'string' && field.values.includes(d);
    case 'references':
      return Array.isArray(d) && d.every((v) => typeof v === 'string');
    case 'array':
      return Array.isArray(d);
    case 'vector':
      return Array.isArray(d) && d.length === field.dims && d.every((v) => typeof v === 'number');
    case 'object':
    case 'jss':
      return typeof d === 'object' && d !== null && !Array.isArray(d);
    default:
      return false;
  }
}

export function defineType(
  name: string,
  fields: Record<string, FieldDef>,
  opts: TypeDefOptions = {}
): TypeDef {
  if (!SLUG_NAME_RE.test(name)) {
    vfail(
      `defineType: type name "${name}" must match ${SLUG_NAME_RE.source} ` +
        `(lowercase, must start with a letter; leading underscore is reserved for content sidecars like _locale, _redirect, _refs, _warnings)`
    );
  }

  if (Object.keys(fields).length === 0) {
    vfail(`defineType("${name}"): at least one field is required`);
  }

  for (const [fieldName, field] of Object.entries(fields)) {
    validateFieldDef(`defineType("${name}")`, fieldName, field);
  }

  const refsKnown = (key: 'summary_fields' | 'identifier_field' | 'display_field', value: string) => {
    if (!(value in fields)) {
      vfail(`defineType("${name}"): ${key} references unknown field "${value}"`);
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
      vfail(`defineType("${name}"): locales[] cannot be empty`);
    }
    for (const loc of opts.locales) {
      if (!/^[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*$/.test(loc)) {
        vfail(
          `defineType("${name}"): locale "${loc}" must look like an IETF tag (e.g. "en", "fr-CA")`
        );
      }
    }
    if (opts.default_locale !== undefined && !opts.locales.includes(opts.default_locale)) {
      vfail(
        `defineType("${name}"): default_locale "${opts.default_locale}" must be in locales[]`
      );
    }
    if (opts.fallback !== undefined) {
      for (const [from, to] of Object.entries(opts.fallback)) {
        if (!opts.locales.includes(from)) {
          vfail(
            `defineType("${name}"): fallback key "${from}" is not in locales[]`
          );
        }
        if (!opts.locales.includes(to)) {
          vfail(
            `defineType("${name}"): fallback target "${to}" (for "${from}") is not in locales[]`
          );
        }
      }
    }
  } else {
    // Without `locales` declared, no field may be localized.
    for (const [fieldName, field] of Object.entries(fields)) {
      if (field.localized === true) {
        vfail(
          `defineType("${name}"): field "${fieldName}" is localized, but the type has no locales[] declared`
        );
      }
    }
  }

  return { name, fields, ...opts };
}
