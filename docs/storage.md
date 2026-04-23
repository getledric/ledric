# ledric — Storage Schema

Companion to `design.md` §8. Where §8.1 listed the shape of the skeletal tables ("what's there and why"), this doc is the concrete DDL ("what it looks like in SQL"), the SQLite ↔ Postgres deltas, the index strategy, and the GC model.

Scope for v1:
- SQLite (via `better-sqlite3`) is the primary target and the DDL examples here are SQLite-flavored.
- Postgres is a second target that ships on the same Drizzle adapter pattern; deltas are listed per-table.
- Content-schema changes (what's *inside* `content`) are **not** SQL migrations — they are rows in `type_versions`. This doc only covers the skeletal schema.

## 1. Conventions

- **IDs** are UUIDv7. Stored as `BLOB` (16 bytes) in SQLite, `BYTEA` in Postgres. We never store UUIDs as text — wastes space and kills btree locality.
- **Timestamps** are unix epoch milliseconds as `INTEGER` / `BIGINT`. Identical app-level code across dialects; timezone is always UTC at the boundary.
- **JSON** is `TEXT` in SQLite (parsed via `json_extract` / `json_patch`) and `JSONB` in Postgres (native operators, GIN indexing).
- **Content hashes** are sha256 stored as `BLOB` / `BYTEA` (32 bytes).
- **Monotonic counters** (entry/type `version`) are plain `INTEGER` / `BIGINT`, allocated inside a write transaction via `MAX(version)+1` against the history table. No `AUTOINCREMENT` — we need per-entry monotonicity, not per-table.
- **Foreign keys** are declared but not enforced in SQLite unless `PRAGMA foreign_keys = ON` is set at connection time. The engine does this on every connection.
- **SQLite `STRICT` tables** everywhere. Type affinity without STRICT has bitten too many people.

## 2. Tables (SQLite DDL)

### 2.1 `envs`

The environment table exists on day one even though v1 only uses one env. Bootstrap writes a single row named `main`.

```sql
CREATE TABLE envs (
  id         BLOB    PRIMARY KEY,
  name       TEXT    NOT NULL UNIQUE,
  parent_id  BLOB    REFERENCES envs(id),      -- reserved for branching
  created_at INTEGER NOT NULL
) STRICT;
```

**Postgres delta:** `BLOB → BYTEA`, `INTEGER → BIGINT`. No `STRICT` clause.

### 2.2 `types` and `type_versions`

`types` is the pointer row per content type. `type_versions` is append-only history.

```sql
CREATE TABLE types (
  id                BLOB    PRIMARY KEY,
  env_id            BLOB    NOT NULL REFERENCES envs(id),
  name              TEXT    NOT NULL,
  current_version   INTEGER NOT NULL,
  published_version INTEGER,
  deleted_at        INTEGER,
  UNIQUE (env_id, name)
) STRICT;

CREATE INDEX idx_types_env_deleted ON types (env_id, deleted_at);

CREATE TABLE type_versions (
  type_id        BLOB    NOT NULL REFERENCES types(id),
  version        INTEGER NOT NULL,
  definition     TEXT    NOT NULL,                  -- JSON: TypeDef
  change_class   TEXT    NOT NULL CHECK (change_class IN ('safe','needs_backfill','destructive')),
  parent_version INTEGER,
  author         TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (type_id, version)
) STRICT;

CREATE INDEX idx_type_versions_created ON type_versions (created_at);
```

**Postgres delta:** `TEXT → JSONB` for `definition`. Same structure otherwise.

### 2.3 `entries` and `entry_versions`

```sql
CREATE TABLE entries (
  id                BLOB    PRIMARY KEY,
  env_id            BLOB    NOT NULL REFERENCES envs(id),
  type_id           BLOB    NOT NULL REFERENCES types(id),
  slug              TEXT    NOT NULL,
  current_version   INTEGER NOT NULL,
  published_version INTEGER,
  deleted_at        INTEGER,
  UNIQUE (env_id, type_id, slug)                     -- per-env, per-type slug uniqueness
) STRICT;

CREATE INDEX idx_entries_env_type_deleted ON entries (env_id, type_id, deleted_at);
CREATE INDEX idx_entries_published        ON entries (env_id, type_id, published_version)
  WHERE published_version IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE entry_versions (
  entry_id       BLOB    NOT NULL REFERENCES entries(id),
  version        INTEGER NOT NULL,
  content        TEXT    NOT NULL,                  -- JSON: per-type field dict
  schema_version INTEGER NOT NULL,                  -- types.current_version at write time
  content_hash   BLOB    NOT NULL,                  -- sha256 of canonical content
  parent_version INTEGER,
  author         TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (entry_id, version)
) STRICT;

CREATE INDEX idx_entry_versions_hash    ON entry_versions (content_hash);
CREATE INDEX idx_entry_versions_created ON entry_versions (created_at);
```

**Postgres delta:** `content TEXT → JSONB`, plus an optional GIN on `content` if full-body matching becomes a common pattern (default off — declared-index fields cover the hot path). `content_hash` stays `BYTEA`.

**Read path for "current content":** `entries JOIN entry_versions ON entries.id = entry_versions.entry_id AND entries.current_version = entry_versions.version`. Cheap because `entry_versions` PK is `(entry_id, version)` and the join hits it directly.

**Published reads:** identical shape but filtered by `published_version = version`; the partial index above is the covering index for "list of published entries of type X".

### 2.4 `slug_history`

```sql
CREATE TABLE slug_history (
  env_id     BLOB    NOT NULL REFERENCES envs(id),
  slug       TEXT    NOT NULL,
  type_id    BLOB    NOT NULL REFERENCES types(id),
  entry_id   BLOB    NOT NULL REFERENCES entries(id),
  retired_at INTEGER NOT NULL,
  PRIMARY KEY (env_id, slug, retired_at)
) STRICT;

CREATE INDEX idx_slug_history_entry ON slug_history (entry_id);
CREATE INDEX idx_slug_history_type  ON slug_history (env_id, type_id);
```

The PK includes `retired_at` because the same slug can be retired multiple times over a row's lifetime (rename → rename back → rename again). Lookup for redirects is `WHERE env_id = ? AND slug = ? ORDER BY retired_at DESC LIMIT 1`.

### 2.5 `assets` and `asset_versions`

```sql
CREATE TABLE assets (
  id                BLOB    PRIMARY KEY,
  env_id            BLOB    NOT NULL REFERENCES envs(id),
  kind              TEXT    NOT NULL,                 -- 'image' | 'video' | 'file' | ...
  storage_ref       TEXT    NOT NULL,                 -- filesystem path | s3 uri | ...
  current_version   INTEGER NOT NULL,
  published_version INTEGER,
  deleted_at        INTEGER
) STRICT;

CREATE INDEX idx_assets_env_kind ON assets (env_id, kind, deleted_at);

CREATE TABLE asset_versions (
  asset_id       BLOB    NOT NULL REFERENCES assets(id),
  version        INTEGER NOT NULL,
  meta           TEXT    NOT NULL,                   -- JSON: dims, mime, size, alt, ...
  parent_version INTEGER,
  author         TEXT,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (asset_id, version)
) STRICT;
```

### 2.6 `refs_out`

Materialized structural-reference index, rebuilt on every entry write (inside the same transaction).

```sql
CREATE TABLE refs_out (
  from_entry     BLOB    NOT NULL REFERENCES entries(id),
  from_version   INTEGER NOT NULL,
  from_field     TEXT    NOT NULL,
  to_entry       BLOB    NOT NULL REFERENCES entries(id),
  to_version_pin INTEGER,                             -- NULL = auto (current/published)
  PRIMARY KEY (from_entry, from_version, from_field, to_entry)
) STRICT;

CREATE INDEX idx_refs_out_to ON refs_out (to_entry);   -- powers "who references X"
```

Only **structural** references (schema-typed `references` fields) populate this table. Inline `:::ref{}` directives inside Markdown are NOT indexed here — they're resolved at render time and lint-checked by `ledric refs check`.

### 2.7 `subscriptions`

```sql
CREATE TABLE subscriptions (
  id                BLOB    PRIMARY KEY,
  env_id            BLOB    NOT NULL REFERENCES envs(id),
  kind              TEXT    NOT NULL CHECK (kind IN ('webhook','sse')),
  target            TEXT    NOT NULL,                 -- URL for webhook; session id for SSE
  filter            TEXT    NOT NULL,                 -- JSON: { types, refs, events }
  cursor            TEXT,                             -- last delivered event id
  secret            BLOB,                             -- HMAC secret for webhooks
  created_at        INTEGER NOT NULL,
  last_delivered_at INTEGER,
  disabled_at       INTEGER
) STRICT;

CREATE INDEX idx_subscriptions_env_kind ON subscriptions (env_id, kind, disabled_at);
```

### 2.8 `tokens`

```sql
CREATE TABLE tokens (
  id             BLOB    PRIMARY KEY,
  name           TEXT    NOT NULL,
  hash           BLOB    NOT NULL UNIQUE,             -- argon2id(token) or similar
  scopes         TEXT    NOT NULL,                    -- JSON array of scope strings
  kind           TEXT    NOT NULL CHECK (kind IN ('user','agent')),
  default_env_id BLOB    REFERENCES envs(id),
  expires_at     INTEGER,
  created_at     INTEGER NOT NULL,
  last_used_at   INTEGER,
  revoked_at     INTEGER
) STRICT;
```

Tokens are never stored in plaintext; only `hash` is persisted. Verification hashes the presented token and looks it up via the unique index.

### 2.9 `events` (append-only change feed)

Not in §8.1 but needed to back `subscribe` and webhooks. Decoupling this from in-memory broadcast makes resume-from-cursor correct across restarts.

```sql
CREATE TABLE events (
  id         INTEGER PRIMARY KEY,                     -- autoincrement, doubles as cursor
  env_id     BLOB    NOT NULL REFERENCES envs(id),
  kind       TEXT    NOT NULL,                        -- 'entry.created' | 'entry.published' | 'type.altered' | ...
  ref_type   TEXT,                                    -- type name for entry events
  ref_id     BLOB,                                    -- entry/type id
  version    INTEGER,
  payload    TEXT    NOT NULL,                        -- JSON
  created_at INTEGER NOT NULL
) STRICT;

CREATE INDEX idx_events_env_created ON events (env_id, created_at);
```

SSE consumers pass `since=<id>` and the server streams rows with `id > since`, then tails live inserts via the in-process bus (SQLite) or `LISTEN/NOTIFY` (Postgres). Webhooks retry from the last cursor they acked.

**Retention:** keep 30 days by default, configurable; GC'd in the same pass as tombstones (§4).

## 3. Indexing content fields

The storage layer is type-agnostic. But a type can declare fields as `indexed: true` in its `TypeDef`, and the schema engine materializes per-type indexes on `entry_versions.content` when the type version lands.

### 3.1 SQLite

Per-type expression index:

```sql
-- e.g. for type `product`, field `price`:
CREATE INDEX idx_entry_versions_product_price
  ON entry_versions (
    json_extract(content, '$.price')
  )
  WHERE entry_id IN (SELECT id FROM entries WHERE type_id = <product-id>);
```

Partial indexes on a subquery aren't allowed in SQLite, so the `WHERE` is rewritten to a concrete value. Because `type_id` on `entries` is immutable, a better formulation is to embed the type discriminator into the index predicate via a join-less check. v1 keeps it simple: full expression index, no partial clause — the optimizer still narrows via `entries.type_id` at query time:

```sql
CREATE INDEX idx_entry_versions_product_price
  ON entry_versions (json_extract(content, '$.price'));
```

This over-indexes (includes non-product rows) but is correct. The "current-only" filter falls out of the `entries JOIN entry_versions` pattern above.

**FTS:** one `fts5` virtual table per configured-for-text type, or one global. v1 default is per-type:

```sql
CREATE VIRTUAL TABLE fts_product USING fts5(
  entry_id UNINDEXED,
  version  UNINDEXED,
  title, body,
  content='',               -- contentless FTS; we populate via trigger
  tokenize='porter'
);
```

Triggers on `entry_versions` insert/update keep the FTS table in sync; on `entries.deleted_at IS NOT NULL`, the trigger removes rows.

**Vectors:** `sqlite-vec` extension, one `vec0` virtual table per `vector`-typed field:

```sql
CREATE VIRTUAL TABLE vec_product_embedding USING vec0(
  entry_id BLOB PRIMARY KEY,
  embedding FLOAT[1536]
);
```

### 3.2 Postgres

JSONB-native indexes on `entry_versions`:

```sql
CREATE INDEX idx_entry_versions_product_price
  ON entry_versions ((content->>'price'))
  WHERE (content->>'price') IS NOT NULL;
```

For range queries cast appropriately: `((content->>'price')::numeric)`.

**FTS:** generated `tsvector` column on `entry_versions`, GIN-indexed:

```sql
ALTER TABLE entry_versions
  ADD COLUMN ts tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      coalesce(content->>'title','') || ' ' ||
      coalesce(content->>'body','')
    )
  ) STORED;

CREATE INDEX idx_entry_versions_ts ON entry_versions USING GIN (ts);
```

The engine rewrites the generated-column expression when a type's searchable fields change (`ALTER TABLE ... DROP COLUMN ts; ADD COLUMN ts ...`). Expensive but rare.

**Vectors:** `pgvector`, one column per `vector` field on a per-type sibling table `vec_<type>` keyed by `entry_id`:

```sql
CREATE TABLE vec_product (
  entry_id BYTEA PRIMARY KEY REFERENCES entries(id),
  embedding vector(1536)
);

CREATE INDEX idx_vec_product_embedding
  ON vec_product USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
```

## 4. Garbage collection

### 4.1 Tombstones (soft-delete retention)

Runs every hour by default; configurable via `ledric.config`. Per-type retention window (default 90 days).

Pseudocode:

```sql
-- For each type:
DELETE FROM entry_versions
 WHERE entry_id IN (
   SELECT id FROM entries
    WHERE type_id = ? AND deleted_at < now_ms() - retention_ms
 );

DELETE FROM entries
 WHERE type_id = ? AND deleted_at < now_ms() - retention_ms;

-- slug_history kept 30 days longer than entries, to preserve redirects
DELETE FROM slug_history
 WHERE retired_at < now_ms() - (retention_ms + 30d_ms);
```

`refs_out` is FK-cascaded (or cleaned in the same transaction — SQLite's FK behavior varies by compile flags).

### 4.2 Version history (optional, opt-in)

`ledric prune` CLI — never automatic.

Knobs (config or CLI flags):

```jsonc
{
  "prune": {
    "keep_last_n":  50,          // per entry
    "keep_since":  "30d",         // keep all versions newer than this
    "keep_published": true,       // never prune the currently-published version
    "dry_run":      false
  }
}
```

Dry-run prints the affected row count without deleting.

### 4.3 Events / change feed

Hard cap in rows, soft cap in days. v1 defaults: keep 30 days or 1M rows, whichever is smaller (per env). Same hourly pass as tombstones.

## 5. Migrations

Two things migrate; don't conflate them.

### 5.1 Skeletal schema migrations

Generated via Drizzle's migrator plus hand-written SQL for FTS / vector extension setup. One file per dialect, checked into `packages/storage/migrations/{sqlite,postgres}/`. Applied with `ledric migrate`.

Format: plain numbered SQL files (`0001_init.sql`, `0002_events.sql`, ...). Drizzle's journal file tracks applied versions in the DB.

### 5.2 Content-schema migrations

Not SQL. Rows inserted into `type_versions` via `alter_type` / `create_type` MCP tools or CLI `schema push`. Entries are backfilled by `migrate_entries` when needed (§9.10 in design.md). No DDL is emitted for these beyond per-field indexes on `content`.

## 6. Transactions

The standard write path (draft / patch / publish) is a single transaction:

1. Read current pointer + current version from `entries` / `entry_versions`.
2. Optimistic-concurrency check: `parent_version == entries.current_version`.
3. Insert new `entry_versions` row.
4. Update `entries.current_version` (and, on publish, `published_version`).
5. Upsert `refs_out` for the new version (delete old, insert new).
6. Write `events` row.
7. Commit.

Steps 1–4 are one transaction; 5–7 run in the same transaction to avoid observers seeing a published version before its refs/event are materialized.

SQLite: single writer via WAL mode (`journal_mode = WAL`, `synchronous = NORMAL`). Postgres: default isolation (`READ COMMITTED`) is sufficient because the PK/UNIQUE constraints do the work; a retry on `serialization_failure` covers the edge case.

## 7. Capabilities table

Runtime capability probing (surfaced to `describe_model.capabilities`):

| Capability       | SQLite detection                               | Postgres detection                   |
|------------------|------------------------------------------------|--------------------------------------|
| `vectorSearch`   | `sqlite-vec` extension load succeeded         | `SELECT 1 FROM pg_extension WHERE extname='vector'` |
| `nativePubSub`   | always `false`                                 | always `true` (LISTEN/NOTIFY)        |
| `fts`            | `'fts5'`                                       | `'tsvector'`                         |

Detection runs at startup and is cached for the process lifetime.

## 8. Non-goals for v1

- **Sharding / multi-writer.** Single-writer per env; scale-out is v2 (and likely means Postgres-only on that axis).
- **Row-level security.** Scopes are enforced in Core, not in the DB. Adding Postgres RLS later is a drop-in hardening pass.
- **Time-travel read on a whole env.** You can read a specific entry `as_of` a version or time, but not "the whole env as of T" — that's a branching feature (v2).
- **Automatic schema-migration of existing content on destructive changes.** `migrate_entries` is explicit.
- **Audit log beyond `events` + `author`.** Full actor/trace audit is its own layer, layered on top of `events` when needed.
