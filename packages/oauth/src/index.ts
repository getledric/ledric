export const PACKAGE_NAME = '@ledric/oauth';

export type {
  Scope,
  OAuthClientInfo,
  RegisterClientInput,
  AuthCodeMintInput,
  AuthCodeMintResult,
  AuthCodeExchangeInput,
  TokenPair,
  AccessTokenClaims,
  AuthorizationServerMetadata,
  ProtectedResourceMetadata
} from './types.js';
export { SCOPE_TO_ROLE } from './types.js';

export type { SigningKeys } from './keys.js';
export { loadOrGenerateSigningKeys } from './keys.js';

export { sha256, randomToken, pkceS256, timingSafeEqual } from './hash.js';

export type { RegisterClientResult } from './clients.js';
export {
  registerClient,
  getClient,
  listClients,
  revokeClient,
  RegisterClientError
} from './clients.js';

export type {
  TokenIssuerOptions,
  MintTokensInput,
  StoredRefreshToken
} from './tokens.js';
export {
  mintTokens,
  verifyAccessToken,
  findRefreshToken,
  revokeRefreshToken,
  revokeLineage
} from './tokens.js';

export type {
  ConsumeAuthCodeInput,
  ConsumedAuthCode,
  MintAuthCodeResult
} from './codes.js';
export { mintAuthCode, consumeAuthCode, AuthCodeError } from './codes.js';
