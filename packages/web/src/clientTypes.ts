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
 * The shapes `createScaClient` returns and accepts.
 *
 * Split out of `index.ts` only to break a cycle: the factory lives under
 * `internal/` so the browser seam is not reachable from the public entry, and
 * it needs these types. They are re-exported from `index.ts`, which remains
 * the documented place to import them from.
 */

import type { Presentation } from './config.js'

/**
 * The browser's `RegistrationResponseJSON`, as the ceremony frame produced it.
 *
 * Structurally typed only as far as the fields DAA actually reads, and left
 * open: the SDK is a relay. `transports` sits on `response`, not on the
 * envelope, which is the browser's real shape rather than the intuitive one.
 *
 * Pass this to `POST /v1/accounts/passkeys` as `attestationResponse`
 * **without reshaping it**.
 */
export interface RegistrationResponseJson {
  readonly id: string
  readonly rawId: string
  readonly type: string
  readonly response: {
    readonly clientDataJSON: string
    readonly attestationObject: string
    readonly transports?: readonly string[]
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

/**
 * The browser's `AuthenticationResponseJSON`, as the ceremony frame produced
 * it — the step-up counterpart of `RegistrationResponseJson`.
 *
 * Structurally typed only as far as DAA actually reads, and left open, for
 * the same reason: the SDK is a relay.
 *
 * `approve()` returns this **already serialized**, because the header needs
 * text and this is the shape inside it. Exported so a caller who wants to
 * read a field can `JSON.parse` and have a type for the result.
 *
 * Every value below is already base64url and must travel byte-identical — the
 * signature covers them. Serializing the *envelope* around them is safe, and
 * DAA says so itself: "this outer envelope's JSON formatting carries no
 * cryptographic weight — only the base64url fields it carries do".
 */
export interface AuthenticationResponseJson {
  readonly id: string
  readonly rawId: string
  readonly type: string
  readonly response: {
    readonly clientDataJSON: string
    readonly authenticatorData: string
    readonly signature: string
    /** Present when the authenticator returned one; absent is normal. */
    readonly userHandle?: string
    readonly [key: string]: unknown
  }
  readonly [key: string]: unknown
}

export interface ScaCapabilities {
  readonly protocolVersion: number
  /** Whether a Circle ceremony frame can be mounted in this environment. */
  readonly frame: boolean
  /**
   * Secure Payment Confirmation support.
   *
   * `'unknown'` until detection ships — reported honestly rather than as
   * `false`, because "we did not look" and "the browser cannot" lead a
   * distributor to different decisions.
   */
  readonly securePaymentConfirmation: 'unknown'
}

/**
 * Options accepted by `enroll` and `approve`.
 */
export interface ScaCeremonyOptions {
  /**
   * An `AbortSignal` that cancels the ceremony when aborted.
   *
   * On abort, the SDK immediately destroys the ceremony iframe and rejects the
   * returned promise with `code: 'Cancelled'`, unless the frame already reported
   * an error. In that case, the first frame error is returned. Use an
   * `AbortController` to wire this up, for example from a modal close button
   * or your own timeout:
   *
   * ```ts
   * const controller = new AbortController()
   * onModalClose(() => controller.abort())
   * try {
   *   const result = await sca.enroll(token, presentation, { signal: controller.signal })
   * } catch (err) {
   *   if (isScaError(err) && err.code === 'Cancelled') return // user closed
   * }
   * ```
   */
  readonly signal?: AbortSignal
}

export interface ScaClient {
  /**
   * Runs a passkey **registration** ceremony.
   *
   * @param frameToken - the opaque token from
   *   `POST /v1/accounts/passkeys/registrations`. Treat it as a secret in
   *   transit; it grants a read of exactly one pending ceremony.
   *
   *   **Or a promise of it — and on WebKit, pass the promise.** Safari, and
   *   every browser on iOS and iPadOS, will not register a passkey inside a
   *   cross-origin frame, so there `enroll` runs the ceremony in a Circle
   *   window instead and `presentation` draws nothing. That window can only
   *   be opened during the user's click, which a `fetch` for the token uses
   *   up. So call `enroll` synchronously from the click handler, and let the
   *   SDK wait for the token:
   *
   *   ```ts
   *   button.onclick = () => {
   *     const frameToken = fetch('/api/passkeys/start', { method: 'POST' })
   *       .then((res) => res.json())
   *       .then((body) => body.frameToken)
   *     void sca.enroll(frameToken, { mode: 'modal' }).then(complete, handle)
   *   }
   *   ```
   *
   *   Called after an `await` instead, the window is blocked and `enroll`
   *   rejects `Unsupported`. A rejected promise is rethrown as-is. The page
   *   must not send `Cross-Origin-Opener-Policy: same-origin`, which severs
   *   the window from the page that opened it; `same-origin-allow-popups`
   *   is fine.
   * @returns the browser's `RegistrationResponseJSON`, verbatim. Send it to
   *   `POST /v1/accounts/passkeys` as `attestationResponse` **from the
   *   distributor's backend** — the browser never holds the entity API key.
   *
   *   Note the path carries no `daa` segment. `/v1/accounts/passkeys/*` is the
   *   public surface, served by the API gateway; `/v1/daa/*` is DAA's internal
   *   path and not something a distributor calls.
   */
  enroll(
    frameToken: string | PromiseLike<string>,
    presentation: Presentation,
    options?: ScaCeremonyOptions,
  ): Promise<RegistrationResponseJson>

  /**
   * Runs an intent-bound **step-up** ceremony.
   *
   * @param frameToken - the opaque token from
   *   `POST /v1/accounts/passkeys/challenges`. Same capability semantics as
   *   `enroll`'s: treat it as a secret in transit, and hand the browser
   *   nothing else from that response — not `challengeId`, and in particular
   *   not `summary`, which is server-authored copy for your records. The
   *   frame fetches the copy the user approves independently, which is what
   *   stops a distributor rendering its own pre-confirmation.
   *
   *   **Or a promise of it — and on WebKit, pass the promise**, exactly as
   *   for `enroll`. There the step-up runs in a Circle window too: WebKit
   *   completes it in a frame but omits `topOrigin` from the signed client
   *   data, and DAA rejects a cross-origin assertion that cannot prove which
   *   page embedded it. The same rules follow — call `approve` synchronously
   *   from the click handler, and do not send
   *   `Cross-Origin-Opener-Policy: same-origin`.
   * @returns the value of the `X-Sca-Assertion` header, ready to send — the
   *   browser's `AuthenticationResponseJSON` serialized as raw JSON text. See
   *   `AuthenticationResponseJson` for what is inside it.
   *
   *   A `string` rather than the object, which is the one place this method is
   *   deliberately asymmetric with `enroll`. The asymmetry is in the wire, not
   *   here: an attestation goes into a JSON **body** as an object, an
   *   assertion goes into a **header** as text. Each method returns what its
   *   destination takes.
   *
   *   It also removes the failure DAA documents by name. Base64url of this
   *   JSON — an encoding a distributor could reasonably expect — is rejected with
   *   `"assertion is not valid strict JSON"`, and a method returning an object
   *   leaves every distributor to encode it and one of them to encode it that
   *   way.
   *
   *   Then **resend the gated request yourself**, from your own backend, with
   *   two headers:
   *
   *   - `X-Sca-Challenge-Id`: the `challengeId` from the same response
   *   - `X-Sca-Assertion`: this value, unmodified
   *
   *   There is no `approve`-shaped call on the server SDK on purpose: the
   *   gated request is yours, on your own route, with your own client. This
   *   SDK does not proxy it.
   */
  approve(
    frameToken: string | PromiseLike<string>,
    presentation: Presentation,
    options?: ScaCeremonyOptions,
  ): Promise<string>

  capabilities(): ScaCapabilities
}
