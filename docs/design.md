# ledric — Design Spec (v0.2 draft)

> An MCP/LLM-native, self-hosted CMS. Content engine with a well-documented MCP surface; the LLM is a client, not a server-side dependency.

**Changes from v0.1:** schemas are now DB-resident first-class entities (not code-first); storage is a type-agnostic object store (no per-type tables); one process hosts the HTTP API and the MCP server side-by-side over a shared Core (no separate management API — token scopes do the split); stack decisions made concrete (Node 22+, pnpm, Drizzle, Fastify, `better-sqlite3`, Citty, Zod, cosmiconfig, tsup); environments and branching explicitly deferred but the data model leaves the door open.

---

## 1. Thesis

A CMS is "LLM-native" only if it respects three constraints that traditional CMSes violate:

1. **Tokens are the new bandwidth.** Every response shape, schema, and default is optimized to waste as few tokens as possible. Contentful's `{sys, fields, metadata}` wrapping on every node is the archetypal anti-pattern.
2. **Agents edit differently than humans.** They batch, they diff, they need idempotency and dry-runs. Current CMSes model the "one person editing one entry" case and agents fight it.
3. **Schemas are the API.** An LLM should be able to introspect the full content model in a single cheap call and know exactly how to construct a valid entry — and, when needed, to evolve the content model itself the same way.

Everything in this spec flows from those three.

## 2. Scope for v1

**In scope**
- Self-hosted, standalone binary (`ledric serve`)
- SQLite by default; Postgres as a second-tier target through the same abstraction
- Markdown-first rich content with opt-in raw HTML
- **Schemas are data** — stored in the DB, versioned, mutable via MCP; TypeScript `defineType` is an optional sync helper, not the source of truth
- MCP server (stdio + HTTP+SSE), HTTP API (tool-shaped POST + REST GET sugar), CLI
- Full object-level version history for entries *and* for schemas
- Dual identifiers (UUIDv7 + mutable slug) with history/tombstones
- Soft-delete with configurable retention
- BYO embeddings (pgvector / sqlite-vec) for semantic search
- Webhooks, SSE, `subscribe` MCP tool
- Vanilla TS consumer SDK (read-focused)
- Contentful importer

**Explicitly cut from v1 (but not painted out of)**
- Environments / branching / merging (single implicit `main` env; every row carries `env_id` so branches can land later without migrating data)
- Any server-side LLM calls (no auto alt-text, no NL→query, no AI translation)
- Localization (revisit post-v1; slug model plans for per-locale expansion)
- Editor UI (BYO or community)
- Portable Text (redundant with Markdown+directives)
- Hosted service
- Per-type materialized columns/tables (object-store only for v1; materialization is a future optimization)
- Framework-specific client helpers (vanilla only)

## 3. Runtime architecture

Single process. Two transports. One Core.

```
                    ┌─────────────────────────────────┐
                    │  ledric (single process)        │
                    │                                 │
  HTTP clients ───► │  ┌──────────┐    ┌───────────┐  │
  (SDKs, webhooks,  │  │ HTTP API │    │ MCP server│  │◄─── Claude
   browser preview) │  │ (Fastify)│    │(stdio/SSE)│  │
                    │  └────┬─────┘    └─────┬─────┘  │
                    │       │                │        │
                    │       ▼                ▼        │
                    │       ┌─────── Core ──────┐     │
                    │       │ schema engine,    │     │
                    │       │ versioning, refs, │     │
                    │       │ validation, ACL   │     │
                    │       └─────┬─────────────┘     │
                    │             ▼                   │
                    │       ┌──── Drizzle ────┐       │
                    │       └─────────────────┘       │
                    └─────────────────────────────────┘
```

- **One HTTP API**, not two. There is no separate "management API." A single surface with **scoped tokens** does the split — a read-only token can only hit `find` / `read` on published content; an admin token can write, publish, and mutate the schema. This is simpler to build and document, and a CDN can still front the GET routes as a deployment concern.
- **HTTP API is tool-shaped.** Primary surface is `POST /rpc` with `{tool, args}`, mirroring MCP 1:1 so one implementation powers both. Sugar GET routes (`GET /entries/:type/:slug`, etc.) are a cache-friendly projection for reads only.
- **MCP server** runs both stdio and HTTP+SSE transports by default; either can be disabled. Both invoke Core in-process, not via the HTTP API — no internal hop.
- **CLI** shares the same Core package. Server-requiring subcommands (`serve`, `subscribe`) start the runtime; offline subcommands (`migrate`, `prune`, `refs check`, `schema push/pull/diff`) call Core directly against the configured DB.
- **Bootstrap.** Running `ledric serve` in an empty directory creates `./ledric.config.json` and `./ledric.db` (SQLite) and starts up. No `ledric init` required.
- **Embedding.** v1 ships as a standalone service. Mounting Core into an existing Fastify/Express app is not supported in v1 but Core's boundaries are kept clean to allow it later.

