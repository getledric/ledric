import { createHash, randomBytes } from 'node:crypto';

/**
 * SHA-256 the given string and return raw bytes — same primitive used
 * by `@ledric/storage`'s api_keys path. Auth codes, refresh tokens,
 * and client secrets all flow through this on the way into the DB.
 */
export function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/**
 * Generate a cryptographically random base64url string of the given
 * byte length. Used for client secrets, auth codes, refresh tokens,
 * and the boot-time consent token.
 *
 * No padding — base64url-canonical so the value can ride on a URL.
 */
export function randomToken(bytes: number = 32): string {
  return randomBytes(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Constant-time string compare. Used when checking PKCE code_verifier
 * against the stored code_challenge (after S256-hashing the verifier);
 * cryptographic comparison should not leak length-of-match via early
 * exit on mismatch.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * PKCE S256: code_verifier → SHA-256 → base64url. The result must
 * match the code_challenge the client presented at /authorize.
 */
export function pkceS256(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
