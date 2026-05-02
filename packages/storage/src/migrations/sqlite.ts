import type { Migration } from './types.js';

// Consolidated initial schema for SQLite. Replaces the previous
// 7-migration history (the package never shipped to production, so the
// history was rolled into one). All future migrations append to this
// list as new entries.

export const sqliteMigrations: Migration[] = [
  {
    id: 1,
    name: '0001_init',
    sql: `
      CREATE TABLE envs (
        id         BLOB    PRIMARY KEY,
        name       TEXT    NOT NULL UNIQUE,
        parent_id  BLOB    REFERENCES envs(id),
        created_at INTEGER NOT NULL
      ) STRICT;

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
        definition     TEXT    NOT NULL,
        change_class   TEXT    NOT NULL CHECK (change_class IN ('safe','needs_backfill','destructive')),
        parent_version INTEGER,
        author         TEXT,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (type_id, version)
      ) STRICT;

      CREATE INDEX idx_type_versions_created ON type_versions (created_at);

      CREATE TABLE entries (
        id                BLOB    PRIMARY KEY,
        env_id            BLOB    NOT NULL REFERENCES envs(id),
        type_id           BLOB    NOT NULL REFERENCES types(id),
        slug              TEXT    NOT NULL,
        current_version   INTEGER NOT NULL,
        published_version INTEGER,
        deleted_at        INTEGER,
        UNIQUE (env_id, type_id, slug)
      ) STRICT;

      CREATE INDEX idx_entries_env_type_deleted ON entries (env_id, type_id, deleted_at);
      CREATE INDEX idx_entries_published
        ON entries (env_id, type_id, published_version)
        WHERE published_version IS NOT NULL AND deleted_at IS NULL;

      CREATE TABLE entry_versions (
        entry_id       BLOB    NOT NULL REFERENCES entries(id),
        version        INTEGER NOT NULL,
        content        TEXT    NOT NULL,
        schema_version INTEGER NOT NULL,
        content_hash   BLOB    NOT NULL,
        parent_version INTEGER,
        author         TEXT,
        created_at     INTEGER NOT NULL,
        PRIMARY KEY (entry_id, version)
      ) STRICT;

      CREATE INDEX idx_entry_versions_hash    ON entry_versions (content_hash);
      CREATE INDEX idx_entry_versions_created ON entry_versions (created_at);

      CREATE TABLE slug_history (
        env_id     BLOB    NOT NULL REFERENCES envs(id),
        slug       TEXT    NOT NULL,
        type_id    BLOB    NOT NULL REFERENCES types(id),
        entry_id   BLOB    NOT NULL REFERENCES entries(id),
        retired_at INTEGER NOT NULL,
        locale     TEXT,
        PRIMARY KEY (env_id, slug, retired_at)
      ) STRICT;

      CREATE INDEX idx_slug_history_entry ON slug_history (entry_id);
      CREATE INDEX idx_slug_history_type  ON slug_history (env_id, type_id);

      CREATE TABLE entries_slugs (
        env_id   BLOB    NOT NULL REFERENCES envs(id),
        type_id  BLOB    NOT NULL REFERENCES types(id),
        locale   TEXT    NOT NULL,
        slug     TEXT    NOT NULL,
        entry_id BLOB    NOT NULL REFERENCES entries(id),
        PRIMARY KEY (env_id, type_id, locale, slug)
      ) STRICT;

      CREATE INDEX idx_entries_slugs_entry ON entries_slugs (entry_id);

      CREATE TABLE assets (
        id                BLOB    PRIMARY KEY,
        env_id            BLOB    NOT NULL REFERENCES envs(id),
        kind              TEXT    NOT NULL,
        current_version   INTEGER NOT NULL,
        published_version INTEGER,
        deleted_at        INTEGER
      ) STRICT;

      CREATE INDEX idx_assets_env_kind ON assets (env_id, kind, deleted_at);

      CREATE TABLE asset_versions (
        asset_id       BLOB    NOT NULL REFERENCES assets(id),
        version        INTEGER NOT NULL,
        storage_ref    TEXT    NOT NULL,
        meta           TEXT    NOT NULL,
        parent_version INTEGER,
        author         TEXT,
        created_at     INTEGER NOT NULL,
        ref_key        BLOB    NOT NULL,
        PRIMARY KEY (asset_id, version)
      ) STRICT;

      CREATE INDEX idx_asset_versions_created ON asset_versions (created_at);
      CREATE UNIQUE INDEX idx_asset_versions_ref_key ON asset_versions (ref_key);

      CREATE TABLE asset_blobs (
        asset_id BLOB    NOT NULL,
        version  INTEGER NOT NULL,
        bytes    BLOB    NOT NULL,
        PRIMARY KEY (asset_id, version)
      ) STRICT;

      CREATE TABLE api_keys (
        id           BLOB    PRIMARY KEY,
        env_id       BLOB    NOT NULL REFERENCES envs(id),
        role         TEXT    NOT NULL CHECK (role IN ('admin','reader')),
        label        TEXT,
        key_hash     BLOB    NOT NULL UNIQUE,
        key_prefix   TEXT    NOT NULL,
        created_at   INTEGER NOT NULL,
        last_used_at INTEGER,
        revoked_at   INTEGER
      ) STRICT;

      CREATE INDEX idx_api_keys_env_role ON api_keys (env_id, role);
      CREATE INDEX idx_api_keys_hash ON api_keys (key_hash);

      CREATE TABLE tags (
        id          BLOB    PRIMARY KEY,
        env_id      BLOB    NOT NULL REFERENCES envs(id),
        slug        TEXT    NOT NULL,
        label       TEXT    NOT NULL,
        created_at  INTEGER NOT NULL,
        UNIQUE (env_id, slug)
      ) STRICT;

      CREATE TABLE asset_tags (
        env_id    BLOB NOT NULL REFERENCES envs(id),
        asset_id  BLOB NOT NULL REFERENCES assets(id),
        tag_id    BLOB NOT NULL REFERENCES tags(id),
        PRIMARY KEY (env_id, asset_id, tag_id)
      ) STRICT;

      CREATE INDEX idx_asset_tags_tag ON asset_tags (env_id, tag_id);

      CREATE TABLE entry_tags (
        env_id    BLOB NOT NULL REFERENCES envs(id),
        entry_id  BLOB NOT NULL REFERENCES entries(id),
        tag_id    BLOB NOT NULL REFERENCES tags(id),
        PRIMARY KEY (env_id, entry_id, tag_id)
      ) STRICT;

      CREATE INDEX idx_entry_tags_tag ON entry_tags (env_id, tag_id);
    `
  },
  {
    id: 2,
    name: '0002_fts',
    sql: `
      -- Full-text search index. One row per (entry, searchable field, locale).
      -- locale is the empty string '' for non-localized fields and the
      -- default-locale row of localized fields; for additional locales of
      -- a localized field, we insert extra rows with the locale tag set.
      -- '' as sentinel keeps the same shape across SQLite / Postgres /
      -- MySQL, where Postgres won't allow NULL in a primary key.
      --
      -- entry_id / type / field_name / locale are UNINDEXED metadata —
      -- FTS5 only tokenises 'value'. Querying back to entries goes
      -- through entry_id.
      CREATE VIRTUAL TABLE fts_entries USING fts5(
        entry_id UNINDEXED,
        type UNINDEXED,
        field_name UNINDEXED,
        locale UNINDEXED,
        value,
        tokenize = 'porter unicode61 remove_diacritics 2'
      );
    `
  }
];
