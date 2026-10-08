/**
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

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
  PasskeyStatus,
  PasskeyView,
  RegistrationCreated,
  RevokePasskeyQuery,
  ScaRequirement,
} from './passkeys.js'
