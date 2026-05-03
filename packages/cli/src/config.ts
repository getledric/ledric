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
  /**
   * Public URL the operator advertises this ledric on. Used as the
   * OAuth issuer when `mcp.public` is on, and as the Origin allowlist
   * anchor. Required when `mcp.public` is enabled.
   */
  publicUrl?: string;
  mcp?: {
    /**
     * Mount Streamable HTTP MCP transport at /mcp. API-key bearer auth
     * only; binds 127.0.0.1 by default. The natural setup for multiple
     * local clients sharing one ledric daemon. Implied by `public`.
     */
    http?: boolean;
    /**
     * Expose ledric to the public internet for claude.ai custom
     * connectors. Implies `http`; mounts the OAuth provider, accepts
     * OAuth bearers on /mcp, requires `publicUrl`, and defaults the
     * bind to 0.0.0.0.
     */
    public?: boolean;
    /** Override the Origin-header allowlist. */
    allowedOrigins?: readonly string[];
    /**
     * Optional pre-auth IP allowlist (CIDR notation). Empty / unset =
     * allow all. Recommended in public-mode production deployments —
     * use Anthropic's published cloud IP ranges (their list drifts, so
     * we don't ship defaults).
     */
    allowedCidrs?: readonly string[];
  };
  oauth?: {
    /** Allow Dynamic Client Registration. Default: true (when mcp.remote is on). */
    dcr?: boolean;
    accessTokenTtlSeconds?: number;
    refreshTokenTtlSeconds?: number;
    /** Hostnames an OAuth client may register a redirect_uri under. */
    allowedRedirectHosts?: readonly string[];
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
