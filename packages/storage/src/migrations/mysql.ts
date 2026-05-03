import type { Migration } from './types.js';

// Consolidated initial schema for MySQL 8+. BLOB → VARBINARY(16) for ids
// (so they're indexable as primary keys), MEDIUMBLOB for content_hash
// and ref_key, LONGBLOB for asset bytes. Integer timestamps stored as
// BIGINT (millis since epoch).
//
// MySQL doesn't support partial indexes, so the entries_published index
// is unconditional — slightly larger but functionally equivalent.

export const mysqlMigrations: Migration[] = [
  {
    id: 1,
    name: '0001_init',
    sql: `
      CREATE TABLE envs (
        id         VARBINARY(16) PRIMARY KEY,
        name       VARCHAR(128)  NOT NULL UNIQUE,
        parent_id  VARBINARY(16),
        created_at BIGINT        NOT NULL,
        FOREIGN KEY (parent_id) REFERENCES envs(id)
      );

      CREATE TABLE types (
        id                VARBINARY(16) PRIMARY KEY,
        env_id            VARBINARY(16) NOT NULL,
        name              VARCHAR(255)  NOT NULL,
        current_version   INT           NOT NULL,
        published_version INT,
        deleted_at        BIGINT,
        UNIQUE (env_id, name),
        FOREIGN KEY (env_id) REFERENCES envs(id),
        INDEX idx_types_env_deleted (env_id, deleted_at)
      );

      CREATE TABLE type_versions (
        type_id        VARBINARY(16) NOT NULL,
        version        INT           NOT NULL,
        definition     LONGTEXT      NOT NULL,
        change_class   VARCHAR(32)   NOT NULL,
        parent_version INT,
        author         VARCHAR(255),
        created_at     BIGINT        NOT NULL,
        PRIMARY KEY (type_id, version),
        FOREIGN KEY (type_id) REFERENCES types(id),
        CHECK (change_class IN ('safe','needs_backfill','destructive')),
        INDEX idx_type_versions_created (created_at)
      );

      CREATE TABLE entries (
        id                VARBINARY(16) PRIMARY KEY,
        env_id            VARBINARY(16) NOT NULL,
        type_id           VARBINARY(16) NOT NULL,
        slug              VARCHAR(255)  NOT NULL,
        current_version   INT           NOT NULL,
        published_version INT,
        deleted_at        BIGINT,
        UNIQUE (env_id, type_id, slug),
        FOREIGN KEY (env_id) REFERENCES envs(id),
        FOREIGN KEY (type_id) REFERENCES types(id),
        INDEX idx_entries_env_type_deleted (env_id, type_id, deleted_at),
        INDEX idx_entries_published (env_id, type_id, published_version)
      );

      CREATE TABLE entry_versions (
        entry_id       VARBINARY(16) NOT NULL,
        version        INT           NOT NULL,
        content        LONGTEXT      NOT NULL,
        schema_version INT           NOT NULL,
        content_hash   VARBINARY(64) NOT NULL,
        parent_version INT,
        author         VARCHAR(255),
        created_at     BIGINT        NOT NULL,
        PRIMARY KEY (entry_id, version),
        FOREIGN KEY (entry_id) REFERENCES entries(id),
        INDEX idx_entry_versions_hash (content_hash),
        INDEX idx_entry_versions_created (created_at)
      );

      CREATE TABLE slug_history (
        env_id     VARBINARY(16) NOT NULL,
        slug       VARCHAR(255)  NOT NULL,
        type_id    VARBINARY(16) NOT NULL,
        entry_id   VARBINARY(16) NOT NULL,
        retired_at BIGINT        NOT NULL,
        locale     VARCHAR(32),
        PRIMARY KEY (env_id, slug, retired_at),
        FOREIGN KEY (env_id) REFERENCES envs(id),
        FOREIGN KEY (type_id) REFERENCES types(id),
        FOREIGN KEY (entry_id) REFERENCES entries(id),
        INDEX idx_slug_history_entry (entry_id),
        INDEX idx_slug_history_type (env_id, type_id)
      );

      CREATE TABLE entries_slugs (
        env_id   VARBINARY(16) NOT NULL,
        type_id  VARBINARY(16) NOT NULL,
        locale   VARCHAR(32)   NOT NULL,
        slug     VARCHAR(255)  NOT NULL,
        entry_id VARBINARY(16) NOT NULL,
        PRIMARY KEY (env_id, type_id, locale, slug),
        FOREIGN KEY (env_id) REFERENCES envs(id),
        FOREIGN KEY (type_id) REFERENCES types(id),
        FOREIGN KEY (entry_id) REFERENCES entries(id),
        INDEX idx_entries_slugs_entry (entry_id)
      );

      CREATE TABLE assets (
        id                VARBINARY(16) PRIMARY KEY,
        env_id            VARBINARY(16) NOT NULL,
        kind              VARCHAR(64)   NOT NULL,
        current_version   INT           NOT NULL,
        published_version INT,
        deleted_at        BIGINT,
        FOREIGN KEY (env_id) REFERENCES envs(id),
        INDEX idx_assets_env_kind (env_id, kind, deleted_at)
      );

      CREATE TABLE asset_versions (
        asset_id       VARBINARY(16) NOT NULL,
        version        INT           NOT NULL,
        storage_ref    VARCHAR(512)  NOT NULL,
        meta           LONGTEXT      NOT NULL,
        parent_version INT,
        author         VARCHAR(255),
        created_at     BIGINT        NOT NULL,
        ref_key        VARBINARY(16) NOT NULL,
        PRIMARY KEY (asset_id, version),
        FOREIGN KEY (asset_id) REFERENCES assets(id),
        INDEX idx_asset_versions_created (created_at),
        UNIQUE INDEX idx_asset_versions_ref_key (ref_key)
      );

      CREATE TABLE asset_blobs (
        asset_id VARBINARY(16) NOT NULL,
        version  INT           NOT NULL,
        bytes    LONGBLOB      NOT NULL,
        PRIMARY KEY (asset_id, version)
      );

      CREATE TABLE api_keys (
        id           VARBINARY(16) PRIMARY KEY,
        env_id       VARBINARY(16) NOT NULL,
        role         VARCHAR(16)   NOT NULL,
        label        VARCHAR(255),
        key_hash     VARBINARY(64) NOT NULL UNIQUE,
        key_prefix   VARCHAR(16)   NOT NULL,
        created_at   BIGINT        NOT NULL,
        last_used_at BIGINT,
        revoked_at   BIGINT,
        FOREIGN KEY (env_id) REFERENCES envs(id),
        CHECK (role IN ('admin','reader')),
        INDEX idx_api_keys_env_role (env_id, role),
        INDEX idx_api_keys_hash (key_hash)
      );

      CREATE TABLE tags (
        id          VARBINARY(16) PRIMARY KEY,
        env_id      VARBINARY(16) NOT NULL,
        slug        VARCHAR(64)   NOT NULL,
        label       VARCHAR(64)   NOT NULL,
        created_at  BIGINT        NOT NULL,
        UNIQUE (env_id, slug),
        FOREIGN KEY (env_id) REFERENCES envs(id)
      );

      CREATE TABLE asset_tags (
        env_id    VARBINARY(16) NOT NULL,
        asset_id  VARBINARY(16) NOT NULL,
        tag_id    VARBINARY(16) NOT NULL,
        PRIMARY KEY (env_id, asset_id, tag_id),
        FOREIGN KEY (env_id) REFERENCES envs(id),
        FOREIGN KEY (asset_id) REFERENCES assets(id),
        FOREIGN KEY (tag_id) REFERENCES tags(id),
        INDEX idx_asset_tags_tag (env_id, tag_id)
      );

      CREATE TABLE entry_tags (
        env_id    VARBINARY(16) NOT NULL,
        entry_id  VARBINARY(16) NOT NULL,
        tag_id    VARBINARY(16) NOT NULL,
        PRIMARY KEY (env_id, entry_id, tag_id),
        FOREIGN KEY (env_id) REFERENCES envs(id),
        FOREIGN KEY (entry_id) REFERENCES entries(id),
        FOREIGN KEY (tag_id) REFERENCES tags(id),
        INDEX idx_entry_tags_tag (env_id, tag_id)
      );
    `
  },
  {
    id: 2,
    name: '0002_fts',
    sql: `
      -- See sqlite.ts for the model. MySQL FULLTEXT index gives us the
      -- query path. The PK can't include a TEXT/MEDIUMTEXT column, so
      -- field_name and locale are VARCHAR with prefix-safe lengths.
      -- value stays MEDIUMTEXT — full body text can be large.
      CREATE TABLE fts_entries (
        entry_id   VARBINARY(16) NOT NULL,
        type       VARCHAR(191) NOT NULL,
        field_name VARCHAR(191) NOT NULL,
        locale     VARCHAR(35)  NOT NULL DEFAULT '',
        value      MEDIUMTEXT   NOT NULL,
        PRIMARY KEY (entry_id, field_name, locale),
        FOREIGN KEY (entry_id) REFERENCES entries(id) ON DELETE CASCADE,
        INDEX idx_fts_entries_type (type),
        FULLTEXT INDEX ftx_fts_entries_value (value)
      ) ENGINE=InnoDB;
    `
  },
  {
    id: 3,
    name: '0003_oauth',
    sql: `
      CREATE TABLE oidc_payloads (
        model       VARCHAR(64)   NOT NULL,
        id          VARCHAR(191)  NOT NULL,
        payload     MEDIUMTEXT    NOT NULL,
        grant_id    VARCHAR(191),
        user_code   VARCHAR(191),
        uid         VARCHAR(191),
        expires_at  BIGINT,
        consumed_at BIGINT,
        PRIMARY KEY (model, id),
        INDEX idx_oidc_payloads_grant     (grant_id),
        INDEX idx_oidc_payloads_user_code (user_code),
        INDEX idx_oidc_payloads_uid       (uid),
        INDEX idx_oidc_payloads_expires   (expires_at)
      ) ENGINE=InnoDB;
    `
  },
  {
    id: 4,
    name: '0004_signing_keys',
    sql: `
      CREATE TABLE oidc_signing_keys (
        kid        VARCHAR(191) PRIMARY KEY,
        jwk        TEXT         NOT NULL,
        alg        VARCHAR(32)  NOT NULL,
        created_at BIGINT       NOT NULL
      ) ENGINE=InnoDB;
    `
  }
];
