import type { LedricStorage } from '@ledric/storage';
import { generateKeyPair, exportJWK, type JWK } from 'jose';
import { randomBytes } from 'node:crypto';

/**
 * Load the persistent OAuth signing key from the DB, or generate +
 * persist one on first call. The returned JWK is private (RSA: has
 * `d`, `p`, `q`, `dp`, `dq`, `qi` plus `n` and `e`) and tagged with
 * `kid`, `use: 'sig'`, `alg: 'RS256'`.
 *
 * Without persistence, oidc-provider auto-generates dev-mode keys at
 * boot — restarting `serve` invalidates every issued JWT. claude.ai
 * connectors and other long-lived MCP clients silently lose their
 * connection. The whole point of this helper is to keep keys stable
 * across restarts so already-authenticated clients keep working.
 *
 * Single-row layout for now. Multi-row + rotation is a future
 * concern; today we want one stable RS256 keypair per ledric instance.
 */
export async function loadOrCreateSigningKey(
  storage: LedricStorage
): Promise<JWK> {
  const existing = await storage.db
    .selectFrom('oidc_signing_keys')
    .select(['kid', 'jwk', 'alg'])
    .orderBy('created_at', 'asc')
    .limit(1)
    .executeTakeFirst();
  if (existing !== undefined) {
    const parsed = JSON.parse(existing.jwk) as JWK;
    parsed.kid = existing.kid;
    parsed.alg = existing.alg;
    return parsed;
  }

  // RSA-2048 RS256 to match the signing alg advertised by
  // resourceIndicators.getResourceServerInfo. Generate, export to
  // private JWK, attach a stable kid, persist, return.
  const { privateKey } = await generateKeyPair('RS256', { modulusLength: 2048 });
  const jwk = (await exportJWK(privateKey)) as JWK;
  jwk.kid = randomBytes(8).toString('hex');
  jwk.alg = 'RS256';
  jwk.use = 'sig';

  await storage.db
    .insertInto('oidc_signing_keys')
    .values({
      kid: jwk.kid,
      jwk: JSON.stringify(jwk),
      alg: 'RS256',
      created_at: Date.now()
    })
    .execute();

  return jwk;
}
