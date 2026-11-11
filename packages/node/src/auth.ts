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
 * Request and result types for the three login relay routes under
 * `/v1/accounts/auth`.
 *
 * These routes are an **opaque relay**. The browser (or app) builds each request
 * body, your backend forwards it, and what comes back goes to the browser
 * unchanged. This package deliberately does not model the bodies: the second
 * proof on the registration route is a signature over the exact bytes of the
 * body, so a backend that parses and re-serializes it would invalidate the
 * proof, and one that edits it would be changing what the user signed.
 */

/**
 * The headers the device-registration route reads.
 *
 * Both carry a compact JWS over the exact request body. Named here so that a
 * typo in one does not turn into a `401` that does not say "header".
 */
export const AUTH_HEADERS = {
  /** Proof from the ephemeral key the client prepared before the provider login. */
  registrationFlowAuthorization: 'X-Registration-Flow-Authorization',
  /** Proof from the device key being registered. */
  deviceAuthorization: 'X-Device-Authorization',
} as const

/**
 * What a relay call returns: the success status and the response body exactly
 * as it arrived, ready to hand back to the client.
 *
 * Failures are not returned. They throw `DaaApiError`, which carries the same
 * `status` and `rawBody` for the same purpose.
 */
export interface AuthRelayResult {
  readonly status: number
  /** The JSON text of the response, unmodified. */
  readonly rawBody: string
}

export interface RegisterDeviceKeyHeaders {
  /** Value of `X-Registration-Flow-Authorization`, relayed unchanged. */
  readonly registrationFlowAuthorization: string
  /** Value of `X-Device-Authorization`, relayed unchanged. */
  readonly deviceAuthorization?: string | undefined
}
