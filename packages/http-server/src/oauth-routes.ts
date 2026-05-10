import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import type { LedricStorage } from '@ledric/storage';
import { hashApiKey } from '@ledric/storage';
import {
  buildProvider,
  loadOrCreateSigningKey,
  reapExpiredOidcPayloads,
  SCOPE_TO_ROLE,
  type AccessTokenClaims,
  type ProtectedResourceMetadata,
  type Scope
} from '@ledric/oauth';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export interface OAuthMountOptions {
  /** OAuth issuer URL — must equal the configured `publicUrl`. */
  issuer: string;
  /** Allow Dynamic Client Registration. Default: true. */
  dcr?: boolean;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /** stderr writer — tests can swap this. */
  printToStderr?: (s: string) => void;
}

/**
 * Verifier closed over the issuer's JWKS. Returned from
 * mountOAuthRoutes so the /mcp middleware can validate access tokens
 * without re-creating the key set per request.
 */
export type AccessTokenVerifier = (token: string) => Promise<AccessTokenClaims>;

/**
 * Mount the OAuth surface (oidc-provider does the heavy lifting),
 * the protected-resource metadata document (RFC 9728), and the
 * consent UI that interactions are routed to. Returns the access-
 * token verifier the /mcp middleware uses for the JWT path.
 */
