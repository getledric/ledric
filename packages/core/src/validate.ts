import type { FieldDef, TypeDef } from '@ledric/schema';
import { LOCALE_KEY } from './locale.js';

export interface ValidationError {
  path: string;
  code: string;
  message: string;
  expected?: unknown;
  actual?: unknown;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; errors: ValidationError[] };

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
const TWITTER_OK = true; // placeholder — field.string.pattern is enforced generically

export function validateContent(
  def: TypeDef,
  content: Record<string, unknown>
): ValidationResult {
  const errors: ValidationError[] = [];
  const value: Record<string, unknown> = {};

  // Detect unknown fields — strict by default in this slice. The `_locale`
  // sidecar is handled separately below.
  for (const key of Object.keys(content)) {
    if (key === LOCALE_KEY) continue;
    if (!(key in def.fields)) {
      errors.push({
        path: `/${key}`,
        code: 'unknown_field',
        message: `Field "${key}" is not in the schema for type "${def.name}".`
      });
    }
  }

  for (const [name, field] of Object.entries(def.fields)) {
    const raw = content[name];
    const present = raw !== undefined && raw !== null;

    if (!present) {
      if (field.required === true) {
        errors.push({
          path: `/${name}`,
          code: 'required',
          message: `Field "${name}" is required.`
        });
      }
      continue;
    }

    const fieldErrors = validateField(`/${name}`, field, raw);
    if (fieldErrors.length > 0) {
      errors.push(...fieldErrors);
    } else {
      value[name] = raw;
    }
  }

  // Localization sidecar.
  const localeBlock = content[LOCALE_KEY];
  if (localeBlock !== undefined && localeBlock !== null) {
    if (def.locales === undefined) {
      errors.push({
        path: `/${LOCALE_KEY}`,
        code: 'unknown_field',
        message: `Type "${def.name}" has no locales[] declared, _locale is not allowed.`
      });
    } else if (typeof localeBlock !== 'object' || Array.isArray(localeBlock)) {
      errors.push({
        path: `/${LOCALE_KEY}`,
        code: 'type',
        message: '_locale must be an object keyed by locale name.'
      });
    } else {
      const localeMap = localeBlock as Record<string, unknown>;
      const projected: Record<string, Record<string, unknown>> = {};
      for (const [locale, perLocale] of Object.entries(localeMap)) {
        if (!def.locales.includes(locale)) {
          errors.push({
            path: `/${LOCALE_KEY}/${locale}`,
            code: 'unknown_locale',
            message: `Locale "${locale}" is not in type "${def.name}".locales[].`,
            expected: def.locales,
            actual: locale
          });
          continue;
        }
        if (typeof perLocale !== 'object' || perLocale === null || Array.isArray(perLocale)) {
          errors.push({
            path: `/${LOCALE_KEY}/${locale}`,
            code: 'type',
            message: `_locale.${locale} must be an object.`
          });
          continue;
        }
        const perLocaleObj = perLocale as Record<string, unknown>;
        const accepted: Record<string, unknown> = {};
        for (const [fname, fvalue] of Object.entries(perLocaleObj)) {
          if (fvalue === undefined || fvalue === null) continue;
          const fdef = def.fields[fname];
          if (!fdef) {
            errors.push({
              path: `/${LOCALE_KEY}/${locale}/${fname}`,
              code: 'unknown_field',
              message: `Field "${fname}" is not in the schema.`
            });
            continue;
          }
          if (fdef.localized !== true) {
            errors.push({
              path: `/${LOCALE_KEY}/${locale}/${fname}`,
              code: 'not_localized',
              message: `Field "${fname}" is not localized — only fields with localized:true can appear inside _locale.`
            });
            continue;
          }
          const fieldErrors = validateField(
            `/${LOCALE_KEY}/${locale}/${fname}`,
            fdef,
            fvalue
          );
          if (fieldErrors.length > 0) {
            errors.push(...fieldErrors);
          } else {
            accepted[fname] = fvalue;
          }
        }
        if (Object.keys(accepted).length > 0) projected[locale] = accepted;
      }
      if (Object.keys(projected).length > 0) value[LOCALE_KEY] = projected;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value };
}

function validateField(path: string, field: FieldDef, raw: unknown): ValidationError[] {
  switch (field.type) {
    case 'string':
      return validateString(path, field, raw);
    case 'number':
      return validateNumber(path, field, raw);
    case 'boolean':
      return typeof raw === 'boolean'
        ? []
        : [typeErr(path, 'boolean', raw)];
    case 'date':
      return validateDate(path, raw);
    case 'slug':
      return validateSlug(path, raw);
    case 'markdown':
      return validateMarkdown(path, field, raw);
    case 'asset':
      return typeof raw === 'string' && raw.length > 0
        ? []
        : [typeErr(path, 'asset ref (string)', raw)];
    case 'references':
      return validateReferences(path, field, raw);
    case 'array':
      return validateArray(path, field, raw);
    case 'vector':
      return validateVector(path, field, raw);
    case 'enum':
      return field.values.includes(raw as string)
        ? []
        : [
            {
              path,
              code: 'enum',
              message: `Must be one of: ${field.values.join(', ')}`,
              expected: field.values,
              actual: raw
            }
          ];
    case 'object':
      return validateObject(path, field, raw);
    case 'jss':
      return validateJss(path, raw);
    case 'css':
      return validateCss(path, field, raw);
    default: {
      const t = (field as { type?: unknown }).type;
      return [
        {
          path,
          code: 'unknown_type',
          message: `Unknown field type "${String(t)}" — this usually means the type definition slipped past defineType validation.`,
          actual: t
        }
      ];
    }
  }
}

// Maximum recursion depth for nested rules (`&:hover`, `@media (...)`).
// Eight is generous — real JSS authoring rarely goes past three.
const JSS_MAX_DEPTH = 8;

function validateJss(path: string, raw: unknown): ValidationError[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [typeErr(path, 'JSS object (selector → rules)', raw)];
  }
  const errors: ValidationError[] = [];
  for (const [selector, rules] of Object.entries(raw as Record<string, unknown>)) {
    errors.push(...validateJssRules(`${path}/${selector}`, rules, 1));
  }
  return errors;
}

