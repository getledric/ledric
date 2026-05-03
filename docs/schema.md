# Schema

The schema is the API. Once a content type is defined, ledric knows how to
validate it, version it, project it for any locale, render the right form
field, and tell an LLM exactly what shape it expects via `describe_model`.
There's no separate doc to keep in sync — change the schema, the API
changes with it.

This page covers:

- [Defining a type](#defining-a-type)
- [Field types](#field-types) (the catalogue)
- [Common field options](#common-field-options)
- [Type-level options](#type-level-options)
- [Validation](#validation)
- [Evolving a schema](#evolving-a-schema)

If "type", "entry", "slug", "ref", "version" don't already mean
something specific to you, [`concepts.md`](./concepts.md) is the
primer this page assumes.

For agent prompts that walk Claude through schema setup, see
[`agent-recipes.md`](./agent-recipes.md).

---

## Defining a type

A type is just a name plus a map of field definitions. There are two
paths to creating one — both write the exact same row to the same table.

### From TypeScript (`@ledric/schema`)

```ts
import { defineType, field } from '@ledric/schema';

export const blogPost = defineType('blog_post', {
  title: field.string({ required: true, max: 120 }),
  slug: field.slug({ required: true, from: 'title' }),
  body: field.markdown({ required: true, html: 'sanitize' }),
  hero: field.asset({ kinds: ['image'] }),
  author: field.references({ to: ['author'], min: 1, max: 1 }),
  tags: field.array({ of: field.string() }),
  published_at: field.date()
}, {
  display_field: 'title',
  summary_fields: ['title', 'published_at'],
  example: {
    title: 'Hello world',
    slug: 'hello-world',
    body: '# Hello\n\nFirst post.',
    published_at: '2026-05-01'
  }
});
```

`defineType()` returns the canonical JSON shape. Hand it to `create_type`
over MCP, write it to disk, or import it from another package.

### From chat (no code)

Open Claude (or any MCP-speaking agent) connected to ledric and say:

> Set up a `blog_post` type with title (required, max 120 chars), a slug
> derived from title, a markdown body, an optional hero image, an author
> reference, a tags string array, and a published_at date. Title is the
> display field; show title and published_at in summaries.

The agent calls `describe_model` to learn the field-type catalogue, then
calls `create_type` with the same JSON shape `defineType()` produces.
Same row in the DB. Same validation. No code-vs-DB drift.

The MCP arguments for `create_type`:

```json
{
  "name": "blog_post",
  "fields": {
    "title": { "type": "string", "required": true, "max": 120 },
    "slug": { "type": "slug", "required": true, "from": "title" },
    "body": { "type": "markdown", "required": true, "html": "sanitize" }
  },
  "display_field": "title",
  "summary_fields": ["title", "published_at"]
}
```

---

## Field types

Every field has a `type` discriminator and inherits the
[common options](#common-field-options). Type-specific options are
listed under each entry.

| Type | One-liner |
|---|---|
| [`string`](#string) | Plain text. `min`, `max`, `pattern`. |
| [`number`](#number) | Numeric. `min`, `max`, `integer`. |
| [`boolean`](#boolean) | True/false. |
| [`date`](#date) | ISO 8601 date or datetime string. |
| [`slug`](#slug) | URL-safe identifier. Auto-derives from another field. |
| [`enum`](#enum) | One value from a fixed list. |
| [`markdown`](#markdown) | Rich text as Markdown. Per-field HTML policy. |
| [`asset`](#asset) | Reference to an uploaded file. Optional kind filter. |
| [`references`](#references) | Reference(s) to other entries. Pinning + cardinality. |
| [`array`](#array) | List of any field type. |
| [`object`](#object) | Nested key/value with its own field schema. |
| [`vector`](#vector) | Embedding column for similarity search. |
| [`jss`](#jss) | CSS-in-JS object stored as JSON. Tailwind-friendly. |
| [`css`](#css) | Raw CSS source string. |

### `string`

Plain text. Stored as TEXT.

| Option | Type | Notes |
|---|---|---|
| `min` | number | Minimum length |
| `max` | number | Maximum length |
| `pattern` | string | Regex (anchored) the value must match |

```ts
field.string({ required: true, max: 120 })
field.string({ pattern: '^[A-Z][a-z]+$' })
```

### `number`

Numeric. Stored as REAL (or INTEGER if `integer: true`).

| Option | Type | Notes |
|---|---|---|
| `min` | number | Inclusive minimum |
| `max` | number | Inclusive maximum |
| `integer` | boolean | Reject non-integer values |

```ts
field.number({ min: 0, max: 100 })
field.number({ integer: true, min: 1 })
```

### `boolean`

True or false. No options beyond [common](#common-field-options).

```ts
field.boolean({ default: false })
```

### `date`

ISO 8601 date string (`YYYY-MM-DD`) or datetime (`YYYY-MM-DDTHH:MM:SSZ`).
ledric stores the string as-is; consumers parse with their own time-zone
rules.

```ts
field.date({ required: true })
```

> **Watch out: JavaScript `new Date(iso)` parsing.** A bare
> `YYYY-MM-DD` like `"2026-05-01"` is parsed as **UTC midnight**.
> In any timezone west of UTC (the entire Americas), formatting
> that with `toLocaleDateString()` renders as **the day before**
> (April 30 in Boston, etc.). If you want the date as the editor
> wrote it, parse the components manually:
>
> ```ts
> function parseDateLocal(iso: string) {
>   const [y, m, d] = iso.split("-").map(Number);
>   return new Date(y, m - 1, d);  // local midnight, not UTC
> }
> ```
>
> This is JavaScript's bug, not ledric's. Every consumer hits it
> once.

### `slug`

URL-safe identifier. Lowercase alphanumerics + hyphens.

| Option | Type | Notes |
|---|---|---|
| `from` | string | Auto-derive from another field on this type if the slug is missing |
| `on_change` | `'redirect'` \| `'error'` \| `'silent'` | What happens when a slug changes mid-life. Defaults to redirect (old slug keeps resolving forever). |

```ts
field.slug({ required: true, from: 'title' })
```

The slug field is special: every entry needs *some* slug field, and
ledric uses it for URL routing and ref resolution. If `from` is set and
content omits the slug at write time, ledric slugifies the source field.

### `enum`

One of a fixed set of strings.

| Option | Type | Notes |
|---|---|---|
| `values` | string[] | The allowed values (required) |

```ts
field.enum({ values: ['draft', 'review', 'published'], default: 'draft' })
```

### `markdown`

Rich text as Markdown. The wire format is just a string — no
proprietary AST, no SDK lock-in.

| Option | Type | Notes |
|---|---|---|
| `html` | `'allow'` \| `'sanitize'` \| `'forbid'` | HTML-in-markdown policy. Default: `'sanitize'`. |
| `max` | number | Maximum string length |

```ts
field.markdown({ required: true })            // sanitize HTML
field.markdown({ html: 'forbid' })             // pure markdown only
field.markdown({ html: 'allow' })              // raw HTML pass-through
```

Inline `:::ref{...}` directives are first-class — see
[`mcp-tools.md`](./mcp-tools.md) for `refs check`.

### `asset`

Pointer to an uploaded file. The stored value is a 32-char hex asset id;
when you `read` an entry with `expand_assets: true`, ledric inlines
`{ id, ref_key, kind, version, meta, url }` so the consumer can render
without a round-trip.

| Option | Type | Notes |
|---|---|---|
| `kinds` | string[] | Restrict to e.g. `['image']` or `['image', 'video']` |
| `multiple` | boolean | Field holds an array of asset ids instead of one |

```ts
field.asset({ kinds: ['image'] })
field.asset({ kinds: ['image'], multiple: true })   // a gallery
```

### `references`

Pointer(s) to other entries. Cross-type, cardinality-aware,
version-pinning-aware.

| Option | Type | Notes |
|---|---|---|
| `to` | string[] | Allowed target types (required) |
| `min` | number | Minimum number of references |
| `max` | number | Maximum (use `1` for exactly-one) |
| `pinning` | `'auto'` \| `'manual'` \| `'forbidden'` | Version-pin behaviour. Default `'auto'`. |

```ts
field.references({ to: ['author'], min: 1, max: 1 })   // single author
field.references({ to: ['post', 'page'] })             // related content
```

Pinning controls whether `:::ref{post/x@5}` syntax is honoured: `auto`
follows pin if present, `manual` requires explicit pinning, `forbidden`
always reads latest published.

### `array`

List of any field type. The inner shape goes in `of`.

| Option | Type | Notes |
|---|---|---|
| `of` | FieldDef | The element schema (required) |
| `min` | number | Minimum length |
| `max` | number | Maximum length |

```ts
field.array({ of: field.string() })                          // simple list
field.array({ of: field.references({ to: ['tag'] }) })       // related entries
field.array({                                                 // structured rows
  of: field.object({
    fields: {
      label: field.string({ required: true }),
      url: field.string({ required: true })
    }
  })
})
```

### `object`

Nested key/value with its own fields.

| Option | Type | Notes |
|---|---|---|
| `fields` | Record\<string, FieldDef\> | Nested field map (required) |
| `strict` | boolean | Reject unknown keys. Default `true`. |

```ts
field.object({
  fields: {
    twitter: field.string(),
    github: field.string()
  }
})
```

Set `strict: false` if you want freeform extras (e.g. analytics
metadata that varies per consumer).

### `vector`

Embedding column for similarity search. The vector itself is opaque —
ledric stores it; you pick the model.

| Option | Type | Notes |
|---|---|---|
| `dims` | number | Number of dimensions (required) |
| `byo` | boolean | Bring your own embedding. If false, ledric will embed using its default model when one is configured. |

```ts
field.vector({ dims: 1536, byo: true })   // OpenAI ada-002 dim, you embed
```

### `jss`

CSS-in-JS object stored as JSON. Top-level keys are CSS selectors,
values are rule objects. Pseudo-states and at-rules nest naturally.

```ts
field.jss()
```

Example value (not the schema, the content):

```json
{
  ".hero": {
    "padding": "2rem",
    "background": "var(--surface-2)",
    "&:hover": { "transform": "scale(1.02)" },
    "@media (min-width: 768px)": { "padding": "4rem" }
  }
}
```

Tailwind-friendly: `"@apply": "text-2xl hover:text-3xl"` is permitted as
a string value. Tailwind utility resolution is the consumer renderer's
job; ledric only validates shape.

### `css`

Raw CSS source string. Consumer scopes/applies it at render time.

| Option | Type | Notes |
|---|---|---|
| `max` | number | Maximum string length |

```ts
field.css({ max: 4096 })
```

---

## Common field options

Every field type accepts these:

| Option | Type | Notes |
|---|---|---|
| `description` | string | Free text shown in `describe_model` and admin form labels. |
| `required` | boolean | Reject writes that omit or null this field. |
| `deprecated` | boolean | Hidden from default UIs; reads still work. |
| `indexed` | boolean | Index the column for filter/sort speed. |
| `localized` | boolean | Field accepts per-locale overrides via `_locale[locale]`. Requires the type to declare `locales`. |
| `default` | any | Fill in when content omits or nulls the field. Type must match the field's discriminator (validated at `defineType` time). |

```ts
field.string({
  description: 'Short subtitle shown beneath the title.',
  required: false,
  max: 200
})

field.markdown({
  required: true,
  localized: true,        // supports per-locale overrides
  default: ''
})
```

---

## Type-level options

The third argument to `defineType()` (and the matching keys in
`create_type`'s args) configure the type as a whole.

| Option | Type | Notes |
|---|---|---|
| `description` | string | Free text shown in `describe_model`. |
| `display_field` | string | Field shown as the entry's "title" in admin lists. Defaults to `title` if present. |
| `summary_fields` | string[] | Subset of fields returned by `find` in `summary` budget mode. Skips the rest to save tokens. |
| `identifier_field` | string | Which field is the URL slug. Defaults to `slug`. |
| `on_slug_change` | `'redirect'` \| `'error'` \| `'silent'` | Default behaviour for slug changes on this type. |
| `example` | object | A complete-enough example value used by the admin "new entry" form and surfaced to LLMs by `describe_model`. |
| `locales` | string[] | Allowed locale codes. Required to use any `localized: true` field. |
| `default_locale` | string | Canonical / source-of-truth locale. Defaults to `locales[0]`. |
| `fallback` | Record\<string, string\> | Per-locale fallback chain. Walks these locales when a localized field is missing for the requested one. |

```ts
defineType('blog_post', {
  /* fields */
}, {
  description: 'Public-facing blog posts.',
  display_field: 'title',
  summary_fields: ['title', 'published_at', 'author'],
  locales: ['en', 'fr', 'es'],
  default_locale: 'en',
  fallback: { fr: 'en', es: 'en' },
  example: {
    title: 'Hello world',
    slug: 'hello-world',
    body: '# Hello\n\nFirst post.',
    published_at: '2026-05-01'
  }
});
```

The `example` matters: `describe_model` includes it verbatim, which lets
LLMs see "what does a real one of these look like?" without sampling
your live content.

---

## Validation

`defineType()` and `create_type` both run the same validator before
accepting a type. It checks:

- **Field names** match `^[a-z][a-z0-9_]*$` (snake_case, must start with a letter).
- **Field types** are one of the 14 known discriminators.
- **Default values** match their declared field type (a `default` of `42` on a `string` field fails at definition time, not at write time).
- **`array.of`** is itself a valid field shape.
- **`object.fields`** are recursively validated.
- **`enum.values`** is non-empty and all-strings.
- **`references.to`** is non-empty.
- **Localized fields** require the type to declare `locales`.
- **`display_field`, `summary_fields`, `identifier_field`** all reference fields that actually exist on the type.

Errors throw with a path-prefixed message
(`type "blog_post"/field "tags": ...`) so it's clear where the bad
shape is.

Per-write content validation happens at `draft` / `publish` time
against the same schema — see [`mcp-tools.md`](./mcp-tools.md).

---

## Evolving a schema

Once a type exists, you don't rewrite it — you `alter_type` it. Adding
a new optional field is `safe` (existing entries don't need to know).
Renaming or tightening a field is `needs_backfill` (ledric records the
change and lets you `migrate_entries` to update existing rows).
Removing a required field on existing data is `destructive` (ledric
makes you opt in explicitly).

Schema versions are first-class: every alteration writes a new row in
`type_versions` with a `change_class`. Old entries keep reading against
the version they were written under, so a schema migration in flight
never breaks consumers.

See [`mcp-tools.md`](./mcp-tools.md) for `alter_type`, `migrate_entries`,
and `delete_type`.
