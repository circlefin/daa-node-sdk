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
 * Every Circle error code the SCA surface can return.
 *
 * The name-to-number pairing comes from DAA's own error-code definitions,
 * which are the authority for it.
 *
 * Whether a number reaches you unchanged is a second question, and the answer
 * is the API gateway: **every route this package calls is proxied through it**,
 * including the ones whose codes fall outside the `420046`–`420067` SCA block.
 * It maps a downstream code to a public one from an allow-list, and a code
 * missing from that list does not arrive as itself — it arrives as `-1` with
 * a generic message. So a code named here is one Circle intends you to branch
 * on; it is not by itself a promise that the deployment you are calling is
 * already passing it through.
 *
 * The names never travel on the wire; they exist here so a caller can write
 * `error.code === DAA_ERROR_CODES.SCA_CHALLENGE_EXPIRED` instead of a bare
 * `420054`.
 *
 * Not exhaustive of what a call can return, and deliberately not a union — see
 * `DaaApiError.code`.
 */
export const DAA_ERROR_CODES = {
  // Outside the SCA block, and reachable from this package's routes anyway.
  // Both observed against a Circle test environment: `CLIENT_ENTITY_NOT_OWNED` on every
  // route that takes a `clientEntityId` — every one but `complete()` — when
  // the calling entity has no parent-entity mapping on record, and
  // `IDEMPOTENCY_KEY_REUSED` from `createRegistration` when a key comes back
  // with a different `spcCapable`, or with a different `clientEntityId` the
  // caller also owns — ownership is verified before the idempotency lookup,
  // so one it does not own returns `CLIENT_ENTITY_NOT_OWNED` instead. A
  // different `embedOrigin` is the same 409.
  //
  // Listed because a caller hits them before they hit anything in the SCA
  // block — the first is what an unmapped end user returns, which is the
  // first thing a new integration gets wrong.
  CLIENT_ENTITY_NOT_OWNED: 420001,
  IDEMPOTENCY_KEY_REUSED: 420034,

  // Raised by this package's routes. Three of the five can fail this way:
  // `complete()`, which is where an attestation is verified; `openChallenge()`;
  // and `createRegistration()`, which fails when the distributor has no SCA
  // partner origin configured — a condition `openChallenge()` reports the
  // same way. `list` and `revoke` have no SCA-block failure of their own:
  // `list` verifies ownership and nothing else, so `CLIENT_ENTITY_NOT_OWNED`
  // is the only code above it can return; `revoke` does the same and then
  // answers a plain `404` — no DAA code — for a passkey that is not there.
  // Neither performs an idempotency lookup; only `createRegistration` does.
  PASSKEY_REGISTRATION_EXPIRED: 420051, // complete()
  PASSKEY_REGISTRATION_CONSUMED: 420052, // complete()
  PASSKEY_CREDENTIAL_ALREADY_REGISTERED: 420053, // complete()
  SCA_ASSERTION_INVALID: 420046, // complete(), and the gated route below
  SCA_OPERATION_NOT_IMPLEMENTED: 420062, // openChallenge()
  // Raised by `createRegistration()` and `openChallenge()` alike, when the
  // distributor has no SCA partner origin configured — the state every
  // distributor is in until SCA onboarding finishes. Contact Circle to have
  // yours configured before opening any passkey ceremony. An `embedOrigin`
  // that matches none of your approved origins is `API_PARAMETER_INVALID`
  // (`code: 2`) instead, because that one is the request's to fix.
  SCA_ORIGIN_NOT_CONFIGURED: 420064, // createRegistration(), openChallenge()
  // `complete()` with a `registrationId` that does not exist, or that belongs
  // to another entity — deliberately indistinguishable. Answered with `404`.
  PASSKEY_REGISTRATION_NOT_FOUND: 420065, // complete()
  // An `intent` whose source or destination names a location type (a fiat
  // rail, say) that SCA does not accept. Distinct from `API_PARAMETER_INVALID`
  // so an unsupported rail is not mistaken for a malformed body.
  SCA_INTENT_LOCATION_TYPE_UNSUPPORTED: 420066, // openChallenge(), and the gated route below
  // `createRegistration()`, `complete()` and `openChallenge()`, and the gated
  // route below: a request body over the size limit (128 KiB on the passkey
  // routes) is refused with `413` before it is read.
  REQUEST_BODY_TOO_LARGE: 420067,

  // Raised by the *gated* route you call after the ceremony — one of the five
  // listed on `OpenChallengeRequest.operation` — not by anything in this
  // package. Listed because the same integration handles them.
  //
  // Everything that verifies an *assertion* lives here rather than above:
  // assertion verification runs only inside the gated route's challenge
  // validation, while `complete()` runs registration verification. That is
  // why `SCA_CEREMONY_KIND_MISMATCH` and `SCA_INTENT_MISMATCH` are
  // gated-route codes even though they read like ceremony ones.
  SCA_ASSERTION_REQUIRED: 420058,
  SCA_INTENT_MISMATCH: 420047,
  SCA_CEREMONY_KIND_MISMATCH: 420050,
  SCA_CHALLENGE_EXPIRED: 420054,
  SCA_CHALLENGE_CONSUMED: 420055,
  SCA_CHALLENGE_NOT_FOUND: 420061,
  SCA_CHALLENGE_ENTITY_MISMATCH: 420063,
  SCA_INTENT_UNRECOGNIZED: 420060,
  SCA_SCOPE_UNRESOLVED: 420059,

  // Raised by the ceremony frame's own read, which the browser SDK drives.
  CEREMONY_TOKEN_REQUIRED: 420056,
  CEREMONY_CONSUMED_OR_EXPIRED: 420057,

  // **Never reaches a caller.** Both are internal reasons only, and DAA
  // deliberately maps exactly these two to `SCA_ASSERTION_INVALID` (420046)
  // on the way out, so that the endpoint cannot be used as an oracle to
  // enumerate credentials or probe the origin allowlist. The precise reason
  // survives only in DAA's metrics and logs.
  //
  // Kept here, rather than dropped, because the useful fact is *why* they
  // never fire: an integrator who finds them in Circle's error tables would
  // otherwise write a branch that can never be taken, and an origin
  // misconfiguration is genuinely indistinguishable from a bad assertion by
  // design. Do not branch on either.
  SCA_CREDENTIAL_NOT_FOUND: 420048,
  SCA_ORIGIN_NOT_ALLOWED: 420049,
} as const

