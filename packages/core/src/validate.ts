import type { FieldDef, TypeDef } from '@ledric/schema';

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

  // Detect unknown fields — strict by default in this slice.
  for (const key of Object.keys(content)) {
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
    default:
      return [{ path, code: 'unknown_type', message: `Unknown field type` }];
  }
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
