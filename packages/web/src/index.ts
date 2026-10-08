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
 * Public surface — what a **distributor** integrates against.
 *
 * Kept deliberately small. Everything a distributor needs to run a ceremony
 * and handle its outcome is here, and nothing else is: the `postMessage`
 * envelope, its reader, and the config normalizer are all machinery this SDK
 * runs on the distributor's behalf, and exporting them here would invite a
 * distributor to do the ceremony's job themselves — which is precisely what
 * the trust boundary exists to prevent.
 *
 * The envelope is published separately under `./protocol`, because the Circle
 * ceremony app is the other half of that contract and lives in another
 * repository.
 *
 * The test double ships under `./testing`, not here: it exposes the browser
 * seam that `createScaClient` deliberately does not, so keeping it out of `.`
 * means the main entry carries only the supported interfaces and a production
 * bundle cannot pick up test machinery by accident.
 */

import type { ScaSdkConfig } from './config.js'
import type { ScaClient } from './clientTypes.js'
import { createClientWithHost } from './internal/createClient.js'

export { DAA_ENVIRONMENTS } from './config.js'
export type { DaaEnvironment, Presentation, ScaSdkConfig } from './config.js'
export type {
  AuthenticationResponseJson,
  RegistrationResponseJson,
  ScaCapabilities,
  ScaCeremonyOptions,
  ScaClient,
} from './clientTypes.js'
export { isScaError, ScaError } from './errors.js'
export type { ScaErrorCode } from './errors.js'

/**
 * Builds a client bound to a distributor's Circle origin.
 *
 * There is no seam parameter. The browser host is always the real DOM one:
 * a distributor-supplied host would bypass the checks that host performs
 * (`container instanceof HTMLElement`, and the `isSource` identity comparison
 * that stops a different frame on the Circle origin from answering), and
 * those checks are load-bearing rather than conveniences. Tests reach the
 * seam through `createScaClientForTesting` in the `./testing` subpath, which
 * is testing-only and unsupported in production — a supported-API boundary,
 * not one that stops anyone who wants around it.
 *
 * Throws on a malformed `circleOrigin` at construction rather than
 * mid-ceremony.
 */
export const createScaClient = (config: ScaSdkConfig): ScaClient => createClientWithHost(config)
