/**
 * OAuth 2.1 provider types — what clients see on the wire, plus a few
 * internal projections shared between provider methods.
 */

/** Scopes ledric advertises. Each maps onto a single api_keys role. */
export type Scope = 'ledric:read' | 'ledric:write';

export const SCOPE_TO_ROLE: Record<Scope, 'admin' | 'reader'> = {
  'ledric:read': 'reader',
  'ledric:write': 'admin'
};

/**
 * Public-facing client record. Excludes hashes / secrets.
 */
export interface OAuthClientInfo {
  /** The string consumers send as `client_id`. */
  client_id: string;
  /** DCR-supplied display name. UNTRUSTED — pair with client_id on UIs. */
  name: string;
  /** Pre-registered redirect URIs (parsed from JSON). */
  redirect_uris: string[];
  created_at: number;
  /** Non-null if the client has been revoked; client may not exchange codes. */
  revoked_at: number | null;
}

export interface RegisterClientInput {
  /**
   * Client-supplied name. Stored verbatim, surfaced on the consent UI
   * with a "claimed name — verify the client_id below" framing.
   */
  name: string;
  redirect_uris: readonly string[];
  /**
   * Optional list of allowed redirect-uri hostnames. Used at registration
   * time to reject DCR requests pointing at unrelated domains.
   */
  allowed_redirect_hosts?: readonly string[];
}

export interface AuthCodeMintInput {
  client_id: string;
  redirect_uri: string;
  /** PKCE code_challenge (S256, base64url, no padding). */
  code_challenge: string;
  scope: Scope;
  /** Lifetime in seconds. Default: 600 (10 minutes). */
  ttl_seconds?: number;
}

export interface AuthCodeMintResult {
  /** Plaintext code returned to the client (only ever shown once). */
  code: string;
  expires_at: number;
}

export interface AuthCodeExchangeInput {
  code: string;
  client_id: string;
  redirect_uri: string;
  code_verifier: string;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
  /** Seconds until the access token expires. */
  expires_in: number;
  scope: Scope;
  token_type: 'Bearer';
}

export interface AccessTokenClaims {
  /** Issuer — `publicUrl` configured on this ledric. */
  iss: string;
  /** Audience — fixed string `ledric-mcp`. */
  aud: string;
  /** Subject — the OAuth client_id. */
  sub: string;
  /** Granted scope. */
  scope: Scope;
  /** Issued-at timestamp (seconds since epoch). */
  iat: number;
  /** Expiration timestamp (seconds since epoch). */
  exp: number;
}

/** RFC 8414 discovery metadata shape. */
export interface AuthorizationServerMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  revocation_endpoint: string;
  jwks_uri: string;
  scopes_supported: readonly Scope[];
  response_types_supported: readonly ['code'];
  grant_types_supported: readonly ['authorization_code', 'refresh_token'];
  code_challenge_methods_supported: readonly ['S256'];
  token_endpoint_auth_methods_supported: readonly ['client_secret_basic', 'none'];
}

/** Per the MCP authorization spec — points discovering clients here first. */
export interface ProtectedResourceMetadata {
  resource: string;
  authorization_servers: readonly string[];
  scopes_supported: readonly Scope[];
  bearer_methods_supported: readonly ['header'];
}