## 4. Content model

### 4.1 Schemas are data

Schemas (content types) live in the database as first-class, versioned entities. They are created and evolved through the MCP, the same way entries are. The canonical representation is JSON; the TypeScript `defineType` / `field.*` helpers are an optional code-first sync workflow that produces the same JSON.

**Canonical form (JSON), as stored:**

```json
{
  "name": "product",
  "description": "A sellable item",
  "identifier_field": "slug",
  "display_field": "title",
  "summary_fields": ["title", "slug", "price", "hero"],
  "on_slug_change": "redirect",
  "fields": {
    "title":     { "type": "string", "required": true, "max": 120 },
    "slug":      { "type": "slug", "from": "title", "unique": true },
    "body":      { "type": "markdown", "html": "allow" },
    "summary":   { "type": "markdown", "html": "forbid", "max": 500 },
    "hero":      { "type": "asset", "kinds": ["image"] },
    "related":   { "type": "references", "to": ["product"], "max": 6, "pinning": "auto" },
    "price":     { "type": "number", "min": 0 },
    "tags":      { "type": "array", "of": { "type": "string" }, "max": 20 },
    "embedding": { "type": "vector", "dims": 1536, "byo": true }
  },
  "example": { "title": "Widget Pro", "slug": "widget-pro", "price": 49, "body": "…" }
}
```

**Optional TypeScript sugar (not the source of truth):**

```ts
import { defineType, field } from '@ledric/schema';

export const Product = defineType('product', {
  title:   field.string({ required: true, max: 120 }),
  slug:    field.slug({ from: 'title', unique: true }),
  body:    field.markdown({ html: 'allow' }),
  // ...
}, {
  summary_fields: ['title', 'slug', 'price', 'hero'],
  example: { /* ... */ }
});
```

Users who prefer code-as-source-of-truth maintain `.ts` (or `.json`, or `.yaml`) files and run `ledric schema push` to upsert them. Most users will evolve schemas conversationally through the MCP and never use the code path.

**Key points:**
- `summary_fields` declares what `depth:'summary'` returns — predictable for agents.
- `example` is hand-written (or LLM-written) and returned in `describe_model`. Single highest-leverage thing for LLM accuracy.
- Schema changes are **classified** at mutation time as `safe` (adds optional field, widens constraint, updates `example`), `needs_backfill` (adds required field with default, renames field), or `destructive` (removes field, narrows type). Destructive operations require elevated scope.
- Schemas are versioned: every entry version stamps the schema version it was written under. See §6.2.

### 4.2 Rich content: Markdown-first with tiered HTML

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

### 4.3 Structural refs vs inline refs

