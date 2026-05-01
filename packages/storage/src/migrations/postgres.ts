import type { Migration } from './types.js';

// Consolidated initial schema for Postgres. BLOB → BYTEA, no STRICT,
// integer timestamps stored as BIGINT (millis since epoch). CHECK
// constraints work as-is.

export const postgresMigrations: Migration[] = [
  {
    id: 1,
    name: '0001_init',
    sql: `
      CREATE TABLE envs (
        id         BYTEA  PRIMARY KEY,
        name       TEXT   NOT NULL UNIQUE,
        parent_id  BYTEA  REFERENCES envs(id),
        created_at BIGINT NOT NULL
      );

      CREATE TABLE types (
        id                BYTEA  PRIMARY KEY,
        env_id            BYTEA  NOT NULL REFERENCES envs(id),
        name              TEXT   NOT NULL,
        current_version   INTEGER NOT NULL,
        published_version INTEGER,
        deleted_at        BIGINT,
        UNIQUE (env_id, name)
      );

      CREATE INDEX idx_types_env_deleted ON types (env_id, deleted_at);

      CREATE TABLE type_versions (
        type_id        BYTEA   NOT NULL REFERENCES types(id),
        version        INTEGER NOT NULL,
        definition     TEXT    NOT NULL,
        change_class   TEXT    NOT NULL CHECK (change_class IN ('safe','needs_backfill','destructive')),
        parent_version INTEGER,
        author         TEXT,
        created_at     BIGINT  NOT NULL,
        PRIMARY KEY (type_id, version)
      );

      CREATE INDEX idx_type_versions_created ON type_versions (created_at);

      CREATE TABLE entries (
        id                BYTEA   PRIMARY KEY,
        env_id            BYTEA   NOT NULL REFERENCES envs(id),
        type_id           BYTEA   NOT NULL REFERENCES types(id),
        slug              TEXT    NOT NULL,
        current_version   INTEGER NOT NULL,
        published_version INTEGER,
        deleted_at        BIGINT,
        UNIQUE (env_id, type_id, slug)
      );

      CREATE INDEX idx_entries_env_type_deleted ON entries (env_id, type_id, deleted_at);
      CREATE INDEX idx_entries_published
        ON entries (env_id, type_id, published_version)
        WHERE published_version IS NOT NULL AND deleted_at IS NULL;

      CREATE TABLE entry_versions (
        entry_id       BYTEA   NOT NULL REFERENCES entries(id),
        version        INTEGER NOT NULL,
        content        TEXT    NOT NULL,
        schema_version INTEGER NOT NULL,
        content_hash   BYTEA   NOT NULL,
        parent_version INTEGER,
        author         TEXT,
        created_at     BIGINT  NOT NULL,
        PRIMARY KEY (entry_id, version)
      );

      CREATE INDEX idx_entry_versions_hash    ON entry_versions (content_hash);
      CREATE INDEX idx_entry_versions_created ON entry_versions (created_at);

      CREATE TABLE slug_history (
        env_id     BYTEA  NOT NULL REFERENCES envs(id),
        slug       TEXT   NOT NULL,
        type_id    BYTEA  NOT NULL REFERENCES types(id),
        entry_id   BYTEA  NOT NULL REFERENCES entries(id),
        retired_at BIGINT NOT NULL,
        locale     TEXT,
        PRIMARY KEY (env_id, slug, retired_at)
      );

      CREATE INDEX idx_slug_history_entry ON slug_history (entry_id);
      CREATE INDEX idx_slug_history_type  ON slug_history (env_id, type_id);

      CREATE TABLE entries_slugs (
        env_id   BYTEA NOT NULL REFERENCES envs(id),
        type_id  BYTEA NOT NULL REFERENCES types(id),
        locale   TEXT  NOT NULL,
        slug     TEXT  NOT NULL,
        entry_id BYTEA NOT NULL REFERENCES entries(id),
        PRIMARY KEY (env_id, type_id, locale, slug)
      );

      CREATE INDEX idx_entries_slugs_entry ON entries_slugs (entry_id);

      CREATE TABLE assets (
        id                BYTEA   PRIMARY KEY,
        env_id            BYTEA   NOT NULL REFERENCES envs(id),
        kind              TEXT    NOT NULL,
        current_version   INTEGER NOT NULL,
        published_version INTEGER,
        deleted_at        BIGINT
      );

      CREATE INDEX idx_assets_env_kind ON assets (env_id, kind, deleted_at);

      CREATE TABLE asset_versions (
        asset_id       BYTEA   NOT NULL REFERENCES assets(id),
        version        INTEGER NOT NULL,
        storage_ref    TEXT    NOT NULL,
        meta           TEXT    NOT NULL,
        parent_version INTEGER,
        author         TEXT,
        created_at     BIGINT  NOT NULL,
        ref_key        BYTEA   NOT NULL,
        PRIMARY KEY (asset_id, version)
      );

      CREATE INDEX idx_asset_versions_created ON asset_versions (created_at);
      CREATE UNIQUE INDEX idx_asset_versions_ref_key ON asset_versions (ref_key);

      CREATE TABLE asset_blobs (
        asset_id BYTEA   NOT NULL,
        version  INTEGER NOT NULL,
        bytes    BYTEA   NOT NULL,
        PRIMARY KEY (asset_id, version)
      );

      CREATE TABLE api_keys (
        id           BYTEA   PRIMARY KEY,
        env_id       BYTEA   NOT NULL REFERENCES envs(id),
        role         TEXT    NOT NULL CHECK (role IN ('admin','reader')),
        label        TEXT,
        key_hash     BYTEA   NOT NULL UNIQUE,
        key_prefix   TEXT    NOT NULL,
        created_at   BIGINT  NOT NULL,
        last_used_at BIGINT,
        revoked_at   BIGINT
      );

      CREATE INDEX idx_api_keys_env_role ON api_keys (env_id, role);
      CREATE INDEX idx_api_keys_hash ON api_keys (key_hash);

      CREATE TABLE tags (
        id          BYTEA  PRIMARY KEY,
        env_id      BYTEA  NOT NULL REFERENCES envs(id),
        slug        TEXT   NOT NULL,
        label       TEXT   NOT NULL,
        created_at  BIGINT NOT NULL,
        UNIQUE (env_id, slug)
      );

      CREATE TABLE asset_tags (
        env_id    BYTEA NOT NULL REFERENCES envs(id),
        asset_id  BYTEA NOT NULL REFERENCES assets(id),
        tag_id    BYTEA NOT NULL REFERENCES tags(id),
        PRIMARY KEY (env_id, asset_id, tag_id)
      );

      CREATE INDEX idx_asset_tags_tag ON asset_tags (env_id, tag_id);

      CREATE TABLE entry_tags (
        env_id    BYTEA NOT NULL REFERENCES envs(id),
        entry_id  BYTEA NOT NULL REFERENCES entries(id),
        tag_id    BYTEA NOT NULL REFERENCES tags(id),
        PRIMARY KEY (env_id, entry_id, tag_id)
      );

      CREATE INDEX idx_entry_tags_tag ON entry_tags (env_id, tag_id);
    `
  }
];
