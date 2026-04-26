import type { FieldDef, TypeDef } from '@ledric/schema';
import { LOCALE_KEY } from './locale.js';

export function slugify(source: string): string {
  return source
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Walk `fields`, fill in defaults for any key that's missing or null on `obj`.
 * Returns a new object — does not mutate the input. Recurses into object
 * fields so nested defaults apply at every depth. Array contents are not
 * recursed (defaults don't have a sensible per-item meaning).
 */
function applyDefaults(
  fields: Record<string, FieldDef>,
  obj: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...obj };
  for (const [name, field] of Object.entries(fields)) {
    const present = out[name] !== undefined && out[name] !== null;
    if (!present) {
      if (field.default !== undefined) {
        out[name] = structuredClone(field.default);
        // For object defaults, recurse so nested defaults still fire on
        // the freshly-defaulted shape (the default itself may omit nested
        // optional fields that have their own defaults).
        if (
          field.type === 'object' &&
          typeof out[name] === 'object' &&
          out[name] !== null &&
          !Array.isArray(out[name])
        ) {
          out[name] = applyDefaults(field.fields, out[name] as Record<string, unknown>);
        }
      }
      continue;
    }
    // Recurse into object values that the user provided so nested defaults
    // get applied for missing keys inside their object.
    if (
      field.type === 'object' &&
      typeof out[name] === 'object' &&
      out[name] !== null &&
      !Array.isArray(out[name])
    ) {
      out[name] = applyDefaults(field.fields, out[name] as Record<string, unknown>);
    }
  }
  return out;
}

export function deriveContent(
  def: TypeDef,
  content: Record<string, unknown>
): Record<string, unknown> {
  // Defaults first — derive (slug-from-title etc.) might depend on a
  // defaulted source field.
  const out: Record<string, unknown> = applyDefaults(def.fields, content);

  // Top-level (default-locale) slug derivation.
  for (const [name, field] of Object.entries(def.fields)) {
    if (field.type !== 'slug') continue;
    if (typeof out[name] === 'string' && (out[name] as string).length > 0) continue;
    if (field.from === undefined) continue;
    const src = out[field.from];
    if (typeof src === 'string' && src.length > 0) {
      out[name] = slugify(src);
    }
  }

  // Per-locale slug derivation. The "is the slug already set?" check looks
  // at the locale's own block only — the top-level slug is NOT inherited
  // (otherwise localized slugs would collide on every entry). The "from"
  // source falls back to top-level so an entry with only `_locale.fr.title`
  // still gets a derived slug.
  const localeBlock = out[LOCALE_KEY];
  if (
    def.locales !== undefined &&
    localeBlock !== undefined &&
    localeBlock !== null &&
    typeof localeBlock === 'object' &&
    !Array.isArray(localeBlock)
  ) {
    const map = localeBlock as Record<string, Record<string, unknown>>;
    const derivedMap: Record<string, Record<string, unknown>> = {};
    for (const [locale, perLocale] of Object.entries(map)) {
      if (typeof perLocale !== 'object' || perLocale === null || Array.isArray(perLocale)) {
        derivedMap[locale] = perLocale as Record<string, unknown>;
        continue;
      }
      const onlyChanges: Record<string, unknown> = { ...perLocale };
      for (const [name, field] of Object.entries(def.fields)) {
        if (field.type !== 'slug') continue;
        if (field.localized !== true) continue;
        const existing = perLocale[name];
        if (typeof existing === 'string' && existing.length > 0) continue;
        if (field.from === undefined) continue;
        const src = perLocale[field.from] ?? out[field.from];
        if (typeof src === 'string' && src.length > 0) {
          onlyChanges[name] = slugify(src);
        }
      }
      derivedMap[locale] = onlyChanges;
    }
    out[LOCALE_KEY] = derivedMap;
  }

  return out;
}
