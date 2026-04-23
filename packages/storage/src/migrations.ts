export interface Migration {
  id: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
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
    `
  }
];
