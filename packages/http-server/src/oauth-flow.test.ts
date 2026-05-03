import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Core } from '@ledric/core';
import { openSqlite, type LedricStorage, generateApiKey } from '@ledric/storage';
import { createHash } from 'node:crypto';
import { createHttpServer } from './server.js';
import type { FastifyInstance } from 'fastify';

const ISSUER = 'http://127.0.0.1';

interface Env {
  app: FastifyInstance;
  storage: LedricStorage;
  url: string;
  adminKey: string;
}

/**
 * The full DCR-through-call-/mcp dance needs a real port — the
 * provider issues redirects with absolute URLs and we want to drive
 * it from a fetch client. Spin a Fastify listener on an ephemeral
 * port; tear down in afterEach.
 */
async function bootPublicMcp(): Promise<Env> {
  const storage = await openSqlite({ path: ':memory:' });
  const core = new Core(storage);

  // Mint an admin key in the DB so the consent page can validate it.
  const admin = generateApiKey('admin');
  await storage.createApiKey({
    role: 'admin',
    label: 'test',
    key_hash: admin.hash,
    key_prefix: admin.prefix
  });

  const app = createHttpServer(core, {
    mcp: { http: true, public: true, publicUrl: ISSUER },
    auth: { storage }
  });
  await app.ready();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  if (addr === null || typeof addr !== 'object') {
    throw new Error('listen returned no address');
  }
  return {
    app,
    storage,
    url: `http://127.0.0.1:${addr.port}`,
    adminKey: admin.secret
  };
}

