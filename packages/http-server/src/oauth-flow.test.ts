import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Core } from '@ledric/core';
import { openSqlite, type LedricStorage } from '@ledric/storage';
import { pkceS256, randomToken } from '@ledric/oauth';
import { createHttpServer } from './server.js';
import type { FastifyInstance } from 'fastify';

const ISSUER = 'http://127.0.0.1';

describe('OAuth 2.1 provider — end-to-end flow', () => {
  let storage: LedricStorage;
  let app: FastifyInstance;
  let stderrOutput = '';

  beforeEach(async () => {
    storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);
    stderrOutput = '';
    app = createHttpServer(core, {
      mcp: {
        public: true,
        http: true,
        publicUrl: ISSUER,
        allowedRedirectHosts: ['claude.ai', 'localhost', '127.0.0.1'],
        printToStderr: (s) => {
          stderrOutput += s;
        }
      },
      auth: { storage }
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    await storage.close();
  });

  function consentTokenFromStderr(): string {
    // The banner shows the token on its own line padded to width.
    const lines = stderrOutput.split('\n');
    const tokenLine = lines.find(
      (l) => /^│\s+[A-Za-z0-9_-]{20,}\s+│$/.test(l)
    );
    expect(tokenLine, `no consent token found in stderr:\n${stderrOutput}`).toBeDefined();
    return tokenLine!.replace(/^│\s+/, '').replace(/\s+│$/, '');
  }

  it('discovery endpoints return the right shape and URLs', async () => {
    const meta = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-authorization-server'
    });
    expect(meta.statusCode).toBe(200);
    const body = JSON.parse(meta.body);
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.scopes_supported).toEqual(['ledric:read', 'ledric:write']);

    const pr = await app.inject({
      method: 'GET',
      url: '/.well-known/oauth-protected-resource'
    });
    expect(pr.statusCode).toBe(200);
    expect(JSON.parse(pr.body).resource).toBe(`${ISSUER}/mcp`);

    const jwks = await app.inject({ method: 'GET', url: '/oauth/jwks' });
    expect(jwks.statusCode).toBe(200);
    const jwksBody = JSON.parse(jwks.body);
    expect(Array.isArray(jwksBody.keys)).toBe(true);
    expect(jwksBody.keys[0].alg).toBe('EdDSA');
    expect(jwksBody.keys[0].use).toBe('sig');
    expect(typeof jwksBody.keys[0].kid).toBe('string');
  });

  it('walks the full DCR → authorize → token → /mcp flow', async () => {
    // 1. DCR — register a client.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_name: 'Claude (test)',
        redirect_uris: ['https://claude.ai/api/oauth/callback']
      }
    });
    expect(reg.statusCode).toBe(201);
    const client = JSON.parse(reg.body);
    expect(typeof client.client_id).toBe('string');
    expect(client.token_endpoint_auth_method).toBe('none');

    // 2. PKCE setup.
    const verifier = randomToken(32);
    const challenge = pkceS256(verifier);
    const state = 'opaque-state-blob';

    // 3. GET /authorize — operator sees the consent page.
    const authPage = await app.inject({
      method: 'GET',
      url:
        `/oauth/authorize?response_type=code` +
        `&client_id=${encodeURIComponent(client.client_id)}` +
        `&redirect_uri=${encodeURIComponent('https://claude.ai/api/oauth/callback')}` +
        `&scope=ledric:read` +
        `&state=${state}` +
        `&code_challenge=${challenge}` +
        `&code_challenge_method=S256`
    });
    expect(authPage.statusCode).toBe(200);
    expect(authPage.headers['content-type']).toMatch(/text\/html/);
    expect(authPage.body).toContain('Claude (test)');
    expect(authPage.body).toContain(client.client_id);
    expect(authPage.body).toContain('https://claude.ai/api/oauth/callback');
    expect(authPage.body).toContain('ledric:read');
    expect(authPage.body).toContain('reader');

    // 4. POST /authorize with the consent token from stderr.
    const consentToken = consentTokenFromStderr();
    const consent = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'https://claude.ai/api/oauth/callback',
        scope: 'ledric:read',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        consent_token: consentToken
      }).toString()
    });
    expect(consent.statusCode).toBe(302);
    const location = new URL(consent.headers.location as string);
    expect(location.origin + location.pathname).toBe('https://claude.ai/api/oauth/callback');
    const code = location.searchParams.get('code');
    expect(typeof code).toBe('string');
    expect(location.searchParams.get('state')).toBe(state);

    // 5. POST /oauth/token — exchange the code.
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'https://claude.ai/api/oauth/callback',
        client_id: client.client_id,
        code_verifier: verifier
      }).toString()
    });
    expect(tokenRes.statusCode).toBe(200);
    const tokens = JSON.parse(tokenRes.body);
    expect(tokens.token_type).toBe('Bearer');
    expect(typeof tokens.access_token).toBe('string');
    expect(typeof tokens.refresh_token).toBe('string');
    expect(tokens.scope).toBe('ledric:read');

    // 6. Call /mcp with the OAuth bearer — read-only tool should work.
    const initRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'oauth-test', version: '0' }
        },
        id: 1
      }
    });
    expect(initRes.statusCode).toBe(200);

    // 7. Refresh the token.
    const refreshRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      }).toString()
    });
    expect(refreshRes.statusCode).toBe(200);
    const rotated = JSON.parse(refreshRes.body);
    expect(rotated.access_token).not.toBe(tokens.access_token);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);

    // 8. Replay the original refresh — expect lineage revoke (400).
    const replay = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token
      }).toString()
    });
    expect(replay.statusCode).toBe(400);
    expect(JSON.parse(replay.body).error).toBe('invalid_grant');

    // 9. Use the rotated access token — should still work.
    const second = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${rotated.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'oauth-test', version: '0' }
        },
        id: 2
      }
    });
    expect(second.statusCode).toBe(200);
  });

  it('rejects /authorize POST with stale or wrong consent token', async () => {
    const verifier = randomToken(32);
    const challenge = pkceS256(verifier);
    // Register a client first.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: {
        client_name: 'X',
        redirect_uris: ['https://claude.ai/cb']
      }
    });
    const { client_id } = JSON.parse(reg.body);

    const bad = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id,
        redirect_uri: 'https://claude.ai/cb',
        scope: 'ledric:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        consent_token: 'definitely-not-the-token'
      }).toString()
    });
    expect(bad.statusCode).toBe(403);
    expect(bad.body).toContain('Consent token invalid');
  });

  it('scope mapping: a ledric:read token is forbidden from write tools (403, not 401)', async () => {
    // Walk the flow with scope=ledric:read, then try to call create_type.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: { client_name: 'R', redirect_uris: ['https://claude.ai/cb'] }
    });
    const { client_id } = JSON.parse(reg.body);
    const verifier = randomToken(32);
    const challenge = pkceS256(verifier);

    const consentToken = consentTokenFromStderr();
    const consent = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id,
        redirect_uri: 'https://claude.ai/cb',
        scope: 'ledric:read',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        consent_token: consentToken
      }).toString()
    });
    const code = new URL(consent.headers.location as string).searchParams.get('code')!;

    const tokenRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        client_id,
        code_verifier: verifier
      }).toString()
    });
    const tokens = JSON.parse(tokenRes.body);

    // A write call (tools/call create_type) should be 403, not 401.
    const writeRes = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'create_type', arguments: { name: 'x', fields: {} } },
        id: 99
      }
    });
    expect(writeRes.statusCode).toBe(403);
  });

  it('accepts both an OAuth JWT and an api-key bearer on /mcp (mixed auth)', async () => {
    // Walk through to get a JWT.
    const reg = await app.inject({
      method: 'POST',
      url: '/oauth/register',
      headers: { 'content-type': 'application/json' },
      payload: { client_name: 'M', redirect_uris: ['https://claude.ai/cb'] }
    });
    const { client_id } = JSON.parse(reg.body);
    const verifier = randomToken(32);
    const challenge = pkceS256(verifier);
    const consentToken = consentTokenFromStderr();
    const consent = await app.inject({
      method: 'POST',
      url: '/oauth/authorize',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        client_id,
        redirect_uri: 'https://claude.ai/cb',
        scope: 'ledric:write',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        consent_token: consentToken
      }).toString()
    });
    const code = new URL(consent.headers.location as string).searchParams.get('code')!;
    const tokenRes = await app.inject({
      method: 'POST',
      url: '/oauth/token',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: 'https://claude.ai/cb',
        client_id,
        code_verifier: verifier
      }).toString()
    });
    const { access_token } = JSON.parse(tokenRes.body);

    // No api-key minted yet — auth-off mode allows the JWT path through.
    // Mint a key now to flip the server into authed mode and test the
    // mixed path.
    const { generateApiKey } = await import('@ledric/storage');
    const adminKey = generateApiKey('admin');
    await storage.createApiKey({
      role: 'admin',
      label: 'test',
      key_hash: adminKey.hash,
      key_prefix: adminKey.prefix
    });

    // JWT path — write call should now succeed (ledric:write → admin).
    const viaJwt = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'jwt', version: '0' }
        },
        id: 1
      }
    });
    expect(viaJwt.statusCode).toBe(200);

    // API-key path — same admin role, also works.
    const viaKey = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: {
        authorization: `Bearer ${adminKey.secret}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      payload: {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'apikey', version: '0' }
        },
        id: 2
      }
    });
    expect(viaKey.statusCode).toBe(200);
  });
});
