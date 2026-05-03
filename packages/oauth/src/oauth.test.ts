import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openSqlite, type LedricStorage } from '@ledric/storage';
import {
  loadOrGenerateSigningKeys,
  registerClient,
  getClient,
  listClients,
  revokeClient,
  mintAuthCode,
  consumeAuthCode,
  AuthCodeError,
  mintTokens,
  verifyAccessToken,
  findRefreshToken,
  revokeRefreshToken,
  revokeLineage,
  pkceS256,
  randomToken,
  type SigningKeys
} from './index.js';

const ISSUER = 'https://cms.example.com';

describe('@ledric/oauth', () => {
  let storage: LedricStorage;
  let keys: SigningKeys;

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    keys = await loadOrGenerateSigningKeys(storage);
  });

  afterEach(async () => {
    await storage.close();
  });

  describe('signing keys', () => {
    it('generates and persists an ed25519 keypair on first call', () => {
      expect(keys.publicJwk.alg).toBe('EdDSA');
      expect(keys.publicJwk.use).toBe('sig');
      expect(keys.kid).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('returns the same keypair on subsequent calls (loaded from DB)', async () => {
      const second = await loadOrGenerateSigningKeys(storage);
      expect(second.kid).toBe(keys.kid);
      expect(second.publicJwk.x).toBe(keys.publicJwk.x);
    });
  });

  describe('client registration (DCR)', () => {
    it('mints a public PKCE-only client by default — no secret', async () => {
      const c = await registerClient(storage, {
        name: 'Claude Desktop',
        redirect_uris: ['https://claude.ai/api/oauth/callback']
      });
      expect(c.client_id).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(c.client_secret).toBeUndefined();
      expect(c.name).toBe('Claude Desktop');
    });

    it('mints a confidential client with a one-shot secret on request', async () => {
      const c = await registerClient(
        storage,
        { name: 'Internal CLI', redirect_uris: ['http://127.0.0.1:8123/cb'] },
        { confidential: true }
      );
      expect(c.client_secret).toMatch(/^[A-Za-z0-9_-]+$/);
    });

    it('rejects http redirects on non-loopback hosts', async () => {
      await expect(
        registerClient(storage, {
          name: 'Bad',
          redirect_uris: ['http://evil.example.com/cb']
        })
      ).rejects.toThrow(/https or loopback/);
    });

    it('honors allowed_redirect_hosts as a host-suffix filter', async () => {
      await expect(
        registerClient(storage, {
          name: 'OK',
          redirect_uris: ['https://claude.ai/api/oauth/callback'],
          allowed_redirect_hosts: ['claude.ai', 'anthropic.com']
        })
      ).resolves.toBeDefined();
      await expect(
        registerClient(storage, {
          name: 'Not OK',
          redirect_uris: ['https://attacker.example.com/cb'],
          allowed_redirect_hosts: ['claude.ai', 'anthropic.com']
        })
      ).rejects.toThrow(/not in allowlist/);
    });

    it('lists, retrieves, and revokes clients', async () => {
      const c = await registerClient(storage, {
        name: 'Test',
        redirect_uris: ['https://x.example/cb']
      });
      const list = await listClients(storage);
      expect(list.map((r) => r.client_id)).toContain(c.client_id);
      const got = await getClient(storage, c.client_id);
      expect(got?.info.name).toBe('Test');

      const revoked = await revokeClient(storage, c.client_id);
      expect(revoked).toBe(true);
      const listAfter = await listClients(storage);
      expect(listAfter.map((r) => r.client_id)).not.toContain(c.client_id);
      const includingRevoked = await listClients(storage, { includeRevoked: true });
      expect(includingRevoked.map((r) => r.client_id)).toContain(c.client_id);
    });
  });

  describe('auth code lifecycle (PKCE S256)', () => {
    it('mints, exchanges, and refuses replay', async () => {
      const verifier = randomToken(32);
      const challenge = pkceS256(verifier);
      const minted = await mintAuthCode(storage, {
        client_id: 'client-abc',
        redirect_uri: 'https://x.example/cb',
        code_challenge: challenge,
        scope: 'ledric:read'
      });
      expect(minted.code).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(minted.expires_at).toBeGreaterThan(Date.now());

      const consumed = await consumeAuthCode(storage, {
        code: minted.code,
        client_id: 'client-abc',
        redirect_uri: 'https://x.example/cb',
        code_verifier: verifier
      });
      expect(consumed.client_id).toBe('client-abc');
      expect(consumed.scope).toBe('ledric:read');

      // Replay must fail.
      await expect(
        consumeAuthCode(storage, {
          code: minted.code,
          client_id: 'client-abc',
          redirect_uri: 'https://x.example/cb',
          code_verifier: verifier
        })
      ).rejects.toBeInstanceOf(AuthCodeError);
    });

    it('rejects bad PKCE verifier with invalid_grant', async () => {
      const verifier = randomToken(32);
      const minted = await mintAuthCode(storage, {
        client_id: 'c',
        redirect_uri: 'https://x.example/cb',
        code_challenge: pkceS256(verifier),
        scope: 'ledric:read'
      });
      try {
        await consumeAuthCode(storage, {
          code: minted.code,
          client_id: 'c',
          redirect_uri: 'https://x.example/cb',
          code_verifier: 'wrong-' + verifier
        });
        throw new Error('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(AuthCodeError);
        expect((err as AuthCodeError).code).toBe('invalid_grant');
      }
    });

    it('rejects redirect_uri mismatch', async () => {
      const verifier = randomToken(32);
      const minted = await mintAuthCode(storage, {
        client_id: 'c',
        redirect_uri: 'https://x.example/cb',
        code_challenge: pkceS256(verifier),
        scope: 'ledric:write'
      });
      await expect(
        consumeAuthCode(storage, {
          code: minted.code,
          client_id: 'c',
          redirect_uri: 'https://x.example/different',
          code_verifier: verifier
        })
      ).rejects.toThrow(/redirect_uri mismatch/);
    });
  });

  describe('JWT mint + verify', () => {
    it('round-trips an access token with the right claims', async () => {
      const pair = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'client-xyz',
        scope: 'ledric:read'
      });
      expect(pair.token_type).toBe('Bearer');
      expect(pair.expires_in).toBe(3600);
      expect(pair.refresh_token).toMatch(/^[A-Za-z0-9_-]+$/);

      const claims = await verifyAccessToken(keys, { issuer: ISSUER }, pair.access_token);
      expect(claims.iss).toBe(ISSUER);
      expect(claims.aud).toBe('ledric-mcp');
      expect(claims.sub).toBe('client-xyz');
      expect(claims.scope).toBe('ledric:read');
    });

    it('rejects a JWT signed with a different keypair', async () => {
      const pair = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'a',
        scope: 'ledric:read'
      });
      // Open a separate storage → different keypair.
      const otherStorage = await openSqlite({ path: ':memory:' });
      const otherKeys = await loadOrGenerateSigningKeys(otherStorage);
      await expect(
        verifyAccessToken(otherKeys, { issuer: ISSUER }, pair.access_token)
      ).rejects.toBeDefined();
      await otherStorage.close();
    });

    it('rejects a JWT with the wrong issuer', async () => {
      const pair = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'a',
        scope: 'ledric:read'
      });
      await expect(
        verifyAccessToken(keys, { issuer: 'https://wrong.example' }, pair.access_token)
      ).rejects.toBeDefined();
    });
  });

  describe('refresh token lookup, rotation, and lineage revocation', () => {
    it('finds an issued refresh token by its plaintext', async () => {
      const pair = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'a',
        scope: 'ledric:read'
      });
      const found = await findRefreshToken(storage, pair.refresh_token);
      expect(found).not.toBeNull();
      expect(found!.client_id).toBe('a');
      expect(found!.scope).toBe('ledric:read');
      expect(found!.revoked_at).toBeNull();
    });

    it('returns null for an unknown refresh token', async () => {
      const found = await findRefreshToken(storage, 'no-such-token');
      expect(found).toBeNull();
    });

    it('revokes a refresh token and subsequent finds reflect that', async () => {
      const pair = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'a',
        scope: 'ledric:read'
      });
      const ok = await revokeRefreshToken(storage, pair.refresh_token);
      expect(ok).toBe(true);
      const after = await findRefreshToken(storage, pair.refresh_token);
      expect(after?.revoked_at).not.toBeNull();
    });

    it('lineage revoke walks rotation chains forward', async () => {
      // Set up a chain: A → B → C.
      const a = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'cl',
        scope: 'ledric:read'
      });
      const aRow = (await findRefreshToken(storage, a.refresh_token))!;
      const b = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'cl',
        scope: 'ledric:read',
        parent_token_hash: aRow.token_hash
      });
      const bRow = (await findRefreshToken(storage, b.refresh_token))!;
      const c = await mintTokens(storage, keys, { issuer: ISSUER }, {
        client_id: 'cl',
        scope: 'ledric:read',
        parent_token_hash: bRow.token_hash
      });

      // Replay attack: someone presents A again — we revoke A's children.
      await revokeLineage(storage, aRow.token_hash);

      const bAfter = await findRefreshToken(storage, b.refresh_token);
      const cAfter = await findRefreshToken(storage, c.refresh_token);
      expect(bAfter?.revoked_at).not.toBeNull();
      expect(cAfter?.revoked_at).not.toBeNull();
      // A itself isn't touched by lineage-from-A — that's the caller's
      // job (same call usually revokes the offered token too).
      const aAfter = await findRefreshToken(storage, a.refresh_token);
      expect(aAfter?.revoked_at).toBeNull();
    });
  });
});