/**
 * A non-2xx response from the DAA API.
 *
 * Carries the HTTP status and, when the response body parsed as Circle's error
 * envelope, its `code` and `message`.
 *
 * `code` is Circle's **numeric** public error code — `420054`, not
 * `"SCA_CHALLENGE_EXPIRED"`. The string names are server-side only;
 * The API gateway translates them to numbers on the way out, so a string never
 * reaches a distributor. `DAA_ERROR_CODES` above maps
 * the names to the numbers.
 *
 * Two values are worth special-casing:
 *
 * - `-1` means the API gateway did not recognize what the upstream service
 *   returned. The `message` then carries an `errId` — that is the identifier
 *   Circle support needs, and it is the reason `rawBody` is always kept.
 * - `undefined` means the body carried no numeric `code` at all, which is what
 *   a 502 HTML page from an edge proxy looks like.
 *
 * Deliberately **not** narrowed to a union: Circle can add a code without this
 * SDK being republished, and a caller matching on an unknown number is better
 * than one that cannot see it at all.
 *
 * `rawBody` is always present, because a body that did not parse is exactly the
 * case where a caller needs to see what actually arrived.
 */
export class DaaApiError extends Error {
  readonly status: number
  readonly code: number | undefined
  readonly rawBody: string

  constructor(args: {
    status: number
    rawBody: string
    code?: number | undefined
    message?: string | undefined
    cause?: unknown
  }) {
    super(args.message ?? `DAA API responded ${String(args.status)}`, { cause: args.cause })
    this.name = 'DaaApiError'
    this.status = args.status
    this.rawBody = args.rawBody
    this.code = args.code
  }
}

export const isDaaApiError = (value: unknown): value is DaaApiError => value instanceof DaaApiError

/**
 * Raised when the transport itself failed — DNS, TLS, a timeout, a socket
 * reset. The request may or may not have been applied. Retry only when that
 * route's contract makes it safe; this error alone does not imply that an
 * idempotency key is available.
 */
export class DaaTransportError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DaaTransportError'
  }
}

export const isDaaTransportError = (value: unknown): value is DaaTransportError =>
  value instanceof DaaTransportError
