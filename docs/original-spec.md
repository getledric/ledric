# ledric — Design Spec (v0.1 draft)

> An MCP/LLM-native, self-hosted CMS. Content engine with a well-documented MCP surface; the LLM is a client, not a server-side dependency.

---

## 1. Thesis

A CMS is "LLM-native" only if it respects three constraints that traditional CMSes violate:

1. **Tokens are the new bandwidth.** Every response shape, schema, and default is optimized to waste as few tokens as possible. Contentful's `{sys, fields, metadata}` wrapping on every node is the archetypal anti-pattern.
2. **Agents edit differently than humans.** They batch, they diff, they need idempotency and dry-runs. Current CMSes model the "one person editing one entry" case and agents fight it.
3. **Schemas are the API.** An LLM should be able to introspect the full content model in a single cheap call and know exactly how to construct a valid entry.

Everything in this spec flows from those three.

## 2. Scope for v1

**In scope**
- Self-hosted only (hosted can come later)
- Postgres *and* SQLite as first-class storage targets
- Markdown-first rich content with opt-in raw HTML
- Code-first schemas (TypeScript primary, PHP consumes the same schema)
- MCP server + TS SDK + PHP SDK + CLI
- Full object-level version history, full-environment branching
- Dual identifiers (UUIDv7 + mutable slug) with history/tombstones
- Soft-delete with configurable retention
- BYO embeddings (pgvector / sqlite-vec) for semantic search
- Webhooks, SSE, `subscribe` MCP tool
- Contentful importer

**Explicitly cut from v1**
- Any server-side LLM calls (no auto alt-text, no NL→query, no AI translation)
- Localization (revisit post-v1)
- Editor UI (BYO or community)
- Portable Text (redundant with Markdown+directives)
- Hosted service
- Per-entry branching (full-env only for v1)

## 3. Content model

### 3.1 Schemas as code

TypeScript is the primary authoring language; schemas compile to a canonical JSON Schema dialect that the PHP SDK and the MCP server both consume.

```ts
import { defineType, field } from '@ledric/schema';

export const Product = defineType('product', {
  title:     field.string({ required: true, max: 120 }),
  slug:      field.slug({ from: 'title', unique: true }),
  body:      field.markdown({ html: 'allow' }),          // raw HTML permitted
  summary:   field.markdown({ html: 'forbid', max: 500 }),
  hero:      field.asset({ kinds: ['image'] }),
  related:   field.references({ to: ['product'], max: 6, pinning: 'auto' }),
  price:     field.number({ min: 0 }),
  tags:      field.array(field.string(), { max: 20 }),
  embedding: field.vector({ dims: 1536, byo: true }),    // client writes this
}, {
  summary_fields: ['title', 'slug', 'price', 'hero'],
  example: { /* a valid sample entry, author-written */ }
});
```

Key points:
- Schema is the single source of truth. No UI config.
- `summary_fields` declares what `depth:'summary'` returns — predictable for agents.
- `example` is hand-written and returned in `describe_model`. Single highest-leverage thing for LLM accuracy.
- Migrations are generated from schema diffs; agents can propose migrations as PRs.

### 3.2 Rich content: Markdown-first with tiered HTML

A rich-content field is a **single Markdown document**, not a block array. Diffable, copy-pasteable, natural for LLMs.

- **Inline HTML** works as CommonMark allows (`<div class="callout">…</div>`).
- **Fenced HTML blocks** via directive syntax for non-trivial cases:

  ~~~markdown
  :::html{sanitize=false trusted=true}
  <iframe src="https://…" />
  :::
  ~~~

- **Per-field HTML policy** in schema: `{ type: 'markdown', html: 'allow' | 'sanitize' | 'forbid' }`.
- **References and components** use the same `:::` directive syntax:

  ```markdown
  :::ref{to="product/widget-pro"}:::
  :::ref{to="product/widget-pro" version=42}:::
  :::component{name="PricingTable" tier="pro"}:::
  ```

### 3.3 Structural refs vs inline refs

