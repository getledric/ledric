# Localization

Multi-language content as a built-in, not a bolt-on. Translate
per-field or per-entry, share a single slug across locales (or use
locale-specific slugs), fall back cleanly when a translation is
missing, and let agents draft translations in place.

- [The model in one paragraph](#the-model-in-one-paragraph)
- [Setting up a localized type](#setting-up-a-localized-type)
- [Writing localized content](#writing-localized-content)
- [Reading by locale](#reading-by-locale)
- [Fallback chains](#fallback-chains)
- [Locale-specific slugs](#locale-specific-slugs)
- [Recipes](#recipes)

---

## The model in one paragraph

A type can declare a list of `locales`. Fields opt in with
`localized: true`. The default-locale value lives at the top level of
the entry's content (where any non-localized field lives); other
locales attach to a `_locale` sidecar keyed by locale code. On read,
pass `?locale=fr` and ledric merges the right values onto the
top-level shape, walking your fallback chain when a translation is
missing.

The default locale is the source of truth. Translations are
overlays.

---

## Setting up a localized type

```ts
import { defineType, field } from '@ledric/schema';

export const blogPost = defineType('blog_post', {
  title: field.string({ required: true, localized: true }),
  slug: field.slug({ required: true, from: 'title' }),
  body: field.markdown({ required: true, localized: true }),
  hero: field.asset({ kinds: ['image'] }),
  published_at: field.date()
}, {
  display_field: 'title',
  locales: ['en', 'fr', 'es'],
  default_locale: 'en',
  fallback: { fr: 'en', es: 'fr' }
});
```

`localized: true` requires the type to declare `locales`. Trying to
create a type that has localized fields but no `locales` list fails
at `defineType` / `create_type`.

By chat:

> Add French and Spanish locales to `blog_post`. English is the
> default. French falls back to English; Spanish falls back to
> French then English. Make `title` and `body` localized; leave
> `hero` and `published_at` shared across all locales.

The agent calls `alter_type` setting `locales`, `default_locale`,
`fallback`, and flipping `localized: true` on the right fields.

---

## Writing localized content

The default-locale values go at the top of `content`. Other locales
go under `_locale`.

```json
{
  "title": "Hello world",
  "slug": "hello-world",
  "body": "# Hello\n\nFirst post.",
  "hero": "01941b2c...",
  "published_at": "2026-04-15",
  "_locale": {
    "fr": {
      "title": "Bonjour, monde",
      "body": "# Bonjour\n\nPremier article."
    },
    "es": {
      "title": "Hola, mundo",
      "body": "# Hola\n\nPrimer artículo."
    }
  }
}
```

Notes:

- `_locale` is a top-level reserved key. Don't use it as a field name.
- Only `localized: true` fields go inside `_locale.<lang>`. Putting
  non-localized fields there silently does nothing.
- The default-locale (`en` here) values stay at the top — never
  duplicated under `_locale.en`.
- Partial translations are fine. French can override `title` only
  and inherit `body` from the fallback chain.

To draft a translation, just pass the merged content via `draft`
with `parent_version`:

```bash
curl -X POST http://localhost:3000/rpc \
  -H 'Authorization: Bearer lka_...' \
  -H 'Content-Type: application/json' \
  -d '{
    "tool": "draft",
    "args": {
      "type": "blog_post",
      "ref": { "type": "blog_post", "slug": "hello-world" },
      "parent_version": 1,
      "fields": {
        "title": "Hello world",
        "slug": "hello-world",
        "body": "# Hello",
        "_locale": {
          "fr": { "title": "Bonjour, monde", "body": "# Bonjour" }
        }
      }
    }
  }'
```

---

## Reading by locale

Pass `locale` on `read` / `find` (or `?locale=fr` on the HTTP
routes). ledric returns the projected shape — locale-specific values
hoisted to the top, fallback chain applied, `_locale` stripped from
the response.

```ts
const post = await client.read('blog_post/hello-world', { locale: 'fr' });
// post.fields.title === 'Bonjour, monde'
// post.fields.body === '# Bonjour\n\nPremier article.'
// post.fields.hero === '01941b2c...'    (not localized — same as default)
// post.fields.published_at === '2026-04-15'
```

```bash
curl 'http://localhost:3000/entries/blog_post/hello-world?locale=fr'
```

The response carries `locale: 'fr'` so consumers know which view
they're looking at.

Without `?locale=`, the default-locale values are returned — same
as a non-localized entry.

---

## Fallback chains

`fallback` maps each locale to its parent in the resolution order.
When a localized field isn't set for the requested locale, ledric
walks the chain.

```ts
{
  locales: ['en', 'fr', 'es'],
  default_locale: 'en',
  fallback: { fr: 'en', es: 'fr' }
}
```

Reading `?locale=es`:

1. Look in `_locale.es` for the field.
2. Missing? Walk to `es`'s fallback (`fr`). Look in `_locale.fr`.
3. Still missing? Walk to `fr`'s fallback (`en`).
4. `en` is the default — the value at the top level wins.

The fallback chain is per-field, not per-entry. Spanish can pick up
the title from French (because that's translated) and the body from
English (because French isn't, but English is). No "all-or-nothing"
constraint.

If you set `fallback` to a self-cycle or unknown locale, `defineType`
rejects it.

---

## Locale-specific slugs

By default, a single slug serves all locales — `blog_post/hello-world`
works whether you pass `?locale=fr` or not. If you want
locale-specific URLs (`/blog/fr/bonjour-le-monde`), pass `locale` to
`rename_entry`:

```bash
npx ledric rename blog_post/hello-world bonjour-le-monde --locale fr
```

Now:

- `blog_post/hello-world?locale=fr` → 301 → `blog_post/bonjour-le-monde`
- `blog_post/bonjour-le-monde?locale=fr` → the French view of the entry
- `blog_post/bonjour-le-monde?locale=en` → 404 (locale-specific slug only resolves under its locale)
- `blog_post/hello-world` (no locale) → English view, same as before

The default-locale slug stays the canonical one. Per-locale slugs
are aliases living in `slug_history` rows tagged with their locale.

---

## Recipes

### Translate an existing post

> The post `blog_post/hello-world` is currently English-only. Draft
> a French translation in place — same slug, just localized title
> and body. The hero image and published_at carry over.

The agent reads the current entry, builds the new content with a
`_locale.fr` block carrying the translated title and body, and
calls `draft` with the right `parent_version`. Top-level fields
unchanged.

### Add a locale to an existing type

> Add `de` (German) to `blog_post` locales. German falls back to
> English. Don't translate any posts yet — I'll do it gradually.

The agent calls `alter_type` extending `locales` and `fallback`.
Existing entries don't need migration: their content's missing
`_locale.de` block just means German reads fall back to English.

### Find untranslated posts

> Show me every `blog_post` that doesn't have a French
> translation yet.

The agent runs `find` with full-content budget, filters client-side
for entries where `_locale.fr` is missing or empty, and reports
the slugs.

### Localize the slug

> Rename `blog_post/hello-world`'s French slug to
> `bonjour-le-monde`. Keep the English slug as it is.

The agent calls `rename_entry` with `locale: 'fr'` — the English
slug stays put, the French URL gets its own.

### Drop a locale

> Remove the Spanish locale from `blog_post`. The translations
> aren't worth maintaining.

The agent calls `alter_type` removing `es` from `locales` and from
`fallback`. Existing `_locale.es` blocks become inert (the type
no longer recognises the locale, so they don't surface on read).
A subsequent `migrate_entries` with a `_locale.es: null` merge
patch can scrub them from storage if you want a clean slate.
