import { randomBytes } from 'node:crypto';
import type { LedricStorage } from '@ledric/storage';
import { randomToken, sha256 } from './hash.js';
import type { OAuthClientInfo, RegisterClientInput } from './types.js';

/**
 * Register a new OAuth client. DCR happens here. Public PKCE-only by
 * default — no client_secret minted. Pass `confidential: true` for the
 * rare admin-tooling case that needs a secret.
 */
export interface RegisterClientResult extends OAuthClientInfo {
  /**
   * Plaintext client_secret. Only present for confidential clients;
   * shown ONCE — not recoverable later.
   */
  client_secret?: string;
}

export async function registerClient(
  storage: LedricStorage,
  input: RegisterClientInput,
  opts: { confidential?: boolean } = {}
): Promise<RegisterClientResult> {
  if (input.redirect_uris.length === 0) {
    throw new RegisterClientError('redirect_uris must contain at least one URI');
  }
  for (const uri of input.redirect_uris) {
    let parsed: URL;
    try {
      parsed = new URL(uri);
    } catch {
      throw new RegisterClientError(`invalid redirect_uri: ${uri}`);
    }
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
      throw new RegisterClientError(
        `redirect_uri must be https or loopback: ${uri}`
      );
    }
    if (
      input.allowed_redirect_hosts !== undefined &&
      input.allowed_redirect_hosts.length > 0 &&
      !input.allowed_redirect_hosts.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))
    ) {
      throw new RegisterClientError(
        `redirect_uri host not in allowlist: ${parsed.hostname}`
      );
    }
  }

  const id = randomBytes(16);
  const client_id = randomToken(16);
  const confidential = opts.confidential === true;
  const client_secret = confidential ? randomToken(32) : undefined;
  const secret_hash = client_secret !== undefined ? sha256(client_secret) : null;
  const created_at = Date.now();

  await storage.db
    .insertInto('oauth_clients')
    .values({
      id,
      env_id: storage.envId(),
      client_id,
      secret_hash,
      name: input.name.slice(0, 255),
      redirect_uris: JSON.stringify(input.redirect_uris),
      created_at,
      revoked_at: null
    })
    .execute();

  const info: RegisterClientResult = {
    client_id,
    name: input.name,
    redirect_uris: [...input.redirect_uris],
    created_at,
    revoked_at: null
  };
  if (client_secret !== undefined) info.client_secret = client_secret;
  return info;
}

export async function getClient(
  storage: LedricStorage,
  client_id: string
): Promise<{ info: OAuthClientInfo; secret_hash: Buffer | null } | null> {
  const row = await storage.db
    .selectFrom('oauth_clients')
    .selectAll()
    .where('env_id', '=', storage.envId())
    .where('client_id', '=', client_id)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    info: {
      client_id: row.client_id,
      name: row.name,
      redirect_uris: JSON.parse(row.redirect_uris) as string[],
      created_at: Number(row.created_at),
      revoked_at: row.revoked_at !== null ? Number(row.revoked_at) : null
    },
    secret_hash: row.secret_hash
  };
}

export async function listClients(
  storage: LedricStorage,
  opts: { includeRevoked?: boolean } = {}
): Promise<OAuthClientInfo[]> {
  let q = storage.db
    .selectFrom('oauth_clients')
    .select(['client_id', 'name', 'redirect_uris', 'created_at', 'revoked_at'])
    .where('env_id', '=', storage.envId())
    .orderBy('created_at', 'desc');
  if (opts.includeRevoked !== true) {
    q = q.where('revoked_at', 'is', null);
  }
  const rows = await q.execute();
  return rows.map((r) => ({
    client_id: r.client_id,
    name: r.name,
    redirect_uris: JSON.parse(r.redirect_uris) as string[],
    created_at: Number(r.created_at),
    revoked_at: r.revoked_at !== null ? Number(r.revoked_at) : null
  }));
}

export async function revokeClient(
  storage: LedricStorage,
  client_id: string
): Promise<boolean> {
  const result = await storage.db
    .updateTable('oauth_clients')
    .set({ revoked_at: Date.now() })
    .where('env_id', '=', storage.envId())
    .where('client_id', '=', client_id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

export class RegisterClientError extends Error {
  readonly code = 'INVALID_CLIENT_METADATA' as const;
  constructor(message: string) {
    super(message);
    this.name = 'RegisterClientError';
  }
}