function validateJssRules(
  path: string,
  raw: unknown,
  depth: number
): ValidationError[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [typeErr(path, 'JSS rule object', raw)];
  }
  if (depth > JSS_MAX_DEPTH) {
    return [
      {
        path,
        code: 'too_deep',
        message: `JSS nesting deeper than ${JSS_MAX_DEPTH} levels`,
        expected: JSS_MAX_DEPTH,
        actual: depth
      }
    ];
  }
  const errors: ValidationError[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'string' || typeof value === 'number') continue;
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Nested rule (`&:hover`, `@media (...)`, etc.) — recurse.
      errors.push(...validateJssRules(`${path}/${key}`, value, depth + 1));
      continue;
    }
    errors.push({
      path: `${path}/${key}`,
      code: 'type',
      message: 'JSS rule values must be strings, numbers, or nested rule objects',
      actual: Array.isArray(value) ? 'array' : typeof value
    });
  }
  return errors;
}

function validateCss(
  path: string,
  field: Extract<FieldDef, { type: 'css' }>,
  raw: unknown
): ValidationError[] {
  if (typeof raw !== 'string') return [typeErr(path, 'CSS source (string)', raw)];
  if (field.max !== undefined && raw.length > field.max) {
    return [
      {
        path,
        code: 'max',
        message: `CSS longer than ${field.max} chars`,
        expected: field.max,
        actual: raw.length
      }
    ];
  }
  return [];
}

function validateObject(
  path: string,
  field: Extract<FieldDef, { type: 'object' }>,
  raw: unknown
): ValidationError[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [typeErr(path, 'object', raw)];
  }
  const errors: ValidationError[] = [];
  const obj = raw as Record<string, unknown>;
  const strict = field.strict !== false;

  if (strict) {
    for (const key of Object.keys(obj)) {
      if (!(key in field.fields)) {
        errors.push({
          path: `${path}/${key}`,
          code: 'unknown_field',
          message: `Field "${key}" is not in this object's schema.`
        });
      }
    }
  }

  for (const [name, nested] of Object.entries(field.fields)) {
    const value = obj[name];
    const present = value !== undefined && value !== null;
    if (!present) {
      if (nested.required === true) {
        errors.push({
          path: `${path}/${name}`,
          code: 'required',
          message: `Field "${name}" is required.`
        });
      }
      continue;
    }
    errors.push(...validateField(`${path}/${name}`, nested, value));
  }

  return errors;
}

function typeErr(path: string, expected: string, actual: unknown): ValidationError {
  return {
    path,
    code: 'type',
    message: `Expected ${expected}, got ${typeof actual}`,
    expected,
    actual
  };
}

function validateString(
  path: string,
  field: Extract<FieldDef, { type: 'string' }>,
  raw: unknown
): ValidationError[] {
  if (typeof raw !== 'string') return [typeErr(path, 'string', raw)];
  const errs: ValidationError[] = [];
  if (field.min !== undefined && raw.length < field.min) {
    errs.push({
      path,
      code: 'min',
      message: `String shorter than ${field.min}`,
      expected: field.min,
      actual: raw.length
    });
  }
  if (field.max !== undefined && raw.length > field.max) {
    errs.push({
      path,
      code: 'max',
      message: `String longer than ${field.max}`,
      expected: field.max,
      actual: raw.length
    });
  }
  if (field.pattern !== undefined) {
    try {
      if (!new RegExp(field.pattern).test(raw)) {
        errs.push({
          path,
          code: 'pattern',
          message: `String does not match pattern ${field.pattern}`,
          expected: field.pattern,
          actual: raw
        });
      }
    } catch {
      /* malformed pattern declared at schema time; ignore here */
    }
  }
  return errs;
}

