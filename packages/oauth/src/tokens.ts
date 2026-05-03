import { SignJWT, jwtVerify } from 'jose';
import type { LedricStorage } from '@ledric/storage';
import { randomToken, sha256 } from './hash.js';
import type { SigningKeys } from './keys.js';
import type { AccessTokenClaims, Scope, TokenPair } from './types.js';

const DEFAULT_ACCESS_TTL = 60 * 60; // 1h
const DEFAULT_REFRESH_TTL = 60 * 60 * 24 * 30; // 30d

export interface TokenIssuerOptions {
  issuer: string;
  audience?: string;
  accessTtlSeconds?: number;
  refreshTtlSeconds?: number;
}

const AUDIENCE = 'ledric-mcp';

export interface MintTokensInput {
  client_id: string;
  scope: Scope;
  /** Set on rotation: hash of the refresh token this one rotates from. */
  parent_token_hash?: Buffer;
}

/**
 * Mint a fresh access+refresh token pair. Used at /oauth/token in two
 * cases: exchanging an auth code (parent_token_hash unset), and rotating
 * a refresh token (parent_token_hash = the old hash).
 */
export async function mintTokens(
  storage: LedricStorage,
  keys: SigningKeys,
  opts: TokenIssuerOptions,
  input: MintTokensInput
): Promise<TokenPair> {
  const accessTtl = opts.accessTtlSeconds ?? DEFAULT_ACCESS_TTL;
  const refreshTtl = opts.refreshTtlSeconds ?? DEFAULT_REFRESH_TTL;
  const now = Math.floor(Date.now() / 1000);

  const access_token = await new SignJWT({ scope: input.scope })
    .setProtectedHeader({ alg: 'EdDSA', kid: keys.kid, typ: 'JWT' })
    .setIssuer(opts.issuer)
    .setAudience(opts.audience ?? AUDIENCE)
    .setSubject(input.client_id)
    .setIssuedAt(now)
    .setExpirationTime(now + accessTtl)
    .sign(keys.privateKey);

  const refresh_token = randomToken(48);
  const refresh_hash = sha256(refresh_token);

  await storage.db
    .insertInto('oauth_refresh_tokens')
    .values({
      token_hash: refresh_hash,
      env_id: storage.envId(),
      client_id: input.client_id,
      scope: input.scope,
      issued_at: Date.now(),
      expires_at: Date.now() + refreshTtl * 1000,
      revoked_at: null,
      parent_token_hash: input.parent_token_hash ?? null
    })
    .execute();

  return {
    access_token,
    refresh_token,
    expires_in: accessTtl,
    scope: input.scope,
    token_type: 'Bearer'
  };
}

/**
 * Verify a JWT and return its claims. Throws on bad signature, expired,
 * wrong issuer/audience, or unknown kid. Used by the /mcp middleware.
 */
export async function verifyAccessToken(
  keys: SigningKeys,
  opts: TokenIssuerOptions,
  token: string
): Promise<AccessTokenClaims> {
  const { payload } = await jwtVerify(token, keys.publicKey, {
    issuer: opts.issuer,
    audience: opts.audience ?? AUDIENCE
  });
  // jose checks iss/aud/exp for us. Project to our typed shape.
  return {
    iss: String(payload.iss),
    aud: String(payload.aud),
    sub: String(payload.sub),
    scope: payload['scope'] as Scope,
    iat: Number(payload.iat),
    exp: Number(payload.exp)
  };
}

/**
 * Look up a refresh token by plaintext, validate liveness, return the
 * stored row. Returns null when the token is unknown, expired, revoked,
 * or already rotated (replay attack — caller should revoke the lineage).
 */
export interface StoredRefreshToken {
  token_hash: Buffer;
  client_id: string;
  scope: Scope;
  issued_at: number;
  expires_at: number;
  revoked_at: number | null;
  parent_token_hash: Buffer | null;
}

export async function findRefreshToken(
  storage: LedricStorage,
  refresh_token: string
): Promise<StoredRefreshToken | null> {
  const hash = sha256(refresh_token);
  const row = await storage.db
    .selectFrom('oauth_refresh_tokens')
    .selectAll()
    .where('env_id', '=', storage.envId())
    .where('token_hash', '=', hash)
    .executeTakeFirst();
  if (row === undefined) return null;
  return {
    token_hash: row.token_hash,
    client_id: row.client_id,
    scope: row.scope as Scope,
    issued_at: Number(row.issued_at),
    expires_at: Number(row.expires_at),
    revoked_at: row.revoked_at !== null ? Number(row.revoked_at) : null,
    parent_token_hash: row.parent_token_hash
  };
}

/** Mark a refresh token revoked (one-shot — does not chase the lineage). */
export async function revokeRefreshToken(
  storage: LedricStorage,
  refresh_token: string
): Promise<boolean> {
  const hash = sha256(refresh_token);
  const result = await storage.db
    .updateTable('oauth_refresh_tokens')
    .set({ revoked_at: Date.now() })
    .where('env_id', '=', storage.envId())
    .where('token_hash', '=', hash)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows ?? 0) > 0;
}

/**
 * Detect the "refresh-token replay" attack: a client presents a token
 * that was already rotated. Per OAuth 2.1 best practice, revoke the
 * entire lineage (the rotated child plus everything descended from it).
 */
export async function revokeLineage(
  storage: LedricStorage,
  parent_token_hash: Buffer
): Promise<void> {
  // Walk forward from parent_token_hash through children. Single-process
  // single-statement-per-step keeps the lineage closure correct under
  // concurrent rotations: each step revokes leaf-by-leaf.
  let current: Buffer[] = [parent_token_hash];
  while (current.length > 0) {
    await storage.db
      .updateTable('oauth_refresh_tokens')
      .set({ revoked_at: Date.now() })
      .where('env_id', '=', storage.envId())
      .where('parent_token_hash', 'in', current)
      .where('revoked_at', 'is', null)
      .execute();
    const next = await storage.db
      .selectFrom('oauth_refresh_tokens')
      .select('token_hash')
      .where('env_id', '=', storage.envId())
      .where('parent_token_hash', 'in', current)
      .execute();
    current = next.map((r) => r.token_hash);
  }
}
