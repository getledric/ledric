import Provider from 'oidc-provider';
import type { Configuration, KoaContextWithOIDC, Account, FindAccount, JWKS } from 'oidc-provider';
import type { LedricStorage } from '@ledric/storage';
import { KyselyOidcAdapter } from './adapter.js';

export interface BuildProviderOptions {
  /** Public URL of this ledric — becomes the OAuth issuer. Required. */
  issuer: string;
  /** Open Dynamic Client Registration to anonymous registrants. Default: true. */
  dcr?: boolean;
  accessTokenTtlSeconds?: number;
  refreshTokenTtlSeconds?: number;
  /**
   * Persistent signing keys. When omitted, oidc-provider generates
   * dev-mode keys at boot — fine for unit tests, broken for real use
   * because every restart invalidates issued JWTs. Production path
   * (and the public-MCP serve flow) supplies keys from
   * `loadOrCreateSigningKey(storage)`.
   */
  jwks?: JWKS;
}

/**
 * Build an `oidc-provider` Provider instance configured for ledric:
 *
 * - **Single synthetic operator account.** ledric has no users; the
 *   admin key is the operator credential. `findAccount` returns one
 *   static account whose `accountId` is `'operator'`. If a future
 *   ledric grows real user accounts, the change is replacing this
 *   function — not touching the OAuth machinery elsewhere. **Do not
 *   sprinkle `'operator'` checks throughout the code**; anything that
 *   wants to know "who is this token for" reads the verified `sub`.
 *
 * - **PKCE S256 always required.** Public + confidential clients alike.
 *
 * - **DCR enabled by default.** Flipped off via `dcr: false` for
 *   stricter deployments. registrationManagement is off — clients
 *   register once and either work or don't.
 *
 * - **JWT access tokens** via the resourceIndicators feature, signed
 *   with EdDSA. /mcp validates by hitting the issuer's JWKS — no DB
 *   round-trip per request.
 *
 * - **Userinfo + ID tokens off.** We only issue access + refresh
 *   tokens for OAuth 2.0 resource access; OIDC ID-token machinery
 *   would imply user identity, which we don't model.
 *
 * - **Interactions handed off to ledric's own consent UI** at
 *   `/oauth/consent/:uid`. The library doesn't render anything when
 *   `devInteractions: false`.
 */
export function buildProvider(
  storage: LedricStorage,
  opts: BuildProviderOptions
): Provider {
  const accessTokenTtl = opts.accessTokenTtlSeconds ?? 3600;
  const refreshTokenTtl = opts.refreshTokenTtlSeconds ?? 30 * 24 * 3600;

  const findAccount: FindAccount = async (
    _ctx: KoaContextWithOIDC,
    sub: string
  ): Promise<Account | undefined> => {
    if (sub !== 'operator') return undefined;
    return {
      accountId: 'operator',
      async claims() {
        return { sub: 'operator' };
      }
    };
  };

  const config: Configuration = {
    adapter: KyselyOidcAdapter.factory(storage),
    clients: [],
    // S256 is the only PKCE method in v9 — `methods` config field is gone.
    pkce: { required: () => true },
    scopes: ['ledric:read', 'ledric:write'],
    features: {
      registration: { enabled: opts.dcr !== false, initialAccessToken: false },
      registrationManagement: { enabled: false },
      revocation: { enabled: true },
      introspection: { enabled: true },
      jwtUserinfo: { enabled: false },
      userinfo: { enabled: false },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => `${opts.issuer}/mcp`,
        getResourceServerInfo: () => ({
          scope: 'ledric:read ledric:write',
          accessTokenFormat: 'jwt',
          // RS256 stays in sync with the development-mode auto-generated
          // signing keys oidc-provider mints on first boot. (To swap to
          // EdDSA we'd persist our own JWKS via the adapter — out of
          // scope here; RS256 is fine for the resource-server claim.)
          jwt: { sign: { alg: 'RS256' } }
        })
      },
      devInteractions: { enabled: false }
    },
    ttl: {
      AccessToken: accessTokenTtl,
      AuthorizationCode: 60,
      RefreshToken: refreshTokenTtl,
      Session: 7 * 24 * 3600,
      Interaction: 600,
      Grant: refreshTokenTtl,
      // We don't issue ID tokens (no openid scope, userinfo disabled),
      // but oidc-provider still resolves ttl.IdToken at config time
      // and logs a NOTICE if the default placeholder fires. Set a
      // value to silence it — never actually used.
      IdToken: 3600
    },
    // claude.ai (and other browser-launched connector setups) make
    // CORS requests against the OAuth endpoints. The default returns
    // false, which logs a "default clientBasedCORS function called"
    // NOTICE on every browser hit. Allow CORS for any registered
    // client — security still gates on PKCE + admin-key consent +
    // audience-bound JWTs. (The outer @fastify/cors plugin already
    // adds wire-level Access-Control-* headers; this just silences
    // the NOTICE and keeps oidc-provider's view of CORS coherent.)
    clientBasedCORS: () => true,
    // Always mint refresh tokens for confirmed grants — resource-server
    // JWTs are short-lived and clients need a way to extend their
    // session without re-prompting for consent.
    issueRefreshToken: async (_ctx, _client, code) =>
      code.scopes !== undefined && code.scopes.size > 0,
    findAccount,
    // Persistent signing keys (when supplied — see @ledric/oauth's
    // `loadOrCreateSigningKey`). Without this, oidc-provider mints
    // dev-mode keys at boot and prints "quick start development-only
    // signing keys are used". JWTs signed by those keys don't survive
    // a restart, so claude.ai connectors silently break.
    ...(opts.jwks !== undefined ? { jwks: opts.jwks } : {}),
    interactions: {
      url: (_ctx, interaction) => `/oauth/consent/${interaction.uid}`
    },
    claims: {
      'ledric:read': [],
      'ledric:write': []
    },
    routes: {
      // Keep the public surface under /oauth/* for clarity. Discovery
      // metadata advertises these so clients pick them up automatically.
      authorization: '/oauth/authorize',
      token: '/oauth/token',
      registration: '/oauth/register',
      revocation: '/oauth/revoke',
      introspection: '/oauth/introspection',
      jwks: '/oauth/jwks',
      end_session: '/oauth/session/end',
      pushed_authorization_request: '/oauth/par',
      backchannel_authentication: '/oauth/backchannel',
      device_authorization: '/oauth/device',
      code_verification: '/oauth/device/verify'
    }
  };

  const provider = new Provider(opts.issuer, config);
  // We're behind a reverse proxy in production. Trust X-Forwarded-*
  // so the library generates the right absolute URLs in metadata.
  provider.proxy = true;
  return provider;
}

export { KyselyOidcAdapter, reapExpiredOidcPayloads } from './adapter.js';
