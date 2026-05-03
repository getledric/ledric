import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { LedricStorage } from '@ledric/storage';
import {
  loadOrGenerateSigningKeys,
  registerClient,
  getClient,
  mintAuthCode,
  consumeAuthCode,
  AuthCodeError,
  RegisterClientError,
  mintTokens,
  findRefreshToken,
  revokeRefreshToken,
  revokeLineage,
  verifyAccessToken,
  randomToken,
  timingSafeEqual,
  SCOPE_TO_ROLE,
  type SigningKeys,
  type Scope,
  type AccessTokenClaims,
  type AuthorizationServerMetadata,
  type ProtectedResourceMetadata
} from '@ledric/oauth';

export interface OAuthMountOptions {
  /** OAuth issuer URL — must match the configured publicUrl. */
  issuer: string;
  /** Hostnames a DCR-registered client may use in `redirect_uris`. */
  allowedRedirectHosts?: readonly string[];
  /** Whether DCR is open to anonymous registrants. Default: true. */
  dcr?: boolean;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /**
   * stderr writer used for consent-token banners. Defaults to
   * `process.stderr.write` — tests inject their own to capture output.
   */
  printToStderr?: (s: string) => void;
}

/**
 * Live OAuth state shared across handlers — signing keys, the current
 * boot-time consent token, the issuer config. Held in module-private
 * scope of mountOAuthRoutes so each createHttpServer instance gets
 * its own.
 */
interface OAuthRuntime {
  storage: LedricStorage;
  keys: SigningKeys;
  opts: OAuthMountOptions;
  /** Active consent token. Single-use; rotates on consumption. */
  consentToken: string;
  consentTokenIssuedAt: number;
}

const CONSENT_TOKEN_TTL_MS = 10 * 60 * 1000; // 10 minutes

function rotateConsentToken(runtime: OAuthRuntime): string {
  runtime.consentToken = randomToken(24);
  runtime.consentTokenIssuedAt = Date.now();
  const print = runtime.opts.printToStderr ?? ((s) => process.stderr.write(s));
  print(
    [
      '',
      '╭──────────────────────────────────────────────────────────────────────────╮',
      '│  OAuth consent token (single-use, ~10 min). Paste this into the          │',
      '│  consent page when claude.ai or another client requests authorization.   │',
      '├──────────────────────────────────────────────────────────────────────────┤',
      `│  ${runtime.consentToken.padEnd(72, ' ')}│`,
      '╰──────────────────────────────────────────────────────────────────────────╯',
      ''
    ].join('\n')
  );
  return runtime.consentToken;
}

/**
 * The verifier returned by mountOAuthRoutes — the /mcp preHandler
 * uses this to validate OAuth bearer tokens. Returns null when the
 * token is unrecognised (so caller can fall through to api-key auth)
 * and throws on JWT failure (caller treats that as 401).
 */
export type AccessTokenVerifier = (token: string) => Promise<AccessTokenClaims>;

