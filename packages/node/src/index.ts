/**
 * Public surface — what a **distributor's backend** integrates against.
 *
 * This package holds the Circle API key. Nothing here belongs in front-end
 * code: the browser half is `@circle-fin/daa-web-sdk`, which never holds a
 * credential.
 */

export { createDaaClient } from './client.js'
export type { DaaClient, PasskeysApi } from './client.js'
export { DAA_ENVIRONMENTS } from './config.js'
export type { DaaEnvironment, DaaSdkConfig } from './config.js'
export {
  DAA_ERROR_CODES,
  DaaApiError,
  DaaTransportError,
  isDaaApiError,
  isDaaTransportError,
} from './errors.js'
export { createFetchTransport } from './transport.js'
export type { DaaRequest, DaaResponse, DaaTransport } from './transport.js'
export { SCA_HEADERS } from './passkeys.js'
export type {
  ChallengeOpened,
  CompleteRegistrationRequest,
  CreateRegistrationRequest,
  ListPasskeysQuery,
  OpenChallengeRequest,
  PasskeyCreated,
  PasskeyView,
  RegistrationCreated,
  RevokePasskeyQuery,
} from './passkeys.js'
