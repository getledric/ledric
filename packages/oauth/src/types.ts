/**
 * Public types for `@ledric/oauth` consumers — the http-server and
 * /mcp middleware. Everything else is internal to the provider.
 */

/** Scopes ledric advertises. Each maps onto a single api_keys role. */
export type Scope = 'ledric:read' | 'ledric:write';

export const SCOPE_TO_ROLE: Record<Scope, 'admin' | 'reader'> = {
  'ledric:read': 'reader',
  'ledric:write': 'admin'
};

/**
 * Claims projected out of a verified OAuth access JWT. The access
 * token is signed by oidc-provider; we verify it against the issuer's
 * JWKS in the /mcp middleware. Validate `sub` is the verified subject;
 * today it's always `'operator'` (one synthetic account) but anything
 * that needs it should read it from the verified token rather than
 * hardcoding the value.
 */
export interface AccessTokenClaims {
  iss: string;
  /** Always `<issuer>/mcp` per the resourceIndicators config. */
  aud: string | readonly string[];
  /** Subject. Today: `'operator'`. Tomorrow: a user id, if ledric grows users. */
  sub: string;
  /** Scope grant — one of the ledric: scopes. Space-separated when multi. */
  scope: string;
  iat: number;
  exp: number;
}

/** RFC 9728 — protected-resource metadata, served by the resource server. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly Scope[];
  bearer_methods_supported: readonly ['header'];
}
