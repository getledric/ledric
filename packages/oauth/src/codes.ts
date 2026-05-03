import type { LedricStorage } from '@ledric/storage';
import { pkceS256, randomToken, sha256 } from './hash.js';
import type { AuthCodeMintInput, AuthCodeMintResult, Scope } from './types.js';

const DEFAULT_CODE_TTL_SECONDS = 600;

export interface MintAuthCodeResult extends AuthCodeMintResult {}

export async function mintAuthCode(
  storage: LedricStorage,
  input: AuthCodeMintInput
): Promise<MintAuthCodeResult> {
  const code = randomToken(32);
  const ttl = input.ttl_seconds ?? DEFAULT_CODE_TTL_SECONDS;
  const expires_at = Date.now() + ttl * 1000;

  await storage.db
    .insertInto('oauth_codes')
    .values({
      code_hash: sha256(code),
      env_id: storage.envId(),
      client_id: input.client_id,
      redirect_uri: input.redirect_uri,
      code_challenge: input.code_challenge,
      scope: input.scope,
      expires_at,
      consumed_at: null
    })
    .execute();

  return { code, expires_at };
}

export interface ConsumeAuthCodeInput {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}

export interface ConsumedAuthCode {
  client_id: string;
  scope: Scope;
}

/**
 * Atomically validate + consume an auth code. Returns the bound
 * client_id and scope on success. Throws on any failure: unknown code,
 * already consumed, expired, client_id mismatch, redirect_uri mismatch,
 * or PKCE verifier failure.
 *
 * The code is marked consumed BEFORE returning. A second call with the
 * same code can never succeed — replay is not a concern.
 */
export async function consumeAuthCode(
  storage: LedricStorage,
  input: ConsumeAuthCodeInput
): Promise<ConsumedAuthCode> {
  const code_hash = sha256(input.code);
  const envId = storage.envId();
  return storage.db.transaction().execute(async (tx) => {
    const row = await tx
      .selectFrom('oauth_codes')
      .selectAll()
      .where('env_id', '=', envId)
      .where('code_hash', '=', code_hash)
      .executeTakeFirst();
    if (row === undefined) {
      throw new AuthCodeError('invalid_grant', 'auth code unknown');
    }
    if (row.consumed_at !== null) {
      throw new AuthCodeError('invalid_grant', 'auth code already used');
    }
    if (Number(row.expires_at) < Date.now()) {
      throw new AuthCodeError('invalid_grant', 'auth code expired');
    }
    if (row.client_id !== input.client_id) {
      throw new AuthCodeError('invalid_grant', 'auth code client mismatch');
    }
    if (row.redirect_uri !== input.redirect_uri) {
      throw new AuthCodeError('invalid_grant', 'redirect_uri mismatch');
    }
    if (pkceS256(input.code_verifier) !== row.code_challenge) {
      throw new AuthCodeError('invalid_grant', 'PKCE verifier failed');
    }
    await tx
      .updateTable('oauth_codes')
      .set({ consumed_at: Date.now() })
      .where('env_id', '=', envId)
      .where('code_hash', '=', code_hash)
      .execute();
    return {
      client_id: row.client_id,
      scope: row.scope as Scope
    };
  });
}

export class AuthCodeError extends Error {
  readonly code: 'invalid_grant' | 'invalid_request';
  constructor(code: 'invalid_grant' | 'invalid_request', message: string) {
    super(message);
    this.name = 'AuthCodeError';
    this.code = code;
  }
}