export async function mountOAuthRoutes(
  app: FastifyInstance,
  storage: LedricStorage,
  opts: OAuthMountOptions
): Promise<{ verify: AccessTokenVerifier; close: () => void }> {
  // Load (or first-boot mint) the persistent signing key. Without
  // this oidc-provider auto-generates dev-mode keys per process —
  // every restart invalidates issued JWTs and claude.ai connectors
  // silently lose their connection.
  const signingKey = await loadOrCreateSigningKey(storage);

  const provider = buildProvider(storage, {
    issuer: opts.issuer,
    jwks: { keys: [signingKey] },
    ...(opts.dcr !== undefined ? { dcr: opts.dcr } : {}),
    ...(opts.accessTokenTtlSeconds !== undefined
      ? { accessTokenTtlSeconds: opts.accessTokenTtlSeconds }
      : {}),
    ...(opts.refreshTokenTtlSeconds !== undefined
      ? { refreshTokenTtlSeconds: opts.refreshTokenTtlSeconds }
      : {})
  });

  // Periodic GC for expired payloads. oidc-provider doesn't sweep
  // the store; the adapter's hydrate path filters expired rows out
  // of reads, but the table grows without this. Once an hour is
  // plenty for an adapter that's only active when public mode is on.
  const reaper = setInterval(
    () => {
      reapExpiredOidcPayloads(storage).catch(() => undefined);
    },
    60 * 60 * 1000
  );
  reaper.unref();

  // Surface library errors to stderr so 500 responses don't hide
  // their cause behind a generic "oops" body. oidc-provider emits a
  // `server_error` event with the original Error attached.
  provider.on('server_error', (_ctx, err) => {
    process.stderr.write(`oidc-provider error: ${err.stack ?? err.message}\n`);
  });

  // Provider extends Koa — `.callback()` returns a Node request listener.
  // We mount it inside a Fastify plugin that strips Fastify's
  // built-in body parsers, so oidc-provider's koa stack can read the
  // request stream directly. Without that, Fastify's JSON / formbody
  // parsers consume `req.raw` before our handler runs, and the
  // library reports "redirect_uris is mandatory" / similar shape
  // errors because its body parser sees an empty payload.
  const oidcCallback = provider.callback();
  await app.register(
    async (instance) => {
      instance.removeAllContentTypeParsers();
      instance.addContentTypeParser('*', (_req, _payload, done) => {
        // No-op: leave the underlying stream intact for oidc-provider.
        done(null, undefined);
      });

      const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
        reply.hijack();
        await new Promise<void>((resolve, reject) => {
          reply.raw.on('finish', resolve);
          reply.raw.on('close', resolve);
          reply.raw.on('error', reject);
          oidcCallback(req.raw, reply.raw);
        });
      };

      // DCR lockdown switch. When `LEDRIC_DCR_INITIAL_TOKEN` is set,
      // /oauth/register requires the operator-provided token in the
      // `Authorization: Bearer <token>` header. Anonymous DCR is the
      // default (rate-limited at the http-server level) so claude.ai's
      // auto-DCR Just Works for new connectors; flip this on when
      // you'd rather hand out tokens out-of-band than accept any
      // signup-shaped request from the public internet.
      const dcrInitialToken = process.env.LEDRIC_DCR_INITIAL_TOKEN;
      const dcrTokenBuf =
        dcrInitialToken !== undefined && dcrInitialToken.length > 0
          ? Buffer.from(dcrInitialToken)
          : null;
      const checkDcrInitialToken = async (
        req: FastifyRequest,
        reply: FastifyReply
      ): Promise<void> => {
        if (dcrTokenBuf === null) return; // anonymous DCR (default)
        const header = String(req.headers.authorization ?? '');
        const presented = header.startsWith('Bearer ') ? header.slice(7) : '';
        const presentedBuf = Buffer.from(presented);
        if (
          presentedBuf.length !== dcrTokenBuf.length ||
          !timingSafeEqual(presentedBuf, dcrTokenBuf)
        ) {
          reply.code(401).send({
            error: 'invalid_token',
            error_description:
              'DCR is locked: operator requires an initial access token (LEDRIC_DCR_INITIAL_TOKEN).'
          });
        }
      };

      // Library-owned routes. Use wildcards so resume paths like
      // /oauth/authorize/<uid> (which oidc-provider mounts as a
      // sub-route of /oauth/authorize) also reach the library.
      // Consent UI is /oauth/consent/* — handled by separate Fastify
      // routes outside this plugin scope and so doesn't collide.
      const dcrSubpaths = new Set(['/oauth/register', '/oauth/register/*']);
      const oidcSubpaths = [
        '/oauth/authorize',
        '/oauth/authorize/*',
        '/oauth/token',
        '/oauth/token/*',
        '/oauth/register',
        '/oauth/register/*',
        '/oauth/revoke',
        '/oauth/introspection',
        '/oauth/jwks',
        '/oauth/session/end',
        '/oauth/par',
        '/oauth/backchannel',
        '/oauth/device',
        '/oauth/device/verify',
        '/.well-known/openid-configuration',
        '/.well-known/oauth-authorization-server'
      ];
      for (const path of oidcSubpaths) {
        if (dcrSubpaths.has(path)) {
          instance.all(path, { preHandler: checkDcrInitialToken }, handler);
        } else {
          instance.all(path, handler);
        }
      }
    }
  );

  // RFC 9728: protected-resource metadata. Lives on the resource
  // server (us, the MCP host), not the auth server. Points discovering
  // clients at the issuer so they can pick up its metadata next.
  app.get('/.well-known/oauth-protected-resource', async () => {
    const metadata: ProtectedResourceMetadata = {
      resource: `${opts.issuer}/mcp`,
      authorization_servers: [opts.issuer],
      scopes_supported: ['ledric:read', 'ledric:write'],
      bearer_methods_supported: ['header']
    };
    return metadata;
  });

  // ── Consent UI (interactions handler) ───────────────────────────────────
  // oidc-provider redirects unauthenticated authorize requests to
  // `/oauth/consent/:uid`. We render a minimal HTML form, the operator
  // pastes the admin key, we validate it the same way the auth
  // middleware does (env-key match OR sha256 lookup against api_keys),
  // then `provider.interactionFinished()` resumes the flow with a
  // login + consent grant for the synthetic 'operator' account.
  app.get<{ Params: { uid: string } }>(
    '/oauth/consent/:uid',
    async (req, reply) => {
      try {
        const details = await provider.interactionDetails(req.raw, reply.raw);
        const params = details.params as Record<string, string | undefined>;
        const clientId = typeof params.client_id === 'string' ? params.client_id : '';
        const client = clientId.length > 0
          ? await provider.Client.find(clientId)
          : undefined;
        const scope = typeof params.scope === 'string' ? params.scope : '';
        const role = inferRole(scope);
        reply.type('text/html');
        return consentPage({
          uid: details.uid,
          client_id: clientId,
          claimed_name: client?.clientName ?? '(no name registered)',
          redirect_uri: typeof params.redirect_uri === 'string' ? params.redirect_uri : '',
          scope,
          role,
          error: null
        });
      } catch (err) {
        reply.code(400).type('text/html');
        return errorPage([
          'Could not look up the interaction.',
          err instanceof Error ? err.message : String(err)
        ]);
      }
    }
  );

  app.post<{
    Params: { uid: string };
    Body: { admin_key?: string };
  }>('/oauth/consent/:uid', async (req, reply) => {
    let details;
    try {
      details = await provider.interactionDetails(req.raw, reply.raw);
    } catch (err) {
      reply.code(400).type('text/html');
      return errorPage([
        'Interaction expired or not found — restart the flow from your client.',
        err instanceof Error ? err.message : String(err)
      ]);
    }

    const presented = typeof req.body?.admin_key === 'string' ? req.body.admin_key.trim() : '';
    const ok = await verifyAdminKey(storage, presented);
    if (!ok) {
      const params = details.params as Record<string, string | undefined>;
      const clientId = typeof params.client_id === 'string' ? params.client_id : '';
      const client = clientId.length > 0
        ? await provider.Client.find(clientId)
        : undefined;
      const scope = typeof params.scope === 'string' ? params.scope : '';
      reply.code(403).type('text/html');
      return consentPage({
        uid: details.uid,
        client_id: clientId,
        claimed_name: client?.clientName ?? '(no name registered)',
        redirect_uri: typeof params.redirect_uri === 'string' ? params.redirect_uri : '',
        scope,
        role: inferRole(scope),
        error: 'Admin key invalid. Try again.'
      });
    }

    const params = details.params as Record<string, string | undefined>;
    const requestedScopes =
      typeof params.scope === 'string' ? params.scope.split(/\s+/).filter(Boolean) : [];
    const clientId = typeof params.client_id === 'string' ? params.client_id : '';

    // Mint a Grant with the requested scopes attached.
    const grant = new provider.Grant({ accountId: 'operator', clientId });
    grant.addOIDCScope(requestedScopes.join(' '));
    if (typeof params.resource === 'string') {
      grant.addResourceScope(params.resource, requestedScopes.join(' '));
    } else {
      grant.addResourceScope(`${opts.issuer}/mcp`, requestedScopes.join(' '));
    }
    const grantId = await grant.save();

    // interactionFinished writes the 303 redirect response itself.
    // We must hand it the raw Node response (Fastify already lets us
    // do that via reply.raw) and stop Fastify from sending its own.
    reply.hijack();
    await provider.interactionFinished(
      req.raw,
      reply.raw,
      {
        login: { accountId: 'operator' },
        consent: { grantId }
      },
      { mergeWithLastSubmission: false }
    );
  });

  // JWKS verifier — cached for the lifetime of the http server.
  const jwks = createRemoteJWKSet(new URL(`${opts.issuer}/oauth/jwks`));
  const verify: AccessTokenVerifier = async (token) => {
    const { payload } = await jwtVerify(token, jwks, {
      issuer: opts.issuer,
      audience: `${opts.issuer}/mcp`
    });
    return {
      iss: String(payload.iss),
      aud: payload.aud as string | string[],
      sub: String(payload.sub),
      scope: typeof payload['scope'] === 'string' ? payload['scope'] : '',
      iat: Number(payload.iat),
      exp: Number(payload.exp)
    };
  };

  return {
    verify,
    close: () => clearInterval(reaper)
  };
}

