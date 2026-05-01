import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export interface LedricConfig {
  db?: string;
  http?: {
    port?: number;
    host?: string;
  };
  assets?: {
    backend?: 'db' | 'local';
    path?: string;
  };
  gui?: {
    enabled?: boolean;
    mount?: string;
  };
  auth?: {
    requireReaderKey?: boolean;
  };
}

const FILENAME = 'ledric.config.json';

export function configPath(cwd: string = process.cwd()): string {
  return resolve(cwd, FILENAME);
}

/**
 * Load `ledric.config.json` from cwd. Missing file → empty object;
 * malformed JSON → empty object plus a stderr warning. Callers always
 * resolve their settings as `flag ?? config.x ?? hardcoded-default`.
 */
export function loadConfig(cwd: string = process.cwd()): LedricConfig {
  const p = configPath(cwd);
  if (!existsSync(p)) return {};
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    return parsed as LedricConfig;
  } catch (err) {
    process.stderr.write(
      `ledric: failed to parse ${p} — ignoring (${(err as Error).message})\n`
    );
    return {};
  }
}

/**
 * Resolve the SQLite DB path: explicit --db flag > config file's "db" >
 * `./ledric.db`. Used by every command that opens a Storage handle.
 */
export function resolveDb(argDb: string | undefined): string {
  if (argDb !== undefined && argDb.length > 0) return argDb;
  const cfg = loadConfig();
  if (cfg.db !== undefined && cfg.db.length > 0) return cfg.db;
  return './ledric.db';
}