export async function mountOAuthRoutes(
  app: FastifyInstance,
  storage: LedricStorage,
  opts: OAuthMountOptions
): Promise<{ verify: AccessTokenVerifier }> {
  const keys = await loadOrGenerateSigningKeys(storage);
  const runtime: OAuthRuntime = {
    storage,
    keys,
    opts,
    consentToken: '',
    consentTokenIssuedAt: 0
  };
  rotateConsentToken(runtime);

  const verify: AccessTokenVerifier = (token) =>
    verifyAccessToken(keys, { issuer: opts.issuer }, token);

  // ── RFC 8414: authorization-server metadata ─────────────────────────────
  app.get('/.well-known/oauth-authorization-server', async () => {
    const metadata: AuthorizationServerMetadata = {
      issuer: opts.issuer,
      authorization_endpoint: `${opts.issuer}/oauth/authorize`,
      token_endpoint: `${opts.issuer}/oauth/token`,
      registration_endpoint: `${opts.issuer}/oauth/register`,
      revocation_endpoint: `${opts.issuer}/oauth/revoke`,
      jwks_uri: `${opts.issuer}/oauth/jwks`,
      scopes_supported: ['ledric:read', 'ledric:write'],
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none']
    };
    return metadata;
  });

  // ── MCP authorization spec: protected-resource metadata ─────────────────
  app.get('/.well-known/oauth-protected-resource', async () => {
    const metadata: ProtectedResourceMetadata = {
      resource: `${opts.issuer}/mcp`,
      authorization_servers: [opts.issuer],
      scopes_supported: ['ledric:read', 'ledric:write'],
      bearer_methods_supported: ['header']
    };
    return metadata;
  });

  // ── JWKS ───────────────────────────────────────────────────────────────
  app.get('/oauth/jwks', async () => ({ keys: [keys.publicJwk] }));

  // ── DCR (RFC 7591) ─────────────────────────────────────────────────────
  if (opts.dcr !== false) {
    app.post<{
      Body: {
        client_name?: unknown;
        redirect_uris?: unknown;
      };
    }>('/oauth/register', async (req, reply) => {
      const body = req.body ?? {};
      const name =
        typeof body.client_name === 'string' && body.client_name.length > 0
          ? body.client_name
          : 'Unnamed client';
      const redirect_uris = Array.isArray(body.redirect_uris)
        ? body.redirect_uris.filter((u): u is string => typeof u === 'string')
        : [];
      try {
        const result = await registerClient(
          storage,
          {
            name,
            redirect_uris,
            ...(opts.allowedRedirectHosts !== undefined
              ? { allowed_redirect_hosts: opts.allowedRedirectHosts }
              : {})
          },
          { confidential: false }
        );
        // RFC 7591 response shape
        reply.code(201);
        return {
          client_id: result.client_id,
          client_id_issued_at: Math.floor(result.created_at / 1000),
          client_name: result.name,
          redirect_uris: result.redirect_uris,
          token_endpoint_auth_method: 'none',
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code']
        };
      } catch (err) {
        if (err instanceof RegisterClientError) {
          reply.code(400);
          return { error: 'invalid_client_metadata', error_description: err.message };
        }
        throw err;
      }
    });
  } else {
    app.post('/oauth/register', async (_req, reply) => {
      reply.code(403);
      return {
        error: 'access_denied',
        error_description: 'Dynamic Client Registration is disabled on this server.'
      };
    });
  }

  // ── /oauth/authorize — GET renders consent page, POST consumes token ───
  app.get<{
    Querystring: {
      response_type?: string;
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      code_challenge_method?: string;
    };
  }>('/oauth/authorize', async (req, reply) => {
    const q = req.query;
    const errors: string[] = [];
    if (q.response_type !== 'code') errors.push('response_type must be "code"');
    if (typeof q.client_id !== 'string' || q.client_id.length === 0)
      errors.push('client_id required');
    if (typeof q.redirect_uri !== 'string' || q.redirect_uri.length === 0)
      errors.push('redirect_uri required');
    if (typeof q.code_challenge !== 'string' || q.code_challenge.length === 0)
      errors.push('code_challenge required (PKCE)');
    if (q.code_challenge_method !== 'S256')
      errors.push('code_challenge_method must be S256');
    const scope = parseScope(q.scope);
    if (scope === null) errors.push('scope must be ledric:read or ledric:write');
    if (errors.length > 0) {
      reply.code(400).type('text/html');
      return errorPage(errors);
    }

    const client = await getClient(storage, q.client_id!);
    if (client === null || client.info.revoked_at !== null) {
      reply.code(404).type('text/html');
      return errorPage(['Unknown or revoked client_id']);
    }
    if (!client.info.redirect_uris.includes(q.redirect_uri!)) {
      reply.code(400).type('text/html');
      return errorPage(['redirect_uri does not match the registered set for this client']);
    }

    reply.type('text/html');
    return consentPage({
      client_id: q.client_id!,
      claimed_name: client.info.name,
      redirect_uri: q.redirect_uri!,
      scope: scope!,
      state: q.state ?? '',
      code_challenge: q.code_challenge!,
      code_challenge_method: 'S256'
    });
  });

  app.post<{
    Body: {
      client_id?: string;
      redirect_uri?: string;
      scope?: string;
      state?: string;
      code_challenge?: string;
      consent_token?: string;
    };
  }>('/oauth/authorize', async (req, reply) => {
    const b = req.body ?? {};
    const presented = typeof b.consent_token === 'string' ? b.consent_token : '';

    // Constant-time check + TTL.
    const fresh = Date.now() - runtime.consentTokenIssuedAt < CONSENT_TOKEN_TTL_MS;
    const valid = fresh && timingSafeEqual(presented, runtime.consentToken);
    if (!valid) {
      // Rotate so a leaked guess can't be replayed even within the TTL.
      rotateConsentToken(runtime);
      reply.code(403).type('text/html');
      return errorPage([
        'Consent token invalid or expired.',
        'A fresh token has been printed to the ledric server stderr — copy that and retry.'
      ]);
    }

    const scope = parseScope(b.scope);
    if (
      scope === null ||
      typeof b.client_id !== 'string' ||
      typeof b.redirect_uri !== 'string' ||
      typeof b.code_challenge !== 'string'
    ) {
      reply.code(400).type('text/html');
      return errorPage(['Missing required fields on the consent form']);
    }

    const minted = await mintAuthCode(storage, {
      client_id: b.client_id,
      redirect_uri: b.redirect_uri,
      code_challenge: b.code_challenge,
      scope
    });

    // Consume the token AFTER successful mint so a partial failure
    // doesn't burn it for the operator.
    rotateConsentToken(runtime);

    const target = new URL(b.redirect_uri);
    target.searchParams.set('code', minted.code);
    if (typeof b.state === 'string' && b.state.length > 0) {
      target.searchParams.set('state', b.state);
    }
    return reply.redirect(target.toString(), 302);
  });

  // ── /oauth/token — code or refresh exchange ────────────────────────────
  app.post<{
    Body: {
      grant_type?: string;
      code?: string;
      redirect_uri?: string;
      client_id?: string;
      code_verifier?: string;
      refresh_token?: string;
    };
  }>('/oauth/token', async (req, reply) => {
    const b = req.body ?? {};
    if (b.grant_type === 'authorization_code') {
      if (
        typeof b.code !== 'string' ||
        typeof b.client_id !== 'string' ||
        typeof b.redirect_uri !== 'string' ||
        typeof b.code_verifier !== 'string'
      ) {
        reply.code(400);
        return { error: 'invalid_request', error_description: 'missing required field' };
      }
      try {
        const consumed = await consumeAuthCode(storage, {
          code: b.code,
          client_id: b.client_id,
          redirect_uri: b.redirect_uri,
          code_verifier: b.code_verifier
        });
        const pair = await mintTokens(
          storage,
          keys,
          {
            issuer: opts.issuer,
            ...(opts.accessTokenTtlSeconds !== undefined
              ? { accessTtlSeconds: opts.accessTokenTtlSeconds }
              : {}),
            ...(opts.refreshTokenTtlSeconds !== undefined
              ? { refreshTtlSeconds: opts.refreshTokenTtlSeconds }
              : {})
          },
          { client_id: consumed.client_id, scope: consumed.scope }
        );
        return pair;
      } catch (err) {
        if (err instanceof AuthCodeError) {
          reply.code(400);
          return { error: err.code, error_description: err.message };
        }
        throw err;
      }
    }

    if (b.grant_type === 'refresh_token') {
      if (typeof b.refresh_token !== 'string') {
        reply.code(400);
        return { error: 'invalid_request', error_description: 'refresh_token required' };
      }
      const stored = await findRefreshToken(storage, b.refresh_token);
      if (stored === null) {
        reply.code(400);
        return { error: 'invalid_grant', error_description: 'unknown refresh token' };
      }
      if (stored.revoked_at !== null) {
        // Replay attack: someone is presenting an already-rotated token.
        // Walk the lineage forward and revoke any descendants too.
        await revokeLineage(storage, stored.token_hash);
        reply.code(400);
        return {
          error: 'invalid_grant',
          error_description: 'refresh token was already rotated; lineage revoked'
        };
      }
      if (stored.expires_at < Date.now()) {
        reply.code(400);
        return { error: 'invalid_grant', error_description: 'refresh token expired' };
      }
      // Mark the offered token revoked first so it can't be reused.
      await revokeRefreshToken(storage, b.refresh_token);
      const pair = await mintTokens(
        storage,
        keys,
        {
          issuer: opts.issuer,
          ...(opts.accessTokenTtlSeconds !== undefined
            ? { accessTtlSeconds: opts.accessTokenTtlSeconds }
            : {}),
          ...(opts.refreshTokenTtlSeconds !== undefined
            ? { refreshTtlSeconds: opts.refreshTokenTtlSeconds }
            : {})
        },
        {
          client_id: stored.client_id,
          scope: stored.scope,
          parent_token_hash: stored.token_hash
        }
      );
      return pair;
    }

    reply.code(400);
    return { error: 'unsupported_grant_type', error_description: `grant_type=${b.grant_type}` };
  });

  // ── /oauth/revoke (RFC 7009) ───────────────────────────────────────────
  app.post<{ Body: { token?: string; token_type_hint?: string } }>(
    '/oauth/revoke',
    async (req, reply) => {
      const token = typeof req.body?.token === 'string' ? req.body.token : '';
      if (token.length === 0) {
        reply.code(200);
        // RFC 7009: 200 even on no-op so attackers can't probe for valid tokens.
        return {};
      }
      // Try refresh token first; access tokens are JWTs and can't be
      // revoked server-side without a denylist (out of scope for v1).
      await revokeRefreshToken(storage, token);
      reply.code(200);
      return {};
    }
  );

  return { verify };
}

