import type { TypeDef } from '@ledric/schema';

export const LOCALE_KEY = '_locale';

export function defaultLocale(type: TypeDef): string | undefined {
  if (type.locales === undefined) return undefined;
  return type.default_locale ?? type.locales[0];
}

/**
 * Ordered chain of locales to consult when looking up a field for `locale`.
 * The first entry is `locale` itself, then any per-type fallback hops, then
 * the type's default locale. The default-locale value lives at the top of
 * the content object (not in `_locale`); callers walk that chain and finally
 * read the top-level value if every locale step misses.
 */
export function computeFallbackChain(type: TypeDef, locale: string): string[] {
  if (type.locales === undefined) return [];
  const chain: string[] = [locale];
  const seen = new Set<string>([locale]);
  let cursor: string = locale;
  for (;;) {
    const next: string | undefined = type.fallback?.[cursor];
    if (next === undefined || seen.has(next)) break;
    chain.push(next);
    seen.add(next);
    cursor = next;
  }
  const def = defaultLocale(type);
  if (def !== undefined && !seen.has(def)) chain.push(def);
  return chain;
}

/**
 * Project a stored content object (with optional `_locale` map) into a flat
 * content object for the requested locale. Default-locale or undefined locale
 * gets the top-level shape unchanged (sans `_locale`). For non-default
 * locales, `localized: true` fields get overridden by the locale's value
 * (with fallback chain), and the `_locale` block is stripped from the result.
 */
export function projectForLocale(
  content: Record<string, unknown>,
  type: TypeDef,
  locale: string | undefined
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(content)) {
    if (k === LOCALE_KEY) continue;
    out[k] = v;
  }

  const def = defaultLocale(type);
  if (locale === undefined || locale === def) return out;
  if (type.locales === undefined || !type.locales.includes(locale)) {
    throw new Error(
      `Locale "${locale}" is not in type "${type.name}".locales[]`
    );
  }

  const localeBlock = (content[LOCALE_KEY] as Record<string, Record<string, unknown>> | undefined) ?? {};
  const chain = computeFallbackChain(type, locale);

  for (const [name, field] of Object.entries(type.fields)) {
    if (field.localized !== true) continue;
    let value: unknown = undefined;
    for (const loc of chain) {
      const v = localeBlock[loc]?.[name];
      if (v !== undefined) {
        value = v;
        break;
      }
    }
    if (value === undefined) value = content[name];
    if (value === undefined) {
      delete out[name];
    } else {
      out[name] = value;
    }
  }

  return out;
}

/**
 * Pull non-default-locale slugs out of validated content for the storage
 * layer's `locale_slugs` parameter. Returns `undefined` for non-localized
 * types so storage skips touching `entries_slugs` entirely.
 */
export function extractLocaleSlugs(
  type: TypeDef,
  content: Record<string, unknown>,
  slugField: string
): Record<string, string> | undefined {
  if (type.locales === undefined) return undefined;
  const def = defaultLocale(type);
  const localeBlock = content[LOCALE_KEY] as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (!localeBlock) return undefined;
  const out: Record<string, string> = {};
  for (const [locale, fields] of Object.entries(localeBlock)) {
    if (locale === def) continue;
    if (!type.locales.includes(locale)) continue;
    const slug = fields[slugField];
    if (typeof slug === 'string' && slug.length > 0) {
      out[locale] = slug;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