async function verifyAdminKey(storage: LedricStorage, presented: string): Promise<boolean> {
  if (presented.length === 0) return false;
  // Env-key check uses a constant-time compare too — string equality
  // in JS engines often early-exits, and this is in a UI consent flow
  // where the timing channel is reachable.
  const envKey = process.env.LEDRIC_ADMIN_KEY;
  if (envKey !== undefined && envKey.length === presented.length) {
    const a = Buffer.from(envKey);
    const b = Buffer.from(presented);
    if (timingSafeEqual(a, b)) return true;
  }
  // Look up by the non-secret prefix, then verify the full hash with
  // a constant-time compare in JS. SQL equality on `key_hash` is
  // bypassed entirely as a timing oracle.
  const found = await storage.findApiKeyByPrefix(presented.slice(0, 12));
  if (!found || found.role !== 'admin' || found.revoked_at !== null) return false;
  const presentedHash = Buffer.from(hashApiKey(presented));
  const storedHash = Buffer.from(found.key_hash);
  return (
    storedHash.length === presentedHash.length &&
    timingSafeEqual(storedHash, presentedHash)
  );
}

function inferRole(scope: string): string {
  // Resource-server projects scope→role; consent UI just shows the
  // user-friendly name. Highest scope wins on a multi-scope request.
  if (scope.includes('ledric:write')) return SCOPE_TO_ROLE['ledric:write'];
  if (scope.includes('ledric:read')) return SCOPE_TO_ROLE['ledric:read'];
  return '(unrecognised scope)';
}

