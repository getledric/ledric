// API-key generation, hashing, and prefix conventions.
//
// Format:
//   lka_<base64url(32 random bytes)>   (admin keys)
//   lkr_<base64url(32 random bytes)>   (reader keys)
//
// The role lives in the prefix so a leaked key is self-describing for
// the operator's logs/grep — but the canonical role check goes through
// the DB row keyed by sha256(secret), so a tampered prefix can't grant
// privileges that don't exist in storage.
//
// Stored: SHA-256 of the full secret (32 bytes). 32 random bytes of
// entropy + sha256 is plenty here — these are server-issued, never
// user-derived, so password-hash KDFs (bcrypt/argon2) buy nothing.

import { randomBytes, createHash } from 'node:crypto';

export type ApiKeyRole = 'admin' | 'reader';

export const ROLE_PREFIX: Readonly<Record<ApiKeyRole, string>> = {
  admin: 'lka_',
  reader: 'lkr_'
};

export interface GeneratedApiKey {
  /**
   * The plaintext secret. ONLY available at generation time — print it
   * once and discard. Subsequent reads from storage will not include it.
   */
  secret: string;
  /** SHA-256 of the secret. 32 bytes. */
  hash: Uint8Array;
  /** First 12 chars of the secret, safe to display in CLIs and lists. */
  prefix: string;
  role: ApiKeyRole;
}

/** Mint a fresh key for the given role. */
export function generateApiKey(role: ApiKeyRole): GeneratedApiKey {
  const body = randomBytes(32).toString('base64url');
  const secret = ROLE_PREFIX[role] + body;
  return {
    secret,
    hash: hashApiKey(secret),
    prefix: secret.slice(0, 12),
    role
  };
}

/** SHA-256 hash of a secret, returned as a 32-byte Uint8Array. */
export function hashApiKey(secret: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(secret).digest());
}

/**
 * Recover the role from the prefix without hitting the DB. Useful for
 * early-rejecting clearly-malformed tokens before doing a hash lookup.
 * Returns null when the secret has no recognized prefix.
 */
export function parseApiKeyRole(secret: string): ApiKeyRole | null {
  if (typeof secret !== 'string') return null;
  if (secret.startsWith(ROLE_PREFIX.admin)) return 'admin';
  if (secret.startsWith(ROLE_PREFIX.reader)) return 'reader';
  return null;
}

/** True if a secret roughly looks like a ledric key (right shape, not verified). */
export function looksLikeApiKey(secret: string): boolean {
  return parseApiKeyRole(secret) !== null && secret.length >= 12;
}
