import { generateKeyPair, exportJWK, importJWK, type JWK, type KeyLike } from 'jose';
import type { LedricStorage } from '@ledric/storage';

/**
 * Load the OAuth signing keypair from `oauth_keys`, or generate-and-
 * store one on first call. Returns both halves as `KeyLike` (for jose
 * sign/verify) plus the public JWK ready for the JWKS endpoint.
 *
 * Single keypair per env. Keyed by env_id PRIMARY KEY in the table so
 * we can't accidentally end up with two — the insert uses INSERT ... ON
 * CONFLICT to make first-boot idempotent across racing requests.
 */
export interface SigningKeys {
  /** Private key for `jose.SignJWT`. */
  privateKey: KeyLike;
  /** Public key for `jose.jwtVerify`. */
  publicKey: KeyLike;
  /** Public JWK with `kid`, `alg`, `use` populated for JWKS. */
  publicJwk: JWK & { kid: string; alg: 'EdDSA'; use: 'sig' };
  /**
   * Stable key ID derived from a hash of the public key's bytes. Embedded
   * in the JWT header so verifiers can pick the right key from JWKS.
   */
  kid: string;
}

export async function loadOrGenerateSigningKeys(
  storage: LedricStorage
): Promise<SigningKeys> {
  const envId = storage.envId();
  const existing = await storage.db
    .selectFrom('oauth_keys')
    .select(['private_jwk', 'public_jwk'])
    .where('env_id', '=', envId)
    .executeTakeFirst();

  if (existing !== undefined) {
    const privateJwk = JSON.parse(existing.private_jwk) as JWK;
    const publicJwk = JSON.parse(existing.public_jwk) as JWK & {
      kid: string;
      alg: 'EdDSA';
      use: 'sig';
    };
    const privateKey = (await importJWK(privateJwk, 'EdDSA')) as KeyLike;
    const publicKey = (await importJWK(publicJwk, 'EdDSA')) as KeyLike;
    return { privateKey, publicKey, publicJwk, kid: publicJwk.kid };
  }

  // Fresh boot — generate and persist.
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', {
    crv: 'Ed25519',
    extractable: true
  });
  const privateJwk = await exportJWK(privateKey);
  const publicJwk = await exportJWK(publicKey);
  const kid = await computeKid(publicJwk);
  const annotatedPublic: JWK & { kid: string; alg: 'EdDSA'; use: 'sig' } = {
    ...publicJwk,
    kid,
    alg: 'EdDSA',
    use: 'sig'
  };
  // Mirror the public-side annotations onto the private record for
  // round-trip stability — `kid` comes back the same on next boot.
  const annotatedPrivate: JWK & { kid: string; alg: 'EdDSA'; use: 'sig' } = {
    ...privateJwk,
    kid,
    alg: 'EdDSA',
    use: 'sig'
  };

  await storage.db
    .insertInto('oauth_keys')
    .values({
      env_id: envId,
      private_jwk: JSON.stringify(annotatedPrivate),
      public_jwk: JSON.stringify(annotatedPublic),
      created_at: Date.now()
    })
    .execute();

  return { privateKey, publicKey, publicJwk: annotatedPublic, kid };
}

/**
 * Stable key id: SHA-256 of the public key's `x` material, base64url-
 * truncated to 16 chars. Deterministic for a given keypair so the
 * JWT header `kid` doesn't drift across reboots.
 */
async function computeKid(publicJwk: JWK): Promise<string> {
  const x = (publicJwk as { x?: string }).x;
  if (typeof x !== 'string') throw new Error('public JWK missing `x` parameter');
  const bytes = base64UrlDecode(x);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return base64UrlEncode(digest).slice(0, 16);
}

function base64UrlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

function base64UrlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