function parseScope(raw: string | undefined): Scope | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // OAuth scope is space-separated; we accept exactly one of our two.
  const trimmed = raw.trim();
  if (trimmed === 'ledric:read' || trimmed === 'ledric:write') {
    return trimmed;
  }
  return null;
}

interface ConsentPageVars {
  client_id: string;
  claimed_name: string;
  redirect_uri: string;
  scope: Scope;
  state: string;
  code_challenge: string;
  code_challenge_method: 'S256';
}

function consentPage(v: ConsentPageVars): string {
  const role = SCOPE_TO_ROLE[v.scope];
  const e = htmlEscape;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorize MCP client — ledric</title>
  <meta name="color-scheme" content="light dark">
  <style>
    body { font: 14px/1.5 ui-sans-serif, -apple-system, system-ui, sans-serif; max-width: 560px; margin: 4em auto; padding: 0 1em; color: #18181b; }
    h1 { font-size: 1.4rem; margin: 0 0 1em; }
    dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.5em 1em; }
    dt { color: #71717a; }
    dd { margin: 0; word-break: break-all; font-family: ui-monospace, Menlo, monospace; font-size: 0.9rem; }
    .claimed { font-family: inherit; }
    .untrusted { color: #a1a1aa; font-size: 0.8rem; margin-left: 0.5em; }
    .scope { display: inline-block; padding: 2px 8px; border-radius: 999px; background: #fef3c7; color: #92400e; font-size: 0.85rem; }
    form { margin-top: 2em; padding-top: 1.5em; border-top: 1px solid #e4e4e7; }
    label { display: block; margin-bottom: 0.5em; }
    input[type=text] { width: 100%; padding: 0.6em; font-family: ui-monospace, monospace; font-size: 1rem; box-sizing: border-box; border: 1px solid #d4d4d8; border-radius: 4px; }
    button { margin-top: 1em; padding: 0.6em 1.2em; background: #18181b; color: white; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
    .hint { color: #71717a; font-size: 0.85rem; margin-top: 0.4em; }
  </style>
</head>
<body>
  <h1>Authorize an MCP client</h1>
  <p>A client is asking ledric for an access token. Verify <em>everything</em> below before approving — the display name comes from the client itself and isn't trusted.</p>
  <dl>
    <dt>Display name</dt><dd class="claimed">${e(v.claimed_name)} <span class="untrusted">(claimed by client; not verified)</span></dd>
    <dt>client_id</dt><dd>${e(v.client_id)}</dd>
    <dt>Redirect</dt><dd>${e(v.redirect_uri)}</dd>
    <dt>Scope</dt><dd><span class="scope">${e(v.scope)}</span> — maps to ledric role <strong>${role}</strong></dd>
  </dl>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="client_id" value="${e(v.client_id)}">
    <input type="hidden" name="redirect_uri" value="${e(v.redirect_uri)}">
    <input type="hidden" name="scope" value="${e(v.scope)}">
    <input type="hidden" name="state" value="${e(v.state)}">
    <input type="hidden" name="code_challenge" value="${e(v.code_challenge)}">
    <input type="hidden" name="code_challenge_method" value="${e(v.code_challenge_method)}">
    <label for="consent_token">Consent token (printed to your ledric server's stderr at boot)</label>
    <input id="consent_token" name="consent_token" type="text" autocomplete="off" autofocus required>
    <p class="hint">If you don't see one, look in the terminal running <code>ledric serve --public-mcp</code>. Tokens rotate after each use.</p>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}

function errorPage(messages: string[]): string {
  const e = htmlEscape;
  const items = messages.map((m) => `<li>${e(m)}</li>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error — ledric</title><style>body{font:14px/1.5 system-ui,sans-serif;max-width:560px;margin:4em auto;padding:0 1em}h1{font-size:1.2rem}ul{padding-left:1.4em}</style></head><body><h1>Authorization error</h1><ul>${items}</ul></body></html>`;
}

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Used by tests to swap in their own consent token without scraping
 * stderr. Returns the current token so test fixtures can submit
 * forms against it deterministically.
 */
export function _testGetConsentToken(_app: FastifyInstance): never {
  // Placeholder — the runtime is closed over inside mountOAuthRoutes.
  // Tests use the printToStderr capture to grab the token instead.
  throw new Error('use printToStderr to capture the token in tests');
}

export type { FastifyRequest, FastifyReply };