- **Structural references** (schema fields like `related: [Product]`) — validated at write time, queryable, participate in reverse indexing. Use for app-logic dependencies.
- **Inline references** (`:::ref{...}:::` inside Markdown) — resolved at render time, not strictly validated (dangling refs warn, don't block). Use for editorial links in flowing content.

## 4. Identifiers

Every entry has both a UUID and a slug. UUID is immutable; slug is a mutable unique alias.

- **Primary key:** UUIDv7 (time-ordered → better btree locality than v4)
- **Slug:** separate unique index, required by schema for most types
- **`slug_history`** table records every retired slug with `retired_at`
- **Resolution:** any API accepts `id`, `slug`, or `type/slug` wherever a ref is expected
- **Responses** include both `id` and `slug` by default
- **Renames** retire the old slug and create a redirect record; reads against retired slugs return the current entry with `X-Ledric-Redirect` header
- **Per-type policy:** `onSlugChange: 'redirect' | 'error' | 'silent'`
- **Lint:** `ledric refs check` scans Markdown fields for dangling inline refs
- **Preference:** LLM-authored content prefers slugs (readable in prompts/diffs); machine integrations prefer UUIDs (survive renames)

## 5. Versioning & branching

### 5.1 Object-level versioning

- Every entry has a monotonic `version` integer, incremented on every write
- All versions preserved in `entry_versions` (append-only): `(entry_id, version, content_jsonb, author, created_at, parent_version, content_hash, schema_version)`
- **Publish state is a pointer:** `published_version` on the entry row
  - Publish = move pointer forward
  - Revert = move pointer backward
  - Schedule = move pointer at time T
- **Content hashes** (sha256 of normalized JSON) on every version — free ETag, powers smart merges, cheap "did anything actually change" checks
- **Schema version stamping** — every content version records the schema version it was written under, so old content reads correctly after migrations
- **Retention:** keep forever by default; offer `ledric prune` CLI
- **Asset versioning:** same model as entries

### 5.2 Full-environment branching

- Environment = `(name, parent_env, forked_at_version_per_entry)` plus new versions written within the branch
- **Copy-on-write:** creating a branch is a metadata operation. Entries unchanged in the branch read through to parent. Branch creation is ~instant.
- **Writes fork** the version chain for that entry; parent env unaffected
- **Merge is per-entry three-way** (branch head vs parent head vs common ancestor) on JSON. Conflicts surface at the field level as structured objects — agents can resolve programmatically.
- **`diff_env` MCP tool** shows "what would change if I merged this" — first-class agent workflow primitive.

### 5.3 Version pinning on references

- Per-field policy: `pinning: 'auto' | 'manual' | 'forbidden'`
- Reference forms:
  - `:::ref{to="product/widget-pro"}` — default (current in drafts, published in published)
  - `:::ref{to="product/widget-pro" version=42}` — pinned to specific version
  - `:::ref{to="product/widget-pro" version="published"}` — pinned to the published pointer
- Published rendering can freeze references at publish time so historical pages remain stable.

## 6. Soft-delete

- All deletes are soft: set `deleted_at`, keep row, keep version history
- Per-type retention (default 90 days), configurable, background GC
- **Hard delete** via `purge` tool — requires elevated token scope (GDPR path)
- Soft-deleted entries resolve for reads with `include_deleted: true` — agents can discover "what was here"
- Slug of a soft-deleted entry goes to `slug_history` immediately; reuse cooldown configurable (default: never, to protect inbound links)
- Referencing a soft-deleted entry returns structured `REFERENCE_TOMBSTONED` error with deletion reason

## 7. Storage portability

Postgres and SQLite are first-class. Same logical model, two engines.

- **Port/adapter pattern:** `Storage` interface; both engines implement
- **Capability flags** reported via `describe_model`:
  ```ts
  storage.capabilities = {
    vectorSearch: true,
    nativePubSub: true,         // Postgres LISTEN/NOTIFY vs in-process on SQLite
    fts: 'tsvector' | 'fts5'
  }
  ```
- **Vectors:** `pgvector` (Postgres) / `sqlite-vec` (SQLite, not vss)
- **Pub/sub for `subscribe`:** Postgres `LISTEN/NOTIFY`; SQLite in-process bus. Same SSE stream externally.
- **FTS:** Postgres `tsvector`; SQLite `FTS5`
- **Migrations:** one logical migration DSL, two generated SQL files per migration
- **Tradeoff:** merge performance on large-scale branch operations better on Postgres (JSONB indexing). Acceptable for SQLite's target scale.

## 8. MCP surface

### 8.1 Conventions

- `_meta` (version, env, schema_version, content_hash, request_id) returned only when `include_meta: true` (save tokens by default)
- Every mutation supports `dry_run: true` returning the computed diff
- Every read supports `max_tokens: N` — server truncates intelligently, returns `truncated: true` + `continue_cursor`
- `env` defaults to the token's default env; per-call override allowed
- All errors are structured (see §9)

### 8.2 `describe_model`

The single most important tool. If this is weak, nothing else matters.

```ts
// Request
{
  types?: string[],
  include?: Array<'examples' | 'references' | 'deprecated' | 'validation_rules'>,
  format?: 'full' | 'compact'   // compact ~70% smaller
}

// Response (single-type excerpt)
{
  schema_version: 17,
  types: {
    product: {
      description: "A sellable item",
      identifier_field: "slug",
      display_field: "title",
      summary_fields: ["title", "slug", "price", "hero"],
      fields: {
        title:     { type: "string", required: true, max: 120 },
        slug:      { type: "slug", from: "title", unique: true },
        body:      { type: "markdown", html: "allow" },
        hero:      { type: "asset", kinds: ["image"] },
        related:   { type: "references", to: ["product"], max: 6, pinning: "auto" },
        price:     { type: "number", min: 0 },
        embedding: { type: "vector", dims: 1536, byo: true }
      },
      references_from: ["blog_post.products", "collection.items"],
      example: { /* valid product entry */ }
    }
  },
  capabilities: { vectorSearch: true, nativePubSub: true, fts: "tsvector" }
}
```

### 8.3 `find`

```ts
// Request
{
  type: string | string[],
  where?: Filter,
  order?: Array<{ field: string, dir: 'asc' | 'desc' }>,
  limit?: number,              // default 20, max 200
  cursor?: string,
  depth?: 'list' | 'summary' | 'full',  // default 'summary'
  select?: string[],           // explicit field mask (overrides depth)
  include?: Record<string, { depth?: ..., select?: string[] }>,
  max_tokens?: number,
  env?: string,
  as_of?: { version?: number, time?: string }
}

// Filter DSL
type Filter =
  | { field: string, op: 'eq'|'ne'|'gt'|'lt'|'gte'|'lte'|'in'|'contains'|'starts_with', value: any }
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { text: string, in?: string[] }              // FTS
  | { vector: number[], in: string, k?: number } // BYO embedding

// Response
{ results: Entry[], cursor?: string, total?: number, truncated?: boolean }
```

Intentionally small grammar — agents pattern-match faster on small DSLs.

### 8.4 `read`

```ts
{
  ref: string,                                  // id | slug | "type/slug"
  version?: number | 'current' | 'published',
  env?: string,
  depth?: 'summary' | 'full',                   // default 'full' for single read
  select?: string[],
  include?: Record<string, {...}>,
  max_tokens?: number,
  include_meta?: boolean
}

// Response
{
  id, slug, type,
  fields: { ... },
  _redirect?: { from: "widget", to: "widget-pro" },
  _meta?: {...}
}
```

### 8.5 `draft`

Create or update a draft (full-body write).

```ts
{
  type: string,
  ref?: string,                // omit = create, provide = update
  fields: Record<string, any>,
  parent_version?: number,     // required on update
  env?: string,
  dry_run?: boolean
}

// Response
{ id, slug, version, status: "draft", diff?: Diff, validation: {...} }
```

### 8.6 `patch` — primary update path

Far more token-efficient than `draft` for edits.

```ts
{
  ref: string,
  parent_version: number,      // required
  patches: Array<              // RFC 6902
    | { op: 'add', path, value }
    | { op: 'replace', path, value }
    | { op: 'remove', path }
    | { op: 'move', from, path }
    | { op: 'test', path, value }   // conditional — concurrency gem
  >,
  env?: string,
  dry_run?: boolean
}

// Conflict response
{
  error: {
    code: "VERSION_CONFLICT",
    current_version: 47,
    your_parent_version: 45,
    conflicting_paths: ["/fields/price", "/fields/body"],
    suggestion: "re-read the entry and re-apply your patches"
  }
}
```

### 8.7 `publish`

```ts
{
  ref: string | string[],      // batch
  version?: number,            // default: latest draft
  schedule_at?: string,        // ISO; omit = immediate
  env?: string,
  dry_run?: boolean
}

// Response
{ published: [{ ref, version, published_at }], scheduled: [...] }
```

### 8.8 `validate`

Pure validation without writing.

```ts
// Either:
{ type: string, fields: object, env?: string }
// Or:
{ ref: string, env?: string }

// Response
{ ok: boolean, errors: ValidationError[], warnings: ValidationWarning[] }
```

### 8.9 Version tools

```ts
list_versions({ ref, limit?, cursor? })
  → { versions: [{ version, author, created_at, hash, summary }] }

read_version({ ref, version })       → Entry
revert({ ref, to_version, dry_run? }) → { new_version, diff }
diff({ ref, from_version, to_version }) → Diff
diff_env({ from_env, to_env, types?: string[] })
  → { entries: [{ ref, status: 'added'|'modified'|'removed', diff }] }
```

### 8.10 `subscribe`

```ts
{
  filter: {
    types?: string[],
    refs?: string[],
    events?: ('created'|'updated'|'published'|'deleted'|'reverted')[],
    env?: string
  },
  since?: string               // cursor; resume from offset
}

// Stream (SSE)
{ cursor, event: 'published', ref, type, version, timestamp, actor }
```

Server coalesces rapid edits on the same entry within a ~250ms window to keep token costs sane for agents tailing the stream.

## 9. Error model

Consistent across all tools:

```ts
{
  error: {
    code: "VALIDATION_FAILED",          // enumerated, stable
    message: "Price must be >= 0",
    details: [
      {
        path: "/fields/price",
        rule: "min",
        expected: 0,
        actual: -5,
        suggestion: "Set price to a non-negative number"
      }
    ],
    retryable: false,
    docs_url: "ledric://errors/VALIDATION_FAILED"
  }
}
```

### Reserved error codes

`VALIDATION_FAILED`, `VERSION_CONFLICT`, `REFERENCE_NOT_FOUND`, `REFERENCE_TOMBSTONED`, `SLUG_CONFLICT`, `PERMISSION_DENIED`, `SCHEMA_MISMATCH`, `ENV_NOT_FOUND`, `TOKEN_BUDGET_EXCEEDED`, `NOT_FOUND`, `RATE_LIMITED`.

## 10. Auth

- Scoped API tokens with per-type, per-op, per-field grants
- Agent tokens distinct from user tokens (separate audit + rate limits)
- Elevated scope required for `purge` (hard delete)

## 11. DX

- TS SDK with types generated from schema; regenerates on migration
- PHP SDK with attribute-driven models
- CLI: `ledric schema push/pull/diff`, `ledric migrate`, `ledric env branch`, `ledric refs check`, `ledric prune`
- Single `docker compose` for local dev (Postgres + ledric)
- `sqlite://` mode for zero-dependency local dev
- Contentful importer (types + entries + assets + locales)
- Portable JSON export (anti-lock-in)

## 12. Problems this explicitly solves vs Contentful

| Contentful pain | ledric fix |
|---|---|
| Verbose `sys/fields` wrappers eat tokens | Flat entries; metadata under explicit `_meta` only when requested |
| Rich text JSON hard for LLMs to read/write | Markdown + directive syntax; HTML when you need it |
| GraphQL nesting → N+1 and token bloat | Flat DSL + explicit field masks + persisted queries |
| Content model changes via API are clunky | Schema-as-code with generated migrations |
| Environments slow to spin up | Copy-on-write branching, ~instant |
| Generic/slow MCP | Native MCP designed with the data model |
| Localization duplicates everything | Out of v1 scope (deliberate) |
| No agent-aware permissions or audit | First-class agent identity |

## 13. Open questions / next up

1. **Postgres storage schema** — tables, indexes, how branching is represented on disk, merge algorithm, tombstone GC, version GC. **(next section to write)**
2. **SQLite mapping** — where it diverges in indexing and FTS, same-data-different-SQL migrations.
3. **Persisted queries** — API shape, lifecycle, invalidation on schema change.
4. **Asset storage backends** — filesystem vs S3-compatible; how derivatives are generated and cached without server-side image processing becoming a rabbit hole.
5. **Auth provider model** — local tokens only in v1, or OIDC hooks?
6. **Webhook signing / retry policy** — concrete numbers.
7. **Telemetry / query analyzer** — what's in v1 vs later.

---

*Document status: living spec, v0.1. Revised after each design session.*