function validateNumber(
  path: string,
  field: Extract<FieldDef, { type: 'number' }>,
  raw: unknown
): ValidationError[] {
  if (typeof raw !== 'number' || Number.isNaN(raw) || !Number.isFinite(raw)) {
    return [typeErr(path, 'finite number', raw)];
  }
  const errs: ValidationError[] = [];
  if (field.integer === true && !Number.isInteger(raw)) {
    errs.push({ path, code: 'integer', message: 'Expected integer', actual: raw });
  }
  if (field.min !== undefined && raw < field.min) {
    errs.push({
      path,
      code: 'min',
      message: `Must be >= ${field.min}`,
      expected: field.min,
      actual: raw
    });
  }
  if (field.max !== undefined && raw > field.max) {
    errs.push({
      path,
      code: 'max',
      message: `Must be <= ${field.max}`,
      expected: field.max,
      actual: raw
    });
  }
  return errs;
}

function validateDate(path: string, raw: unknown): ValidationError[] {
  if (typeof raw !== 'string') return [typeErr(path, 'date (ISO-8601 string)', raw)];
  if (!ISO_DATE_RE.test(raw)) {
    return [
      {
        path,
        code: 'format',
        message: 'Date must be ISO-8601 (YYYY-MM-DD or full timestamp)',
        actual: raw
      }
    ];
  }
  return [];
}

function validateSlug(path: string, raw: unknown): ValidationError[] {
  if (typeof raw !== 'string') return [typeErr(path, 'slug (string)', raw)];
  if (!SLUG_RE.test(raw)) {
    return [
      {
        path,
        code: 'format',
        message: 'Slug must be 1-64 chars, lowercase a-z/0-9/hyphens, not starting or ending with a hyphen',
        expected: SLUG_RE.source,
        actual: raw
      }
    ];
  }
  return [];
}

function validateMarkdown(
  path: string,
  field: Extract<FieldDef, { type: 'markdown' }>,
  raw: unknown
): ValidationError[] {
  if (typeof raw !== 'string') return [typeErr(path, 'markdown (string)', raw)];
  if (field.max !== undefined && raw.length > field.max) {
    return [
      {
        path,
        code: 'max',
        message: `Markdown longer than ${field.max} chars`,
        expected: field.max,
        actual: raw.length
      }
    ];
  }
  return [];
}

function validateReferences(
  path: string,
  field: Extract<FieldDef, { type: 'references' }>,
  raw: unknown
): ValidationError[] {
  if (!Array.isArray(raw)) return [typeErr(path, 'array of references', raw)];
  const errs: ValidationError[] = [];
  if (field.min !== undefined && raw.length < field.min) {
    errs.push({
      path,
      code: 'min_items',
      message: `Too few references (min ${field.min})`,
      expected: field.min,
      actual: raw.length
    });
  }
  if (field.max !== undefined && raw.length > field.max) {
    errs.push({
      path,
      code: 'max_items',
      message: `Too many references (max ${field.max})`,
      expected: field.max,
      actual: raw.length
    });
  }
  raw.forEach((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      errs.push({
        path: `${path}/${i}`,
        code: 'type',
        message: 'Reference must be a non-empty string'
      });
    }
  });
  return errs;
}

function validateArray(
  path: string,
  field: Extract<FieldDef, { type: 'array' }>,
  raw: unknown
): ValidationError[] {
  if (!Array.isArray(raw)) return [typeErr(path, 'array', raw)];
  const errs: ValidationError[] = [];
  if (field.min !== undefined && raw.length < field.min) {
    errs.push({
      path,
      code: 'min_items',
      message: `Too few items (min ${field.min})`,
      expected: field.min,
      actual: raw.length
    });
  }
  if (field.max !== undefined && raw.length > field.max) {
    errs.push({
      path,
      code: 'max_items',
      message: `Too many items (max ${field.max})`,
      expected: field.max,
      actual: raw.length
    });
  }
  raw.forEach((item, i) => {
    errs.push(...validateField(`${path}/${i}`, field.of, item));
  });
  return errs;
}

function validateVector(
  path: string,
  field: Extract<FieldDef, { type: 'vector' }>,
  raw: unknown
): ValidationError[] {
  if (!Array.isArray(raw)) return [typeErr(path, `vector (array of ${field.dims} numbers)`, raw)];
  if (raw.length !== field.dims) {
    return [
      {
        path,
        code: 'dims',
        message: `Vector must have ${field.dims} dims, got ${raw.length}`,
        expected: field.dims,
        actual: raw.length
      }
    ];
  }
  for (let i = 0; i < raw.length; i++) {
    const v = raw[i];
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      return [typeErr(`${path}/${i}`, 'finite number', v)];
    }
  }
  return [];
}

// Silence unused warning (reserved for later)
void TWITTER_OK;
