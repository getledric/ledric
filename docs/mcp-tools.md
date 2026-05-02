# MCP tools reference

The full tool surface ledric exposes over MCP. Twenty tools, grouped
by lifecycle. Each is callable from any MCP client (Claude Desktop,
Claude Code, Cursor, your own client) — and each is also reachable
via HTTP at `POST /rpc` with `{ "tool": "<name>", "args": {...} }` if
you don't want to speak MCP.

For a working understanding of *when* to call which tool, see
[`agent-recipes.md`](./agent-recipes.md). For the schema concepts the
tools operate on, see [`schema.md`](./schema.md).

- [Conventions](#conventions)
- [Schema lifecycle](#schema-lifecycle) — `describe_model`, `create_type`, `alter_type`, `delete_type`, `migrate_entries`
- [Entries](#entries) — `draft`, `read`, `find`, `publish`, `rename_entry`, `delete_entry`
- [Assets](#assets) — `get_asset`, `list_assets`, `update_asset`
- [Tags](#tags) — `add_*_tags`, `remove_*_tags`, `list_tags`, `update_tag`
- [Errors](#errors)

---

## Conventions

**`ref`** — entries are addressed by `{ type, slug }`. References in
markdown use `:::ref{to="type/slug"}:::` (or `type/slug@N` to pin a
version).

**`parent_version`** — every mutating call that touches an existing
row takes `parent_version` and rejects writes that don't match the
row's current version. This is optimistic concurrency: two agents
writing in parallel will not silently clobber each other.

**`author`** — most mutations accept an optional `author` string used
in audit columns. Stick a stable label here (`"claude-desktop"`,
`"vercel-cron"`, an email) so version history stays legible.

**Token budgets** — list endpoints (`find`, `list_assets`) return
summary-budget rows by default. Call with `expand_assets: true` or
`resolve_refs: true` only when you need the inlined shape — those
budgets cost more tokens.

---

## Schema lifecycle

### `describe_model`

Return the full content model: every type's fields, summary fields,
example, plus the runtime capabilities of this ledric instance.
Always idempotent. Cheap. Call this at session start.

**Args:** none.

**Returns:** `{ types: [...], features: {...}, field_types: [...] }`.

```json
{ "tool": "describe_model", "args": {} }
```

### `create_type`

Create a new content type at version 1.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | Lowercase, `^[a-z][a-z0-9_]*$` |
| `fields` | object | yes | Map of `field_name → FieldDef` (see [schema.md](./schema.md)) |
| `opts` | object | no | `description`, `display_field`, `summary_fields`, `identifier_field`, `on_slug_change`, `example` |
| `author` | string | no | Audit label |

**Returns:** the newly-written type at version 1.

```json
{
  "tool": "create_type",
  "args": {
    "name": "blog_post",
    "fields": {
      "title": { "type": "string", "required": true, "max": 120 },
      "slug": { "type": "slug", "required": true, "from": "title" },
      "body": { "type": "markdown", "required": true }
    },
    "opts": {
      "display_field": "title",
      "summary_fields": ["title"]
    }
  }
}
```

### `alter_type`

Mutate an existing type via JSON Merge Patch (RFC 7396).

| Arg | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | |
| `parent_version` | integer | yes | Type's current version |
| `merge_patch` | object | yes | Recursive RFC 7396 patch. Null values delete keys. |
| `dry_run` | boolean | no | Preview without writing |
| `author` | string | no | |

**Returns:** `{ name, version, change_class, diff }`.
`change_class` ∈ `safe` | `needs_backfill` | `destructive`.

```json
{
  "tool": "alter_type",
  "args": {
    "name": "blog_post",
    "parent_version": 3,
    "merge_patch": {
      "fields": {
        "reading_time": { "type": "number", "integer": true, "min": 0 }
      }
    }
  }
}
```

### `delete_type`

Soft-delete a content type.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `name` | string | yes | |
| `parent_version` | integer | yes | |
| `cascade` | boolean | no | Required when the type still has live entries. Soft-deletes them too. |
| `author` | string | no | |

**Returns:** `{ name, deleted_at }`.

Without `cascade: true` the call fails with `TYPE_NOT_EMPTY` if any
entries remain. Reads stop seeing soft-deleted rows; the data stays
in storage and can be recovered manually.

### `migrate_entries`

Re-validate every entry of a type against its current schema, with
an optional merge patch applied first.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | |
| `merge_patch` | object | no | RFC 7396 patch applied to each entry's content before re-validation |
| `filter` | object | no | Exact-match filter on top-level fields (only migrate matching rows) |
| `dry_run` | boolean | no | |
| `limit` | integer | no | Max rows to touch. Defaults to all matching. |
| `author` | string | no | |

**Returns:** `{ type, schema_version, checked, migrated, failed: [...] }`.

```json
{
  "tool": "migrate_entries",
  "args": {
    "type": "blog_post",
    "merge_patch": { "status": "draft" },
    "filter": { "status": null }
  }
}
```

---

## Entries

### `draft`

Create or update a draft entry. Same tool for both — `ref` distinguishes.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | |
| `fields` | object | yes | Entry content keyed by field name |
| `ref` | `{ type, slug }` | no | Provide to update. Omit to create new. |
| `parent_version` | integer | conditionally | Required when `ref` is set |
| `author` | string | no | |

**Returns:** `{ type, slug, version, fields }` — same envelope used by
the HTTP `GET /entries/:type/:slug` route. Your content lives under
`fields`; top-level keys are entry metadata.

If `ref` is omitted, the slug is derived from the type's
`identifier_field` (defaults to whatever `slug` field contains, or to
the slugified `display_field`). Drafts don't go live until you call
`publish`.

```json
{
  "tool": "draft",
  "args": {
    "type": "blog_post",
    "fields": {
      "title": "Why I switched to Kysely",
      "slug": "why-kysely",
      "body": "# Why\n\nIt was time."
    }
  }
}
```

### `read`

Read a single entry by ref.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `ref` | `{ type, slug }` | yes | |
| `version` | integer | no | Specific historical version |
| `locale` | string | no | Project into this locale (must be in type's `locales`) |
| `expand_assets` | boolean \| string[] | no | `true` expands every asset field; array picks specific ones |
| `resolve_references` | boolean \| string[] | no | Inlines `references`-typed field values (each becomes `{ id, type, slug, version, fields }`). Different from `resolve_refs` below. |
| `resolve_refs` | boolean | no | Walk markdown for `:::ref{}` directives, attach `_refs` sidecar |

**Returns:** the entry record. Returns `null` when not found.

```json
{
  "tool": "read",
  "args": {
    "ref": { "type": "blog_post", "slug": "why-kysely" },
    "expand_assets": true
  }
}
```

If the slug was renamed, the response includes `_redirect: "new-slug"`
so the agent (and the inline editor) can follow the trail.

### `find`

List entries of a type. Paginated, filterable, sortable.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | |
| `where` | object | no | Map of `field_name → value` (exact match on top-level fields) |
| `tags` | string[] | no | AND semantics — entry must have ALL listed tags |
| `limit` | integer | no | 1–200, default 20 |
| `offset` | integer | no | |
| `order` | `[{ field, dir }]` | no | `dir` ∈ `asc` \| `desc` |
| `locale` | string | no | Project results into this locale |
| `expand_assets` | boolean \| string[] | no | |
| `resolve_references` | boolean \| string[] | no | Inline `references` fields. Distinct from `resolve_refs`. |
| `resolve_refs` | boolean | no | |
| `q` | string | no | Full-text search across `searchable: true` fields. Overrides `order` with relevance rank. |
| `includeDeleted` | boolean | no | Include soft-deleted rows |

**Returns:** `{ results: [...], total, offset }`.

```json
{
  "tool": "find",
  "args": {
    "type": "blog_post",
    "tags": ["featured"],
    "order": [{ "field": "published_at", "dir": "desc" }],
    "limit": 10
  }
}
```

### `publish`

Mark an entry's version as published.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `ref` | `{ type, slug }` | yes | |
| `version` | integer | no | Defaults to the entry's current version |

**Returns:** `{ type, slug, published_version }`.

Publishing is a pointer move: instant, reversible (publish a
different version to "revert"), and doesn't rewrite content.

### `rename_entry`

Change an entry's slug.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `ref` | `{ type, slug }` | yes | The current ref |
| `new_slug` | string | yes | 1–64 chars, `a-z` / `0-9` / hyphens; no leading/trailing hyphen |
| `locale` | string | no | Rename a non-default-locale slug only |

**Returns:** `{ type, slug, old_slug }`.

The old slug retires into `slug_history` and keeps resolving forever.
Reads of the old slug return the entry with `_redirect: "new-slug"`.
The inline editor's `data-ledric-ref` keeps working.

### `delete_entry`

Soft-delete a single entry.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `ref` | `{ type, slug }` | yes | |
| `parent_version` | integer | yes | |
| `author` | string | no | |

**Returns:** `{ type, slug, deleted_at }`.

Reads stop seeing it; the row stays in storage. Reusing the same slug
for a fresh entry currently requires a manual hard-purge.

---

## Assets

Asset uploads happen via the CLI (`ledric asset upload <file>`) or
the HTTP `POST /assets` endpoint — base64 over MCP would burn tokens
needlessly. The MCP tools cover everything except the upload itself.

### `get_asset`

Read an asset's metadata.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | 32-char hex UUIDv7 |
| `version` | integer | no | Specific historical version |

**Returns:** `{ id, ref_key, kind, current_version, storage_ref, meta, ... }`. Bytes are not returned.

### `list_assets`

| Arg | Type | Required | Notes |
|---|---|---|---|
| `kind` | string | no | `image` \| `video` \| `file` \| ... |
| `tags` | string[] | no | AND semantics |
| `limit` | integer | no | 1–200 |
| `offset` | integer | no | |
| `includeDeleted` | boolean | no | |

**Returns:** `{ results, total, offset }`.

### `update_asset`

Replace an asset's bytes in place. The asset id stays put, but a
fresh `ref_key` is minted so URLs change automatically and caches
invalidate.

| Arg | Type | Required | Notes |
|---|---|---|---|
| `id` | string | yes | |
| `parent_version` | integer | yes | Must match `assets.current_version` |
| `bytes_b64` | string | yes | Base64-encoded raw bytes |
| `meta` | object | no | **Replaces** previous meta entirely (no merge); omit to carry forward |
| `author` | string | no | |

**Returns:** the new asset record at the bumped version.

Entries that referenced this asset by id keep working without
modification. Their `expand_assets` URLs reflect the new bytes
because `ref_key` changed.

---

## Tags

Tags are normalized server-side: a leading `#` is stripped,
whitespace collapses, the slug lowercases and hyphenates, the label
preserves case as written. `"#Featured Event"`, `"featured event"`,
and `"FEATURED EVENT"` all collapse to slug `"featured-event"`. The
first writer of a new tag wins its display label; later writers
inherit it (use `update_tag` to relabel).

### `add_asset_tags`

| Arg | Type | Required |
|---|---|---|
| `id` | string | yes |
| `tags` | string[] | yes (≥1) |

**Returns:** updated `tags: [{ slug, label }, ...]` for the asset.

### `remove_asset_tags`

Same args as `add_asset_tags`. Tags are matched by slug
(case/whitespace insensitive — pass `"Featured Event"` or
`"featured-event"` interchangeably).

**Returns:** `{ removed: <count> }`.

### `add_entry_tags`

| Arg | Type | Required |
|---|---|---|
| `ref` | `{ type, slug }` | yes |
| `tags` | string[] | yes (≥1) |

**Returns:** updated `tags: [{ slug, label }, ...]` for the entry.

### `remove_entry_tags`

Same args as `add_entry_tags`.

**Returns:** `{ removed: <count> }`.

### `list_tags`

Every tag in the env, ordered by total uses
(`asset_uses + entry_uses`) descending, then label ascending.

**Args:** none.

**Returns:** `[{ slug, label, asset_uses, entry_uses }, ...]`.

### `update_tag`

Relabel a tag. The slug is the stable identity and never changes.

| Arg | Type | Required |
|---|---|---|
| `slug` | string | yes |
| `label` | string | yes |

**Returns:** the updated tag, or `null` when no tag with that slug exists.

---

## Errors

ledric returns structured JSON errors over MCP — agents can pattern-match
on `code` and recover rather than retrying blindly.

| Code | Meaning |
|---|---|
| `VALIDATION` | Content failed schema validation. The error body lists field paths and why each failed. |
| `VERSION_CONFLICT` | `parent_version` didn't match. Re-read the entry/type/asset, merge, retry. |
| `NOT_FOUND` | Ref points at nothing (or the row was soft-deleted). |
| `TYPE_NOT_EMPTY` | `delete_type` without `cascade: true` while entries exist. |
| `SLUG_TAKEN` | `rename_entry` (or `draft` create) collided with an existing slug. |
| `BAD_REQUEST` | Args failed schema validation before execution. |

Each carries a human-readable `message` plus tool-specific fields
(e.g. `field_path` on validation errors, `current_version` on
version conflicts).