function pkceS256(verifier: string): string {
  return createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function randomB64Url(n: number): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

describe('OAuth provider (oidc-provider) — end-to-end against /mcp', () => {
  let env: Env;

  beforeEach(async () => {
    env = await bootPublicMcp();
  });

  afterEach(async () => {
    await env.app.close();
    await env.storage.close();
  });

  it('discovery: AS metadata + protected-resource metadata + JWKS', async () => {
    const as = await fetch(`${env.url}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(200);
    const asBody = (await as.json()) as Record<string, unknown>;
    expect(asBody.issuer).toBe(ISSUER);
    // oidc-provider derives endpoint URLs from the request host, so the
    // test's ephemeral-port URL appears here instead of the configured
    // issuer. Production sets `publicUrl` to the actual reachable URL
    // (with port if non-standard) so the two stay in sync.
    expect(asBody.token_endpoint).toMatch(/^http:\/\/127\.0\.0\.1(:\d+)?\/oauth\/token$/);
    expect(asBody.code_challenge_methods_supported).toContain('S256');
    expect(asBody.grant_types_supported).toContain('refresh_token');

    const pr = await fetch(`${env.url}/.well-known/oauth-protected-resource`);
    expect(pr.status).toBe(200);
    expect((await pr.json()) as Record<string, unknown>).toMatchObject({
      resource: `${ISSUER}/mcp`,
      authorization_servers: [ISSUER]
    });

    const jwks = await fetch(`${env.url}/oauth/jwks`);
    expect(jwks.status).toBe(200);
    const jwksBody = (await jwks.json()) as { keys: Array<{ alg?: string; kty: string }> };
    expect(jwksBody.keys.length).toBeGreaterThan(0);
    // Resource-server JWTs are signed RS256 (matches the dev-mode
    // auto-generated signing keys oidc-provider mints). The exact alg
    // is configurable in the provider; assert the key type instead so
    // a future rotation to EdDSA wouldn't break this test.
    expect(['RSA', 'OKP', 'EC'].includes(jwksBody.keys[0]!.kty)).toBe(true);
  });

  it('walks DCR → consent (admin key) → token → /mcp → refresh → revoke → 401', async () => {
    // 1. DCR — register a public PKCE-only client.
    const reg = await fetch(`${env.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude (test)',
        redirect_uris: ['http://127.0.0.1:9999/cb'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code']
      })
    });
    if (reg.status !== 201) {
      const body = await reg.text();
      throw new Error(`DCR failed ${reg.status}: ${body}`);
    }
    const client = (await reg.json()) as { client_id: string };
    expect(typeof client.client_id).toBe('string');

    // 2. Authorize — follow redirects but do NOT auto-submit forms;
    //    the consent page is HTML we'll handle manually.
    const verifier = randomB64Url(32);
    const challenge = pkceS256(verifier);
    const state = 'opaque-state';
    const authorizeUrl =
      `${env.url}/oauth/authorize?` +
      new URLSearchParams({
        client_id: client.client_id,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        response_type: 'code',
        scope: 'ledric:write',
        resource: `${ISSUER}/mcp`,
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256'
      }).toString();
    const cookieJar: string[] = [];
    let res = await fetch(authorizeUrl, { redirect: 'manual' });
    captureCookies(res, cookieJar);
    // /authorize 303s into the interaction. Walk the redirect chain.
    while (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc === null) break;
      const next = new URL(loc, env.url).toString();
      res = await fetch(next, {
        redirect: 'manual',
        headers: cookieJar.length > 0 ? { cookie: cookieJar.join('; ') } : {}
      });
      captureCookies(res, cookieJar);
      if (next.includes('/oauth/consent/')) break;
    }
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const consentHtml = await res.text();
    expect(consentHtml).toContain('Claude (test)');
    expect(consentHtml).toContain(client.client_id);

    // Pull the consent UID from the form action.
    const uidMatch = consentHtml.match(/\/oauth\/consent\/([A-Za-z0-9_-]+)/);
    expect(uidMatch, 'consent UID not found in HTML').not.toBeNull();
    const uid = uidMatch![1]!;

    // 3. POST consent with the admin key.
    const consent = await fetch(`${env.url}/oauth/consent/${uid}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieJar.join('; ')
      },
      body: new URLSearchParams({ admin_key: env.adminKey }).toString()
    });
    captureCookies(consent, cookieJar);
    expect(consent.status).toBeGreaterThanOrEqual(300);
    expect(consent.status).toBeLessThan(400);

    // Walk the post-consent redirect chain back to the redirect_uri.
    let postRes = consent;
    let hops = 0;
    while (postRes.status >= 300 && postRes.status < 400 && hops++ < 10) {
      const loc = postRes.headers.get('location');
      if (loc === null) break;
      const next = new URL(loc, env.url).toString();
      if (next.startsWith('http://127.0.0.1:9999/cb')) {
        postRes = new Response(null, {
          status: 200,
          headers: { 'final-location': next }
        });
        break;
      }
      postRes = await fetch(next, {
        redirect: 'manual',
        headers: { cookie: cookieJar.join('; ') }
      });
      captureCookies(postRes, cookieJar);
    }
    const finalLoc = postRes.headers.get('final-location');
    if (finalLoc === null) {
      throw new Error(
        `redirect chain ended at status=${postRes.status} location=${postRes.headers.get('location')} body=${(await postRes.text()).slice(0, 300)}`
      );
    }
    expect(finalLoc, 'flow did not redirect to client redirect_uri').toBeTruthy();
    const codeUrl = new URL(finalLoc!);
    const code = codeUrl.searchParams.get('code');
    expect(typeof code).toBe('string');
    expect(codeUrl.searchParams.get('state')).toBe(state);

    // 4. Token exchange.
    const tokenRes = await fetch(`${env.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code!,
        redirect_uri: 'http://127.0.0.1:9999/cb',
        client_id: client.client_id,
        code_verifier: verifier
      }).toString()
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.access_token.startsWith('ey')).toBe(true);
    expect(tokens.scope).toBe('ledric:write');

    // 5. /mcp call with the JWT.
    const mcpRes = await fetch(`${env.url}/mcp`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${tokens.access_token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'oauth-test', version: '0' }
        },
        id: 1
      })
    });
    expect(mcpRes.status).toBe(200);

    // 6. Refresh.
    const refresh = await fetch(`${env.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokens.refresh_token,
        client_id: client.client_id
      }).toString()
    });
    if (refresh.status !== 200) {
      throw new Error(`refresh failed ${refresh.status}: ${await refresh.text()}`);
    }
    const rotated = (await refresh.json()) as { access_token: string; refresh_token: string };
    expect(rotated.access_token).not.toBe(tokens.access_token);

    // 7. Revoke the rotated refresh token.
    const revoke = await fetch(`${env.url}/oauth/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        token: rotated.refresh_token,
        client_id: client.client_id
      }).toString()
    });
    expect(revoke.status).toBe(200);

    // 8. Trying to refresh again with the revoked token → invalid_grant.
    const replay = await fetch(`${env.url}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: rotated.refresh_token,
        client_id: client.client_id
      }).toString()
    });
    expect(replay.status).toBe(400);
    expect(((await replay.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('rejects consent page with a wrong admin key', async () => {
    // Just exercise the negative path on /oauth/consent. We don't
    // need to walk the whole flow — drive an authorize redirect to
    // get a uid, then POST with garbage.
    const reg = await fetch(`${env.url}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Bad approve test',
        redirect_uris: ['http://127.0.0.1:9999/cb']
      })
    });
    const { client_id } = (await reg.json()) as { client_id: string };

    const verifier = randomB64Url(32);
    const cookieJar: string[] = [];
    let res = await fetch(
      `${env.url}/oauth/authorize?` +
        new URLSearchParams({
          client_id,
          redirect_uri: 'http://127.0.0.1:9999/cb',
          response_type: 'code',
          scope: 'ledric:read',
          resource: `${ISSUER}/mcp`,
          code_challenge: pkceS256(verifier),
          code_challenge_method: 'S256'
        }).toString(),
      { redirect: 'manual' }
    );
    captureCookies(res, cookieJar);
    while (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (loc === null) break;
      const next = new URL(loc, env.url).toString();
      res = await fetch(next, {
        redirect: 'manual',
        headers: cookieJar.length > 0 ? { cookie: cookieJar.join('; ') } : {}
      });
      captureCookies(res, cookieJar);
      if (next.includes('/oauth/consent/')) break;
    }
    const html = await res.text();
    const uid = html.match(/\/oauth\/consent\/([A-Za-z0-9_-]+)/)![1]!;

    const bad = await fetch(`${env.url}/oauth/consent/${uid}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieJar.join('; ')
      },
      body: new URLSearchParams({ admin_key: 'lka_definitely_wrong' }).toString()
    });
    expect(bad.status).toBe(403);
    expect(await bad.text()).toContain('Admin key invalid');
  });
});

describe('http-only mode (mcp.http: true, mcp.public: false)', () => {
  let env: { app: FastifyInstance; storage: LedricStorage; url: string };

  beforeEach(async () => {
    const storage = await openSqlite({ path: ':memory:' });
    const core = new Core(storage);
    const app = createHttpServer(core, { mcp: { http: true } });
    await app.ready();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const addr = app.server.address();
    env = {
      app,
      storage,
      url: `http://127.0.0.1:${(addr as { port: number }).port}`
    };
  });

  afterEach(async () => {
    await env.app.close();
    await env.storage.close();
  });

  it('OAuth surface is absent and oidc_payloads stays empty', async () => {
    const as = await fetch(`${env.url}/.well-known/oauth-authorization-server`);
    expect(as.status).toBe(404);
    const reg = await fetch(`${env.url}/oauth/register`, { method: 'POST' });
    expect(reg.status).toBe(404);

    const rows = await env.storage.db
      .selectFrom('oidc_payloads')
      .selectAll()
      .execute();
    expect(rows).toEqual([]);
  });
});

function captureCookies(res: Response, jar: string[]): void {
  // Fastify / oidc-provider set Set-Cookie via Koa's headers; the
  // raw response surface combines them. node-fetch / undici expose
  // the multi-value via `getSetCookie` (Node 22+). Each cookie is
  // "name=value; Path=...; HttpOnly; ..." — keep just the
  // name=value pair for the next request's Cookie header.
  const cookies =
    typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [];
  for (const c of cookies) {
    const nv = c.split(';')[0];
    if (nv && !jar.some((existing) => existing.startsWith(`${nv.split('=')[0]}=`))) {
      jar.push(nv);
    } else if (nv) {
      // Replace the prior value for the same name.
      const name = nv.split('=')[0]!;
      const idx = jar.findIndex((e) => e.startsWith(`${name}=`));
      if (idx >= 0) jar[idx] = nv;
      else jar.push(nv);
    }
  }
}