interface ConsentPageVars {
  uid: string;
  client_id: string;
  claimed_name: string;
  redirect_uri: string;
  scope: string;
  role: string;
  error: string | null;
}

function consentPage(v: ConsentPageVars): string {
  const e = htmlEscape;
  const errorBlock = v.error
    ? `<p style="color:#b91c1c;background:#fef2f2;border:1px solid #fecaca;padding:0.6em 1em;border-radius:4px">${e(v.error)}</p>`
    : '';
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
    input[type=password] { width: 100%; padding: 0.6em; font-family: ui-monospace, monospace; font-size: 1rem; box-sizing: border-box; border: 1px solid #d4d4d8; border-radius: 4px; }
    button { margin-top: 1em; padding: 0.6em 1.2em; background: #18181b; color: white; border: 0; border-radius: 4px; font: inherit; cursor: pointer; }
    .hint { color: #71717a; font-size: 0.85rem; margin-top: 0.4em; }
  </style>
</head>
<body>
  <h1>Authorize an MCP client</h1>
  <p>A client is asking ledric for an access token. Verify <em>everything</em> below before approving — the display name comes from the client itself and isn't trusted.</p>
  ${errorBlock}
  <dl>
    <dt>Display name</dt><dd class="claimed">${e(v.claimed_name)} <span class="untrusted">(claimed by client; not verified)</span></dd>
    <dt>client_id</dt><dd>${e(v.client_id)}</dd>
    <dt>Redirect</dt><dd>${e(v.redirect_uri)}</dd>
    <dt>Scope</dt><dd><span class="scope">${e(v.scope)}</span> — maps to ledric role <strong>${e(v.role)}</strong></dd>
  </dl>
  <form method="POST" action="/oauth/consent/${e(v.uid)}">
    <label for="admin_key">Paste your ledric admin key (from <code>.env.local</code>) to approve</label>
    <input id="admin_key" name="admin_key" type="password" autocomplete="off" autofocus required>
    <p class="hint">The admin key is the operator credential — same one in your <code>LEDRIC_ADMIN_KEY</code> env var.</p>
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

export type { Scope, FastifyRequest, FastifyReply };