- **Structural references** (schema fields like `related: [Product]`) — validated at write time, queryable, participate in reverse indexing. Use for app-logic dependencies.
- **Inline references** (`:::ref{...}:::` inside Markdown) — resolved at render time, not strictly validated (dangling refs warn, don't block). Use for editorial links in flowing content.

## 5. Identifiers

Every entry has both a UUID and a slug. UUID is immutable; slug is a mutable unique alias.

- **Primary key:** UUIDv7 (time-ordered → better btree locality than v4).
- **Slug:** separate unique index, required by schema for most types.
- **`slug_history`** table records every retired slug with `retired_at`.
- **Resolution:** any API accepts `id`, `slug`, or `type/slug` wherever a ref is expected.
- **Responses** include both `id` and `slug` by default.
- **Renames** retire the old slug and create a redirect record; reads against retired slugs return the current entry with `X-Ledric-Redirect` header (and a `_redirect` field in tool-shaped responses).
- **Per-type policy:** `on_slug_change: 'redirect' | 'error' | 'silent'`.
- **Lint:** `ledric refs check` scans Markdown fields for dangling inline refs.
- **Preference:** LLM-authored content prefers slugs (readable in prompts/diffs); machine integrations prefer UUIDs (survive renames).

## 6. Versioning

### 6.1 Entry versioning

- Every entry has a monotonic `version` integer, incremented on every write.
- All versions preserved in `entry_versions` (append-only): `(entry_id, version, content_jsonb, author, created_at, parent_version, content_hash, schema_version)`.
- **Publish state is a pointer:** `published_version` on the entry row.
  - Publish = move pointer forward.
  - Revert = move pointer backward.
  - Schedule = move pointer at time T.
- **Content hashes** (sha256 of normalized content JSON, not resolved refs) on every version — free ETag, powers smart merges, cheap "did anything actually change" checks.
- **Schema version stamping** on every content version. Old content reads correctly after schema migrations (see §6.2).
- **Retention:** keep forever by default; offer `ledric prune` CLI.
- **Asset versioning:** same model as entries.

### 6.2 Schema versioning

Parallel to entry versioning.

- Every type has a monotonic `version` integer, incremented on every schema mutation.
- All versions preserved in `type_versions` (append-only): `(type_id, version, definition_jsonb, author, created_at, parent_version, change_class)`.
- `change_class` ∈ `safe | needs_backfill | destructive` — classified by the mutation tool and recorded at write time.
- **Read model for old content:** entries keep their stamped schema version and are passed through as-written. No migrate-on-read (tarpit). Explicit opt-in migration via `migrate_entries` tool, which walks entries of a given type and applies a transformation (default: validate under the current schema and re-stamp; custom transforms supported).
- **Revert:** a bad schema change is reverted with `revert_type(to_version)` — same semantics as `revert` for entries.

### 6.3 Environments (deferred, but shaped)

Environments / branching / merging are out of v1. The data model accommodates them so the future landing isn't a nightmare refactor:

- Every `entries`, `entry_versions`, `types`, `type_versions`, and `slug_history` row carries `env_id`.
- A bootstrapped `main` env exists; v1 writes and reads only touch `main`.
- Tools accept an `env` parameter that must equal the single env's name in v1.
- When branching lands, we add `parent_env_id`, `forked_at_version_per_entry`, copy-on-write read logic, three-way merge per entry, and the `diff_env` tool. No existing tables move.

### 6.4 Version pinning on references

- Per-field policy: `pinning: 'auto' | 'manual' | 'forbidden'`.
- Reference forms:
  - `:::ref{to="product/widget-pro"}` — default (current in drafts, published in published).
  - `:::ref{to="product/widget-pro" version=42}` — pinned to specific version.
  - `:::ref{to="product/widget-pro" version="published"}` — pinned to the published pointer.
- Published rendering can freeze references at publish time so historical pages remain stable.

## 7. Soft-delete

- All deletes are soft: set `deleted_at`, keep row, keep version history.
- Per-type retention (default 90 days), configurable, background GC.
- **Hard delete** via `purge` tool — requires `content:destructive` scope (GDPR path).
- Soft-deleted entries resolve for reads with `include_deleted: true` — agents can discover "what was here."
- Slug of a soft-deleted entry becomes a redirect tombstone immediately and is never reusable by default (reuse cooldown configurable).
- Referencing a soft-deleted entry returns a structured `REFERENCE_TOMBSTONED` error with deletion reason.

## 8. Storage

**Storage is a type-agnostic object store.** There is no `blog_post` table, no `product` table. A small fixed set of skeletal tables holds every entry's content as JSONB; the schema engine validates and projects at read/write time.

### 8.1 Skeletal tables (shape, not final DDL)

| Table | Purpose |
|---|---|
| `envs` | `(id, name)`. Bootstrapped with one row `main`. Placeholder for branching. |
| `types` | Current pointer per content type: `(id, name, current_version, published_version, deleted_at, env_id)`. |
| `type_versions` | Append-only schema history: `(type_id, version, definition_jsonb, change_class, author, created_at, parent_version)`. |
| `entries` | Current pointer per entry: `(id, type_id, slug, current_version, published_version, deleted_at, env_id)`. |
| `entry_versions` | Append-only content history: `(entry_id, version, content_jsonb, schema_version, content_hash, author, created_at, parent_version)`. |
| `slug_history` | `(slug, entry_id, retired_at, env_id)`. Powers redirects and dangling-ref detection. |
| `assets` | `(id, kind, storage_ref, meta_jsonb, env_id)` + `asset_versions` parallel to `entry_versions`. |
| `refs_out` | Materialized structural reference index: `(from_entry, from_version, from_field, to_entry, to_version_pin)`. |
| `subscriptions` | Webhook targets + SSE cursors. |
| `tokens` | Scoped API tokens. |

Per-type indexes on `content_jsonb` are created by the schema engine when a type declares `indexed` fields in its definition (e.g., `price`, `published_at`). Both Drizzle targets expose JSON indexing, so this is a common code path with target-specific SQL.

### 8.2 Capabilities

Core reports capabilities at runtime via `describe_model.capabilities`:

```ts
{
  vectorSearch: boolean,     // pgvector / sqlite-vec present
  nativePubSub: boolean,     // LISTEN/NOTIFY vs in-process bus
  fts: 'tsvector' | 'fts5'
}
```

The MCP `find` tool's `text` and `vector` filter grammars are identical across targets; underlying SQL differs.

### 8.3 Pub/sub

- SQLite: in-process bus; the single running `ledric` process broadcasts to local subscribers.
- Postgres: `LISTEN/NOTIFY`; multiple processes can tail the same stream.
- Either way, the externally observable SSE stream is identical. `subscribe` coalesces rapid edits on the same entry within a ~250 ms window.

### 8.4 Migrations

The skeletal schema evolves via standard SQL migrations (one file per dialect, generated by Drizzle's migrator plus hand-written SQL for FTS/vector index setup).

Content schemas (what's inside `content_jsonb`) are **not** SQL migrations — they are rows in `type_versions`. Changing a content schema is a DB write, not a DDL operation.

## 9. MCP surface

### 9.1 Conventions

- `_meta` (version, env, schema_version, content_hash, request_id) returned only when `include_meta: true` (save tokens by default).
- Every mutation supports `dry_run: true` returning the computed diff and, for schema mutations, the change class.
- Every read supports `max_tokens: N` — server truncates intelligently, returns `truncated: true` + `continue_cursor`.
- `env` defaults to the token's default env; per-call override allowed.
- All errors are structured (see §10).

### 9.2 `describe_model`

The single most important tool. If this is weak, nothing else matters.

```ts
// Request
{
  types?: string[],
  include?: Array<'examples' | 'references' | 'deprecated' | 'validation_rules'>,
  format?: 'full' | 'compact'   // compact ~70% smaller: drops examples, descriptions, deprecated fields
}

// Response (single-type excerpt)
{
  schema_version: 17,
  types: {
    product: {
      description: "A sellable item",
      version: 4,
      identifier_field: "slug",
      display_field: "title",
      summary_fields: ["title", "slug", "price", "hero"],
      fields: { /* per §4.1 canonical form */ },
      references_from: ["blog_post.products", "collection.items"],
      example: { /* valid product entry */ }
    }
  },
  capabilities: { vectorSearch: true, nativePubSub: false, fts: "fts5" }
}
```

### 9.3 `find`

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

// depth='list' returns { id, slug, type } only — cheapest possible shape.

// Filter DSL
type Filter =
  | { field: string, op: 'eq'|'ne'|'gt'|'lt'|'gte'|'lte'|'in'|'contains'|'starts_with', value: any }
  | { and: Filter[] }
  | { or: Filter[] }
  | { not: Filter }
  | { text: string, in?: string[] }                 // FTS
  | { vector: number[], in: string, k?: number }    // BYO embedding; `in` is "type.field"

// Response
{ results: Entry[], cursor?: string, total?: number, truncated?: boolean }
```

Intentionally small grammar — agents pattern-match faster on small DSLs.

### 9.4 `read`

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

### 9.5 `draft`

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

### 9.6 `patch` — primary update path

Far more token-efficient than `draft` for edits. Accepts RFC 6902 (JSON Patch) as the primary dialect; JSON Merge Patch (RFC 7396) accepted as `merge_patch` for simple "set these fields" cases.

```ts
{
  ref: string,
  parent_version: number,      // required
  patches?: Array<             // RFC 6902
    | { op: 'add', path, value }
    | { op: 'replace', path, value }
    | { op: 'remove', path }
    | { op: 'move', from, path }
    | { op: 'test', path, value }
  >,
  merge_patch?: Record<string, any>,  // RFC 7396 — alternative to `patches`
  env?: string,
  dry_run?: boolean
}

// Conflict response
{
  error: {
    code: "VERSION_CONFLICT",
    current_version: 47,
    your_parent_version: 45,
    conflicting_paths: ["/fields/price"],
    suggestion: "re-read the entry and re-apply your patches"
  }
}
```

JSON Pointer paths cannot reach inside a Markdown field — Markdown edits are whole-string replacements. Conflicts on Markdown fields bottom out at the field path.

### 9.7 `publish`

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

### 9.8 `validate`

Pure validation without writing.

```ts
// Either:
{ type: string, fields: object, env?: string }
// Or:
{ ref: string, env?: string }

// Response
{ ok: boolean, errors: ValidationError[], warnings: ValidationWarning[] }
```

### 9.9 Entry version tools

```ts
list_versions({ ref, limit?, cursor? })
  → { versions: [{ version, author, created_at, hash, summary }] }

read_version({ ref, version })             → Entry
revert({ ref, to_version, dry_run? })      → { new_version, diff }
diff({ ref, from_version, to_version })    → Diff
```

### 9.10 Schema-mutation tools

Parallel to entry mutations. Every one supports `dry_run: true` and returns the `change_class`.

```ts
create_type({
  name: string,
  description?: string,
  fields: Record<string, FieldDef>,
  summary_fields?: string[],
  identifier_field?: string,
  display_field?: string,
  example?: Record<string, any>,
  dry_run?: boolean
})
  → { type, version: 1, change_class: 'safe' }

alter_type({
  name: string,
  parent_version: number,        // required
  patches?: JsonPatch[],         // RFC 6902 on the type definition
  merge_patch?: Partial<TypeDef>,
  dry_run?: boolean
})
  → { type, version, change_class, diff, affected_entries?: number }

delete_type({ name, dry_run? })          → { type, deleted_at }    // soft
purge_type({ name })                     → { type, purged_at }     // hard; needs schema:destructive

list_types({ include_deleted?: boolean })
list_type_versions({ name, limit?, cursor? })
read_type_version({ name, version })
revert_type({ name, to_version, dry_run? })
diff_type({ name, from_version, to_version })

migrate_entries({
  type: string,
  to_schema_version?: number,    // default: current
  transform?: JsonPatch[],       // optional per-entry rewrite
  filter?: Filter,
  dry_run?: boolean
})
  → { affected: number, failed: Array<{ ref, error }> }
```

`alter_type` classifies the change at mutation time:

- **safe:** add optional field, widen constraint (e.g. raise `max`), update `example` / `summary_fields` / `description`. No existing entry can become invalid.
- **needs_backfill:** add required field with a default, rename a field, narrow a constraint with a transformation path. Valid under the new schema after `migrate_entries` is run.
- **destructive:** remove a field, change a field's type, narrow without migration path, remove a required value source. Requires `schema:destructive` scope.

### 9.11 `subscribe`

```ts
{
  filter: {
    types?: string[],
    refs?: string[],
    events?: ('created'|'updated'|'published'|'deleted'|'reverted'
             |'type_created'|'type_altered'|'type_deleted')[],
    env?: string
  },
  since?: string               // cursor; resume from offset
}

// Stream (SSE)
{ cursor, event: 'published', ref, type, version, timestamp, actor }
```

## 10. Error model

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

`VALIDATION_FAILED`, `VERSION_CONFLICT`, `REFERENCE_NOT_FOUND`, `REFERENCE_TOMBSTONED`, `SLUG_CONFLICT`, `PERMISSION_DENIED`, `SCHEMA_MISMATCH`, `SCHEMA_CHANGE_UNSAFE`, `ENV_NOT_FOUND`, `TOKEN_BUDGET_EXCEEDED`, `NOT_FOUND`, `RATE_LIMITED`, `TYPE_IN_USE`.

## 11. Auth

- Scoped API tokens. Scope axes:
  - **Content:** `content:read`, `content:write`, `content:publish`, `content:destructive` (purge).
  - **Schema:** `schema:read`, `schema:write`, `schema:destructive` (destructive alter, purge_type).
  - **Operations:** `ops:subscribe`, `ops:export`, `ops:tokens`.
  - Per-type and per-field grants compose with the axes above.
- Agent tokens distinct from user tokens (separate audit + rate limits).
- Default agent-editing token for content does **not** carry schema-write — an agent told to "create a new blog article type" will fail without an explicit schema-scoped token, which is the right default.

## 12. Stack & DX

**Runtime / tooling**
- Node 22+ (`better-sqlite3` in v1 for the battle-tested sync API; stable `node:sqlite` is a later option).
- pnpm workspaces. Changesets for publishing.
- Drizzle as the query layer; SQLite and Postgres both first-class through the same adapter.
- Fastify for HTTP.
- `@modelcontextprotocol/sdk` for MCP plumbing (stdio + HTTP+SSE transports).
- `citty` for the CLI.
- `zod` for runtime validation at every boundary (MCP inputs, HTTP bodies, config files).
- `cosmiconfig` for config discovery: `ledric.config.{ts,js,mjs,json,yaml,yml}`, `.ledricrc*`, `ledric` field in `package.json`. TS evaluated via `jiti` / `tsx`.
- `tsup` for builds.

**Proposed package layout**

```
ledric/
├── packages/
│   ├── schema/         # @ledric/schema — defineType, field.*, JSON emit, Zod codegen
│   ├── core/           # Schema engine, versioning, refs, validation, ACL; DB-agnostic
│   ├── storage/        # Drizzle adapter(s); SQLite default, Postgres as second target
│   ├── mcp-server/     # MCP surface binding Core
│   ├── http-server/    # Fastify app binding Core
│   ├── sdk/            # @ledric/sdk — vanilla TS read client
│   └── cli/            # ledric CLI — binds everything; single-binary entry point
├── docs/
│   └── design.md       # this file
└── package.json
```

The PHP SDK is a separate repo when it lands.

**CLI surface (v1)**

- `ledric serve` — start HTTP + MCP.
- `ledric schema push/pull/diff` — sync DB schemas with local `.ts`/`.json`/`.yaml` files.
- `ledric migrate` — apply skeletal SQL migrations.
- `ledric env branch` — stub in v1 (errors with a "branching is v2" message); keeps the verb reserved.
- `ledric refs check` — lint for dangling inline refs.
- `ledric prune` — entry-version GC.
- `ledric import contentful` — Contentful importer.
- `ledric export` — portable JSON dump.

**Dev loop**

- `pnpm dev` — watch build + `ledric serve` against `./ledric.db`.
- `pnpm test` — vitest.
- Seeded sample project under `examples/` for smoke tests.

## 13. Problems this explicitly solves vs Contentful

| Contentful pain | ledric fix |
|---|---|
| Verbose `sys/fields` wrappers eat tokens | Flat entries; metadata under explicit `_meta` only when requested |
| Rich text JSON hard for LLMs to read/write | Markdown + directive syntax; HTML when you need it |
| GraphQL nesting → N+1 and token bloat | Flat DSL + explicit field masks + persisted queries |
| Content model changes only via UI / clunky API | Schema is DB-resident data; `create_type` / `alter_type` MCP tools with safety classes |
| Environments slow to spin up | (Deferred to v2; data model leaves copy-on-write branching open) |
| Generic/slow MCP | Native MCP designed with the data model; HTTP API is the same tool shape |
| Localization duplicates everything | Out of v1 scope (deliberate); slug model plans for per-locale expansion |
| No agent-aware permissions or audit | First-class agent identity; distinct agent tokens, separate scope axes for content vs schema |

## 14. Open questions / next up

1. **Skeletal storage schema (detail)** — concrete DDL, SQLite ↔ Postgres deltas, indexing, GC. **Now in [`docs/storage.md`](./storage.md).**
2. **Runtime schema engine internals** — field-type dispatcher shape, validator composition, where projection (`depth`, `select`, `summary_fields`) lives, how refs are resolved.
3. **Persisted queries** — API shape, lifecycle, invalidation on schema change.
4. **Asset storage backends** — filesystem vs S3-compatible; derivatives generation and caching without server-side image processing becoming a rabbit hole.
5. **Auth provider model** — local tokens only in v1, or OIDC hooks?
6. **Webhook signing / retry policy** — concrete numbers.
7. **Telemetry / query analyzer** — what's in v1 vs later.
8. **Postgres as a second-class target** — when (if) it lands in v1 vs v1.1; minimum deltas in adapter code.

---

*Document status: living spec, v0.2. Revised after each design session.*
