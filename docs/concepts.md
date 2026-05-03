# Concepts

The mental model behind ledric, in one page. Everything else in the
docs assumes you've internalised these.

If you've used Contentful, Sanity, Payload, or Strapi, most of this
will sound familiar — there's a content type, there's an entry, there's
a slug, there's an asset. What's worth paying attention to is the
*shape* of each one: ledric's are flatter, more verbatim, and more
LLM-legible than you might be used to.

- [Types and entries](#types-and-entries)
- [Identifiers: id, slug, ref](#identifiers-id-slug-ref)
- [Versions](#versions)
- [References: structural and inline](#references-structural-and-inline)
- [Assets](#assets)
- [Locales](#locales)
- [Environments](#environments)
- [The wire format](#the-wire-format)

For the field-type catalogue and validation rules, see
[`schema.md`](./schema.md). For the actual tool calls that operate on
these concepts, see [`mcp-tools.md`](./mcp-tools.md).

---

## Types and entries

A **type** is a content shape: a name plus a map of fields. `blog_post`
is a type. `author` is a type. `pricing_table_section` is a type. A
type is just a row in the `types` table with a JSON schema attached
to it.

An **entry** is one instance of a type: one specific blog post, one
specific author. It's a row in the `entries` table that points at its
type and carries a JSON content blob shaped according to the type's
fields.

```
types                 entries
┌────────────┐       ┌─────────────────────────────────────┐
│ blog_post  │ ───── │ blog_post / hello-world             │
│  schema:   │       │   { title: "Hello", body: "...", … }│
│   title    │       │                                     │
│   slug     │ ───── │ blog_post / why-sqlite              │
│   body     │       │   { title: "Why SQLite", body: …   }│
│   …        │       └─────────────────────────────────────┘
└────────────┘
```

Two practical consequences:

1. **The schema is enforced at write time.** A `draft` or `publish`
   that doesn't match the type's field rules comes back as a
   structured `VALIDATION_FAILED` error with field paths — not a
   500.

2. **Types evolve in place.** You don't rewrite a type to add a
   field; you `alter_type` it with a JSON Merge Patch. ledric
   classifies the change as `safe`, `needs_backfill`, or
   `destructive` and lets you `migrate_entries` if the existing
   rows need to catch up. See [`schema.md`'s "Evolving a schema"
   section](./schema.md#evolving-a-schema).

Throughout the API and tools, types are referred to by name
(`blog_post`) and entries are addressed by `type/slug`
(`blog_post/hello-world`).

---

## Identifiers: id, slug, ref

Every entry has two identifiers. They mean different things and are
useful in different places.

### `id` — UUIDv7

The immutable primary key. Time-ordered (so a btree index on it
clusters by creation time). Survives any number of slug renames.

```
018f2d40-2b18-7d92-9cf1-1b2934a7e9b3
```

Use ids in:

- **Machine-to-machine integrations.** A webhook payload, a build
  pipeline, a foreign system that should keep working when an
  editor renames a post.
- **Anywhere a slug rename would silently break.** Saved searches,
  analytics events, audit logs.

### `slug` — mutable URL alias

The human-readable identifier. Lowercase, alphanumeric, hyphens —
shaped to go in a URL. Unique within a type within a locale.

```
hello-world
why-we-built-ledric
```

Slugs are **mutable**: rename a post and ledric retires the old slug
into `slug_history` and starts redirecting reads of the old slug to
the new entry (with a 301 + a `_redirect` sidecar in the response).
You don't lose the inbound link.

Use slugs in:

- **URLs.** They're literally what the URL contains.
- **Prompts and diffs.** `blog_post/hello-world` is legible in a
  conversation; the UUID isn't.
- **Anywhere an LLM is editing.** Slugs read like words; ids look
  like noise. The difference shows up in token efficiency and in
  how often the model picks the right entry.

### `ref` — what the API accepts

Every tool that takes "an entry" accepts a **ref**: any of the
following resolves to the same row.

| Form | Example | When |
|---|---|---|
| `type/slug` | `blog_post/hello-world` | Default. Most ergonomic. |
| `id` | `018f2d40-2b18-7d92-…` | Stable across renames. |
| Object | `{ type: "blog_post", slug: "hello-world" }` | When you've already split the parts. |
| Object | `{ id: "018f2d40-…" }` | Same, with id. |

The TS and PHP SDKs accept all four. `read('blog_post/hello-world')`
and `read({ type: 'blog_post', slug: 'hello-world' })` are
interchangeable.

### Slug history

When you rename `blog_post/foo` to `blog_post/bar`:

1. The entry's `slug` becomes `bar`.
2. A row goes into `slug_history`: `(type, slug=foo, entry_id, retired_at)`.
3. Reads against `blog_post/foo` look up `slug_history`, find the
   entry, and return it with `_redirect: { to: "bar" }`. Over HTTP
   that comes with a `301 Moved Permanently` and a `Location` header
   pointing at `/entries/blog_post/bar`.
4. The redirect lasts forever by default. Old slugs aren't recycled.

Per-type policy lets you opt out:
`on_slug_change: 'redirect' | 'error' | 'silent'`. The default
(`redirect`) is what you almost always want.

---

## Versions

Every write to an entry creates a new version. Nothing is overwritten
in place.

```
entries                       entry_versions
┌──────────────────────┐      ┌───────────────────────────────────┐
│ blog_post / hello    │  ──> │ v1 { title: "Hello", body: "..." }│
│  current_version: 4  │      │ v2 { title: "Hello!", body: ...   │
│  published_version: 3│      │ v3 { title: "Hello, world", ...   │ ← published_version
└──────────────────────┘      │ v4 { title: "Hello, world", ...   │ ← current_version
                              └───────────────────────────────────┘
```

Three things flow from this:

### 1. Drafting and publishing are decoupled

`draft` writes a new version. The entry's `current_version` advances.
The `published_version` pointer stays where it was. Public reads keep
returning the previously-published shape.

`publish` moves the `published_version` pointer. That's it — no copy,
no separate "published table". Publishing is a pointer move and
unpublishing is the same move in reverse.

### 2. Reads can target a version

```
read({ ref: 'blog_post/hello', version: 'published' })  // default for published reads
read({ ref: 'blog_post/hello', version: 'current' })    // latest draft
read({ ref: 'blog_post/hello', version: 7 })            // specific historical version
```

Same shape, different content. Handy for restoring an older revision
(diff the JSON, copy the bits you want, draft them back) and for
admin tooling that wants to render history.

### 3. `parent_version` is optimistic concurrency

Every mutating tool that touches an existing row takes
`parent_version`. If the row's actual version doesn't match, the
write is rejected with a `VERSION_CONFLICT` error. Two agents
editing the same entry don't silently clobber each other — the
second one gets told to re-read and try again.

```json
{
  "tool": "draft",
  "args": {
    "ref": "blog_post/hello",
    "parent_version": 4,
    "fields": { "title": "Hello, world" }
  }
}
```

If the entry is at version 5 by the time this lands:

```json
{
  "error": {
    "code": "VERSION_CONFLICT",
    "current_version": 5,
    "your_parent_version": 4
  }
}
```

### Schema-version stamping

Every entry version also records the schema version it was written
under. After an `alter_type`, old entries keep reading correctly
against the version of the schema they were written for; the
`migrate_entries` tool re-validates them against the new shape and
backfills as needed.

### What's not exposed yet

The original spec describes `read_version`, `revert`, `diff`, and
`list_versions` as MCP tools. Those aren't shipped. You can pass
`version: N` to `read` to fetch any historical version; everything
else (diffing, reverting, listing) is HTTP-callable but not yet
surfaced as a first-class tool. See [`roadmap.md`](./roadmap.md).

---

## References: structural and inline

Two ways one entry can point at another. They have different rules
and different jobs.

### Structural references — schema fields

A `references` field type, declared in the schema, with a target
type and cardinality.

```ts
field.references({ to: ['author'], min: 1, max: 1 })   // exactly one author
field.references({ to: ['post', 'page'], max: 6 })     // up to 6 related entries
```

Properties:

- **Validated at write time.** The target entries must exist (or
  the write is rejected with `REFERENCE_NOT_FOUND`).
- **Queryable.** You can `find` entries by their references with the
  HTTP filter DSL.
- **Reverse-indexable.** Soft-deleting a referenced entry surfaces
  the dependents in the structured `REFERENCE_TOMBSTONED` error.

Use structural references for **app-logic dependencies**: a post's
author, a page's section list, a product's category.

### Inline references — `:::ref{…}:::` directives

A directive embedded inside any markdown field, resolved at read
time.

```markdown
For background, see :::ref{to="blog_post/why-sqlite"}:::.

Pricing details: :::ref{to="section/pricing-table"}:::
```

The directive is just a string in the body. It's parsed and
optionally resolved on read:

```ts
const post = await client.read('blog_post/hello-world', { resolveRefs: true });
post._refs;  // [{ to: "blog_post/why-sqlite", found: true, url: "...", entry: {...} }]
```

Properties:

- **Resolved at render time, not write time.** Dangling refs warn,
  they don't block the write. The `ledric refs check` CLI command
  will lint a whole content set for danglers.
- **Not queryable.** They live inside opaque markdown.
- **Pinnable.** `:::ref{to="blog_post/hello" version=42}:::` freezes
  the reference to a specific version. Useful when published
  content shouldn't drift if a referenced entry changes later.

Use inline references for **editorial links in flowing prose**: the
"see also" in a paragraph, an embedded section block in the middle
of a long-form post.

### Quick rule of thumb

If a renderer has to know about it to lay out the page, it's a
structural ref. If it's something a writer typed in the body, it's
inline.

---

## Assets

Uploaded files — images, PDFs, videos, anything else. Two kinds of
identifier, for two different reasons.

### `id` — the asset's identity

A 32-char hex string. Stable for the lifetime of the asset.

```
019dc0b5553477e894374b563cd4e633
```

This is what gets stored in an `asset` field on an entry. Replace
the bytes (re-upload to the same id) and every entry that points
at it picks up the new bytes automatically.

### `ref_key` — the version-pinned bytes locator

A separate token tied to a specific upload. Changes when you
replace the bytes.

```
abc123def456...
```

Asset URLs use the `ref_key`, not the id:

```
/assets/abc123def456...?w=800&fit=crop&auto=format
```

This is deliberate. CDNs and browser caches key on URL. If the URL
contained the id, replacing the bytes wouldn't invalidate caches —
visitors would see stale images for hours. Because the URL contains
the `ref_key`, replacing the bytes mints a new URL, and caches
re-fetch automatically. Old URLs keep serving old bytes (if you
haven't pruned them) — historical pages stay stable.

### Image transforms

Asset URLs accept imgix-style query parameters: `w`, `h`, `fit`
(`crop` or `clip`), `q`, `fm` (`jpg`/`png`/`webp`/`avif`), `auto=format`,
`dpr`. `sharp` (libvips) does the work; transformed bytes are cached
on disk by `(ref_key, params_hash)`.

```
/assets/<ref_key>?w=800&fit=crop&auto=format
/assets/<ref_key>?w=400&h=400&fit=crop&fm=webp
```

The SDKs build these for you:

```ts
client.assetUrl(refKeyOrId, { w: 800, fm: 'webp', auto: 'format' });
```

### Backends

Asset bytes go in one of two places:

- **In the database** (default in dev): bytes live in an
  `asset_blobs` table next to everything else. Backups are one
  file. No filesystem to maintain.
- **On disk**: a directory of files keyed by `ref_key`. Picks up a
  CDN cleanly in front of `/assets/`.

External-bucket adapters (S3, R2) are planned, not shipped — see
[`roadmap.md`](./roadmap.md). The backend interface exists; the
implementations don't.

### Asset versions

Same model as entries: every replacement creates a new version. The
HTTP `GET /assets/:id` always serves the current `ref_key`'s bytes;
direct `GET /assets/<old_ref_key>` keeps serving the historical
bytes until a future cleanup phase (not yet automated).

For the full asset model — uploads, transforms, in-place
replacement, the cache — see [`assets.md`](./assets.md).

---

## Locales

Multi-language content as a built-in. A type opts in by declaring
`locales`; individual fields opt in with `localized: true`. The
default-locale value lives at the top level of the entry's content;
other locales go in a `_locale` sidecar keyed by locale code.

```ts
defineType('blog_post', {
  title: field.string({ required: true, localized: true }),
  body: field.markdown({ required: true, localized: true }),
  slug: field.slug({ required: true, from: 'title' })
}, {
  locales: ['en', 'fr', 'es'],
  default_locale: 'en',
  fallback: { fr: 'en', es: 'en' }
});
```

What an entry's content looks like in storage:

```json
{
  "title": "Hello",
  "body": "# Hi there",
  "slug": "hello",
  "_locale": {
    "fr": { "title": "Bonjour", "body": "# Salut" },
    "es": { "title": "Hola" }
  }
}
```

On read, pass `?locale=fr` (HTTP) or `{ locale: 'fr' }` (SDK). ledric
merges the right values onto the top-level shape, walking the
`fallback` chain when a translation is missing for the requested
locale. Spanish here would resolve `body` from `en` because `es` is
missing it and `es → en` in the fallback chain.

Slugs can be locale-specific too — a French post can have `bonjour`
where the English one has `hello`. Every locale's slug lives in
`slug_history` separately.

For the full localization story — locale-specific slugs, fallback
chains, recipes — see [`localization.md`](./localization.md).

---

## Environments

The storage schema reserves environment columns (`env_id`,
`parent_env`) on every type, entry, and asset row. Originally this
was to support full-environment branching: fork "production" into
"staging", edit, merge back.

**Today the API to fork, edit, and merge environments isn't
exposed.** Every read and write happens in the default environment.
You can't ask ledric for "what would change if I merged staging
into production" because there's no `staging`.

If you need staged content right now: use the draft / publish
distinction. Drafts don't appear in published reads. That's a much
narrower mechanism than environment branching, but it covers the
"work-in-progress that shouldn't go live yet" case for most
content workflows.

Branching is on the post-v1 roadmap. See [`roadmap.md`](./roadmap.md).

---

## The wire format

One last thing worth internalising: an entry on the wire is **flat**.

```json
{
  "id": "018f2d40-2b18-7d92-9cf1-1b2934a7e9b3",
  "slug": "hello-world",
  "type": "blog_post",
  "version": 4,
  "fields": {
    "title": "Hello, world",
    "slug": "hello-world",
    "body": "# Hello\n\nFirst post.",
    "hero": "019dc0b5553477e894374b563cd4e633",
    "author": [{ "type": "author", "slug": "j" }],
    "tags": ["greetings"]
  }
}
```

Compare to Contentful, where every field is wrapped in a locale
envelope and the entire response sits inside a `sys` / `fields` /
`metadata` envelope of its own. ledric responses don't carry that
overhead by default. There's an optional `_meta` block (version,
schema_version, content_hash, request_id) that you can opt into per
call with `include_meta: true`, but it's off by default.

This matters mostly because of how LLMs read and write content.
Token cost on a list of 20 entries is the field bytes, not the
field bytes plus 20 envelopes' worth of structural noise. The model
can pattern-match the shape after one example.

For the full response shape — `_redirect` sidecar, `_locale`,
`_refs` from `resolveRefs: true`, expanded assets — see
[`http-api.md`](./http-api.md).

---

## Where to go next

- [Build a site with an agent](./build-with-an-agent.md) — what these
  concepts feel like in practice, end to end.
- [Schema](./schema.md) — the field-type catalogue and validation rules.
- [MCP tools](./mcp-tools.md) — the tool surface that operates on
  everything above.
- [HTTP API](./http-api.md) — the same surface over plain HTTP, plus
  every query parameter.
