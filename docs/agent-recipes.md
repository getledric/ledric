# Agent recipes

Example prompts for getting things done by chat. These are starting
points — a Claude (or any MCP agent) connected to ledric will
introspect your DB with `describe_model` first and then call the right
tools to fulfil the request.

The prompts on this page are written so you can paste them straight
in. The "what happens" notes show the MCP tool calls the agent will
typically make so you know what to expect.

If you haven't run `npx ledric init` yet, do that first — it wires up
your MCP client and mints API keys in one step.

- [Project setup](#project-setup)
- [Drafting and publishing](#drafting-and-publishing)
- [Schema evolution](#schema-evolution)
- [Bulk operations](#bulk-operations)
- [Refactoring slugs and types](#refactoring-slugs-and-types)
- [Assets](#assets)
- [Localization](#localization)
- [Debugging and introspection](#debugging-and-introspection)
- [Tips that make agents work better](#tips-that-make-agents-work-better)

---

## Project setup

### Set up a blog

> Set up a `blog_post` type with title (required, max 120 chars), a slug
> derived from title, a markdown body, an optional hero image, an author
> reference (to an `author` type I'll define next), a tags string array,
> and a published_at date. Show title and published_at in summaries.
>
> Then create the `author` type with name (required), bio (markdown),
> and avatar (image asset).

**What happens:** the agent calls `describe_model` to learn the
field-type catalogue, then `create_type` once for `blog_post` and
once for `author`. Both types now exist and you can `draft` against
them.

### Build a portfolio

> Set up a `project` type for a freelance portfolio: title, slug from
> title, short description (markdown, max 280 chars), hero image, an
> array of additional gallery images (image kind only), a tech-stack
> string array, a launch date, and a status enum (draft / live /
> archived, default draft).

**What happens:** one `create_type` call. The `array { of: asset }`
shape produces a gallery field; the `enum { values: [...], default: 'draft' }`
gives you a status with a working default at write time.

### Product catalog

> Build me a `product` type with sku (required, indexed), title,
> price (number, integer cents), description markdown, primary image,
> a category reference (single, to a `category` type), and a tag
> array. SKU is the display field. Then add a `category` type with
> name and slug.

**What happens:** two `create_type` calls. The `indexed: true` on sku
makes lookups by SKU fast. References pin automatically — when you
edit a category, existing products keep pointing at the right one.

---

## Drafting and publishing

### Draft a single post

> Draft a `blog_post` titled "Why I switched to Kysely" with slug
> "why-kysely", a 3-paragraph body about the migration, today as the
> published date. Don't publish yet, just draft.

**What happens:** agent calls `draft` with the populated content.
Returns the new entry's slug + version. `published_version` is `null`
until you publish.

### Publish a draft

> Publish `blog_post/why-kysely`.

**What happens:** `publish` flips the published pointer to the
current version. Reads with `expand_assets` now return the live
shape; the inline editor's "live" badge lights up.

### Show me my drafts

> Show me all `blog_post` entries that have drafts but aren't
> published yet.

**What happens:** `find` with the type, then the agent filters by
`current_version != published_version`. ledric returns summary-budget
results by default.

### Publish everything tagged "ready"

> Find all blog_post entries tagged "ready", then publish each one.
> Untag them after publishing.

**What happens:** `find` with `tags: ['ready']`, then a `publish`
call per result, then `remove_entry_tags` per result. Agent batches
naturally — you'll see one tool call per entry.

---

## Schema evolution

### Add an optional field

> Add a `reading_time` integer number field to `blog_post` (minutes,
> minimum 0). Backfill existing posts based on word count of the body
> (assume 250 words/minute, round up).

**What happens:** `alter_type` with the new field def — change-class
`safe` since it's optional. Then a `find` over existing posts and a
sequence of `draft` updates filling in `reading_time`. The schema is
versioned; old reads against the previous schema version still work.

### Rename a field

> Rename the `body` field on `blog_post` to `content`. Migrate
> existing data.

**What happens:** `alter_type` with the rename. Change-class is
`needs_backfill`. Agent calls `migrate_entries` which copies the
old field's value into the new one. Old schema version remains
queryable for time-travel reads.

### Tighten a constraint safely

> Add a `max: 120` to the `title` field on `blog_post`. Don't reject
> existing rows that exceed it — flag them.

**What happens:** `alter_type` with the new max. Agent runs `find`
to identify rows over 120 chars and reports them so you can clean up
before the constraint actually rejects new writes.

---

## Bulk operations

### Tag a year of content

> Find every `blog_post` published before 2025 and tag them with
> "archive".

**What happens:** `find` with the date filter, then
`add_entry_tags` per result.

### Find posts without hero images

> List all `blog_post` entries that don't have a `hero` set.

**What happens:** `find` with full content budget, then the agent
filters client-side for `!entry.fields.hero`. Reports the slugs.

### Untag everything

> Remove the "draft" tag from every entry it's currently on.

**What happens:** `list_tags` to confirm "draft" exists, `find` per
type the tag is on, `remove_entry_tags` per match.

---

## Refactoring slugs and types

### Rename a slug, keep old links working

> Rename `blog_post/old-name` to `new-name`.

**What happens:** `rename_entry`. Old slug stays in `slug_history`
and keeps redirecting forever — your old tweets and Google juice
stay valid. Inline editor's `data-ledric-ref="blog_post/old-name"`
still resolves to the same content.

### Delete a type and all its entries

> Delete the `legacy_post` type and all its entries.

**What happens:** `delete_type` with cascade. ledric soft-deletes
the type row plus every entry under it. You can recover by writing
new entries with the same name within the soft-delete window;
hard-delete is a separate operator-level tool.

### Delete a single entry

> Delete `blog_post/draft-from-2023`. Keep its slug history so old
> links still 404 cleanly with a redirect message.

**What happens:** `delete_entry`. The row is soft-deleted; reads
return `null` (or follow a redirect target if one was set).

---

## Assets

### Upload via chat

> Upload `~/Desktop/hero.jpg` as an asset, alt text "team photo
> 2025", and attach it as the hero of `blog_post/why-kysely`.

**What happens:** agent calls `upload_asset` (or you upload via
`npx ledric asset upload` and paste the id). Then a `draft` on the
post setting `hero` to the new asset id.

### Replace bytes in place

> The image on `blog_post/why-kysely` needs replacing — use
> `~/Desktop/hero-v2.jpg` instead. Bump the version, the URL should
> change so caches invalidate.

**What happens:** `update_asset` — bumps the asset's version and
mints a fresh `ref_key`. Existing entries keep referring to the
asset by id (stable), but readers requesting the bytes get the new
URL because `ref_key` changed.

### Find assets you're not using

> List image assets that aren't referenced by any entry.

**What happens:** `list_assets` filtered by kind, then for each one
the agent searches across types via `find` to see if any entry's
fields contain that asset id. Reports the orphans.

---

## Localization

### Add languages to a type

> Add French and Spanish locales to `blog_post`. Set English as
> default. French falls back to English; Spanish falls back to
> French then English. Mark `title` and `body` as localized.

**What happens:** `alter_type` setting `locales`, `default_locale`,
`fallback`, and flipping `localized: true` on `title` and `body`.

### Draft a translation

> The post `blog_post/hello-world` is in English. Draft a French
> translation in place — same slug, same fields, just a localized
> `title` and `body`.

**What happens:** `read` the entry with `locale: 'en'`, then `draft`
an update setting `_locale.fr` to the translated values. The
top-level (English) values are untouched; readers passing
`locale: 'fr'` get the French; readers without a locale fall back to
English (or the configured chain).

---

## Debugging and introspection

### What types do I have?

> What content types are in this database? Just the names.

**What happens:** `describe_model` (with summary budget). Agent
prints type names + entry counts.

### Show me the schema

> Show me the full schema for `blog_post`, including field defaults
> and the example.

**What happens:** `describe_model` with full budget for that type,
or `read` the type definition directly.

### What's broken?

> Run a refs check across all entries and tell me which ones are
> broken.

**What happens:** the agent has direct `read` access but for a
codebase-wide check the human-side `npx ledric refs check` is
faster. The agent can summarize the JSON output.

### What was this entry yesterday?

> Show me version 3 of `blog_post/hello-world`.

**What happens:** `read` with `version: 3`. Returns the entry as it
existed at that version, in the schema that was current when it was
written.

---

## Tips that make agents work better

1. **State the constraints up front.** "Required, max 120 chars,
   must be unique" — the agent will pick the right field options the
   first time and you avoid a follow-up correction loop.

2. **Reference your existing types by name.** "Add an `author`
   reference to `blog_post`" works better than "let posts have an
   author" because the agent doesn't have to guess the type name.

3. **Tell it what to do, not how.** "Backfill the missing field"
   beats "iterate over all rows and call draft for each one" —
   ledric's batching is good and the agent will pick a sensible
   approach.

4. **Use `summary` budget for surveys, `full` budget for editing.**
   "Show me all posts" should default to summary. "Edit the body of
   `hello-world`" needs full content. The agent picks the right one
   if you frame the task clearly.

5. **Examples beat descriptions for schema design.** Pasting in a
   sample blog post (frontmatter + body) and saying "set up a type
   that fits this" produces a tighter schema than describing the
   shape abstractly.

6. **Trust the validation.** If the agent's draft gets rejected, the
   error message points at the bad field. Paste the error back to
   the agent and it'll fix the value, not retry blindly.

7. **`describe_model` is cheap.** If a session feels off, ask the
   agent "re-read the schema with `describe_model`" — it'll re-ground
   on the current state of the DB.
