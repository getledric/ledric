export const PACKAGE_NAME = '@ledric/oauth';

export type { Scope, AccessTokenClaims, ProtectedResourceMetadata } from './types.js';
export { SCOPE_TO_ROLE } from './types.js';

export type { BuildProviderOptions } from './provider.js';
export { buildProvider, KyselyOidcAdapter, reapExpiredOidcPayloads } from './provider.js';

export type { ClientSummary } from './clients.js';
export { listClients, revokeClient } from './clients.js';
