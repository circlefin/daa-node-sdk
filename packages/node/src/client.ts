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

import { AUTH_HEADERS } from './auth.js'
import type { AuthRelayResult, RegisterDeviceKeyHeaders } from './auth.js'
import { resolveBaseUrl, resolveTimeoutMs } from './config.js'
import type { DaaSdkConfig } from './config.js'
import { DaaApiError, isDaaApiError } from './errors.js'
import type {
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
} from './passkeys.js'
import type { DaaRequest, DaaResponse } from './transport.js'
import { createFetchTransport } from './transport.js'

export interface PasskeysApi {
  /**
   * Opens an enrollment ceremony. Hand `frameToken` to the browser, and for a
   * passkey Owner `registrationId` too, but nothing else.
   */
  createRegistration(request: CreateRegistrationRequest): Promise<RegistrationCreated>
  /** Completes the ceremony with the browser's attestation, relayed verbatim. */
  complete(request: CompleteRegistrationRequest): Promise<PasskeyCreated>
  /** Lists an end user's credentials, revoked ones included with `revokedDate` set. */
  list(query: ListPasskeysQuery): Promise<readonly PasskeyView[]>
  /**
   * The same request as {@link list}, also returning whether Circle requires SCA
   * for the end user. `sca` is `null` when that is unknown.
   */
  status(query: ListPasskeysQuery): Promise<PasskeyStatus>
  /** Revokes a credential. Soft — nothing is deleted. */
  revoke(passkeyId: string, query: RevokePasskeyQuery): Promise<void>
  /**
   * Opens an intent-bound step-up ceremony. Hand `frameToken` to the browser, and
   * for a passkey Owner `challengeId` too, but never the summary or credentials.
   */
  openChallenge(request: OpenChallengeRequest): Promise<ChallengeOpened>
}

export interface AuthApi {
  /**
   * Starts a social login. Relays the client's request body unchanged.
   *
   * `rawBody` is the JSON text the client produced. It is sent byte for byte.
   */
  prepareLogin(rawBody: string): Promise<AuthRelayResult>
  /** Completes a social login with the provider's result. Relays `rawBody` unchanged. */
  socialSession(rawBody: string): Promise<AuthRelayResult>
  /**
   * Registers the device key. Relays `rawBody` and both proofs unchanged.
   *
   * Each proof is a signature over the exact bytes of `rawBody`, so pass the
   * string the client sent rather than one you parsed and serialized again.
   */
  registerDeviceKey(rawBody: string, headers: RegisterDeviceKeyHeaders): Promise<AuthRelayResult>
}

export interface DaaClient {
  readonly passkeys: PasskeysApi
  readonly auth: AuthApi
}

/**
 * Public route prefix.
 *
 * `/v1/accounts/passkeys`, **not** `/v1/daa/accounts/passkeys`. The latter is
 * DAA's own service path; the API gateway exposes this group and rewrites only
 * the path. Getting this wrong produces a 404 that looks like a missing
 * feature.
 */
const PASSKEYS = '/v1/accounts/passkeys'

/** Public route prefix for the login relay routes. Same gateway rewrite as {@link PASSKEYS}. */
const AUTH = '/v1/accounts/auth'

const requireNonEmpty = (value: string, field: string): string => {
  if (value.length === 0) throw new TypeError(`${field} must not be empty`)
  return value
}

// A compact JWS: three base64url segments. Checked for shape only, because the
// length limits and the signature are DAA's to enforce, and a header value with
// whitespace or a line break is one the transport would reject anyway.
const requireCompactJws = (value: string, field: string): string => {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
  ) {
    throw new TypeError(`${field} must be a compact JWS`)
  }
  return value
}

const requireRawBody = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('rawBody must be a non-empty string')
  }
  return value
}

const requireOpaqueId = (value: string, field: string): string => {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new TypeError(`${field} must be 1–128 letters, digits, underscores, or hyphens`)
  }
  return value
}

/**
 * Reads Circle's error envelope without insisting on it.
 *
 * The envelope is flat and its `code` is an integer — `{"code": 420054,
 * "message": "…"}`. There is no nested
 * `error` object on this path; an earlier revision here read one, which was a
 * tolerance for a shape that does not exist.
 *
 * Tolerant about the body not being an envelope at all, though: a 502 from an
 * edge proxy is an HTML page, and that is precisely when the caller needs to
 * see what arrived rather than a parse failure. `rawBody` is always carried on
 * the error for that reason.
 */
const toApiError = (status: number, rawBody: string): DaaApiError => {
  let code: number | undefined
  let message: string | undefined
  try {
    const parsed: unknown = JSON.parse(rawBody)
    if (typeof parsed === 'object' && parsed !== null) {
      const envelope = parsed as Record<string, unknown>
      if (typeof envelope.code === 'number') code = envelope.code
      if (typeof envelope.message === 'string') message = envelope.message
    }
  } catch {
    // Not JSON. `rawBody` carries whatever it was.
  }
  return new DaaApiError({ status, rawBody, code, message })
}

export const createDaaClient = (config: DaaSdkConfig): DaaClient => {
  // Validated eagerly: a bad base URL or an empty key should fail where it was
  // configured, not on the first call in a request handler.
  const baseUrl = resolveBaseUrl(config)
  const apiKey = requireNonEmpty(config.apiKey, 'apiKey')
  // `resolveTimeoutMs` only runs when it will be used: a caller supplying
  // both a custom `transport` and an out-of-range `timeoutMs` should not fail
  // construction over a value the custom transport ignores.
  const transport =
    config.transport ?? createFetchTransport(globalThis.fetch, resolveTimeoutMs(config))

  type CallRequest = Omit<DaaRequest, 'headers'> & {
    readonly headers?: Readonly<Record<string, string>>
  }

  /** Sends one request and throws `DaaApiError` for any non-2xx. */
  const call = async (request: CallRequest): Promise<DaaResponse> => {
    const response = await transport({
      ...request,
      headers: {
        // Per-call headers come only from the fixed names in `AUTH_HEADERS`, and
        // none of them is one of the three set below. They come first anyway, so a
        // future caller's collision loses to the credential rather than beating it.
        // Note that `fetch` merges two casings of one name, so keep names distinct.
        ...request.headers,
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        ...(request.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
    })

    if (response.status < 200 || response.status >= 300) {
      throw toApiError(response.status, response.body)
    }
    return response
  }

  const send = async <T>(
    request: CallRequest,
  ): Promise<{
    readonly status: number
    /** The response body as it arrived, for any error raised downstream. */
    readonly rawBody: string
    readonly value: T | undefined
  }> => {
    const response = await call(request)
    if (response.body.length === 0)
      return { status: response.status, rawBody: response.body, value: undefined }
    try {
      // Every successful Circle response is wrapped: `{"data": {...}}`. Errors
      // are not — they are flat `{"code": N, "message": "..."}`, which is why
      // `toApiError` reads the body directly. Both verified against a
      // Circle test environment.
      //
      // Unwrapped strictly rather than tolerantly. An earlier version of this
      // method returned `JSON.parse(body)` as the payload, so every response
      // type in this package was off by one level — `frameToken` came back
      // `undefined` and `list()` returned `undefined` from a function typed as
      // an array. Forty unit tests passed, because the fake transport was fed
      // unwrapped bodies: the tests encoded the same wrong assumption as the
      // code. Accepting an unwrapped body here would let that come back.
      const parsed: unknown = JSON.parse(response.body)
      // `'data' in parsed` alone is not enough: it is true for
      // `{"data": null}`, and returning that as `T` puts the raw `TypeError`
      // this method exists to prevent straight back — `list()` reading
      // `.passkeys` off `null`, before its own guard runs. The value has to be
      // there, not merely the key.
      const envelope =
        typeof parsed === 'object' && parsed !== null && 'data' in parsed ? parsed.data : undefined
      if (envelope === undefined || envelope === null) {
        throw new DaaApiError({
          status: response.status,
          rawBody: response.body,
          message: `${request.method} ${request.url} returned ${String(
            response.status,
          )} without a "data" payload; every Circle success response carries one`,
        })
      }
      return { status: response.status, rawBody: response.body, value: envelope as T }
    } catch (cause) {
      // A 2xx carrying a body that is not JSON is still a failure, and it has
      // to arrive as one of the two documented types. A raw `SyntaxError`
      // escaping here would be an exception a caller branching on
      // `isDaaApiError` / `isDaaTransportError` has no way to classify — which
      // is the guarantee this package's README sells.
      // Our own envelope error passes through; only a genuine parse failure
      // is reported as one.
      if (isDaaApiError(cause)) throw cause
      throw new DaaApiError({
        status: response.status,
        rawBody: response.body,
        message: `${request.method} ${request.url} returned ${String(
          response.status,
        )} with a body that is not JSON`,
        cause,
      })
    }
  }

  /** `requireBody` for the three callers that only need the payload. */
  const requireBodyValue = async <T>(request: Omit<DaaRequest, 'headers'>): Promise<T> =>
    (await requireBody<T>(request)).value

  /** `send`, for the four routes where an empty body would be a server bug. */
  const requireBody = async <T>(
    request: CallRequest,
  ): Promise<{ readonly status: number; readonly rawBody: string; readonly value: T }> => {
    const { status, rawBody, value } = await send<T>(request)
    if (value === undefined) {
      // `rawBody`, not `''`. It happens to be empty on the only path that
      // reaches here, which is exactly why writing the literal was tempting —
      // and exactly the reasoning that made a hardcoded `status: 200` wrong
      // twice in this file. An error should quote the response, not a value
      // that is equal to it today.
      throw new DaaApiError({
        status,
        rawBody,
        message: `${request.method} ${request.url} succeeded with an empty body, which this route should never return`,
      })
    }
    return { status, rawBody, value }
  }

  const query = (params: Readonly<Record<string, string>>): string =>
    `?${new URLSearchParams(params).toString()}`

  // One GET serves both list() and status(): the response carries both.
  const readPasskeys = async (q: ListPasskeysQuery): Promise<PasskeyStatus> => {
    const url = `${baseUrl}${PASSKEYS}${query({ clientEntityId: q.clientEntityId })}`
    const {
      status,
      rawBody,
      value: body,
    } = await requireBody<{
      readonly passkeys?: unknown
      readonly sca?: unknown
    }>({ method: 'GET', url })
    // Checked rather than trusted. list() promises an array, and
    // the version that returned `body.passkeys` unchecked handed callers
    // `undefined` from it — a `TypeError` at their call site, nowhere near
    // the response that caused it.
    //
    // `passkeys` is typed `unknown` above so the check is the only way to
    // get past it; declaring it as the array type and then testing it
    // would be asserting what is being verified. The cast afterwards is
    // where this package stops validating: that it *is* an array is
    // checked, what the elements look like is DAA's contract — the same
    // line `code` and `operation` draw.
    if (!Array.isArray(body.passkeys)) {
      // The status and body it actually arrived with. Reconstructing
      // either would point a reader at something the server never sent —
      // the same mistake a hardcoded `200` made two commits ago.
      throw new DaaApiError({
        status,
        rawBody,
        message: `GET ${url} succeeded without a "passkeys" array`,
      })
    }
    return { sca: scaRequirement(body.sca), passkeys: body.passkeys as readonly PasskeyView[] }
  }

  // `rawBody` goes to the transport as given: it is not parsed, trimmed or
  // re-serialized, because the proofs on these routes sign its exact bytes.
  //
  // The response is relayed the same way. Only the status is checked, and the
  // body comes back as it arrived, so a 2xx is never turned into an error by
  // its shape: the request has already been applied, and a thrown error would
  // invite a retry of a flow that cannot be repeated.
  const relay = async (
    path: string,
    rawBody: string,
    headers?: Readonly<Record<string, string>>,
  ): Promise<AuthRelayResult> => {
    const response = await call({
      method: 'POST',
      url: `${baseUrl}${path}`,
      body: requireRawBody(rawBody),
      ...(headers === undefined ? {} : { headers }),
    })
    return { status: response.status, rawBody: response.body }
  }

  return {
    passkeys: {
      createRegistration: (request) =>
        requireBodyValue<RegistrationCreated>({
          method: 'POST',
          url: `${baseUrl}${PASSKEYS}/registrations`,
          body: JSON.stringify(request),
        }),

      complete: (request) =>
        requireBodyValue<PasskeyCreated>({
          method: 'POST',
          url: `${baseUrl}${PASSKEYS}`,
          // Serialized once, straight from what the browser produced. The
          // attestation is not re-shaped on the way through.
          body: JSON.stringify(request),
        }),

      list: async (q) => (await readPasskeys(q)).passkeys,

      status: readPasskeys,

      revoke: async (passkeyId, q) => {
        await send<never>({
          method: 'DELETE',
          url: `${baseUrl}${PASSKEYS}/${encodeURIComponent(
            requireOpaqueId(passkeyId, 'passkeyId'),
          )}${query({ clientEntityId: q.clientEntityId })}`,
        })
      },

      openChallenge: (request) =>
        requireBodyValue<ChallengeOpened>({
          method: 'POST',
          url: `${baseUrl}${PASSKEYS}/challenges`,
          body: JSON.stringify(request),
        }),
    },

    auth: {
      prepareLogin: async (rawBody) => relay(`${AUTH}/loginRequests`, rawBody),

      socialSession: async (rawBody) => relay(`${AUTH}/sessions`, rawBody),

      registerDeviceKey: async (rawBody, headers) =>
        relay(`${AUTH}/deviceKeyRegistration`, rawBody, {
          [AUTH_HEADERS.registrationFlowAuthorization]: requireCompactJws(
            headers.registrationFlowAuthorization,
            'registrationFlowAuthorization',
          ),
          ...(headers.deviceAuthorization === undefined
            ? {}
            : {
                [AUTH_HEADERS.deviceAuthorization]: requireCompactJws(
                  headers.deviceAuthorization,
                  'deviceAuthorization',
                ),
              }),
        }),
    },
  }
}

/**
 * The response's `sca` member as a {@link PasskeyStatus} `sca`. Anything that is
 * not `{ required: boolean }` — absent, `null`, or malformed — reads as unknown
 * (`null`) rather than failing the call: the requirement is a hint, the
 * protected endpoint's 428 is the enforcement, and an older response that never
 * sent `sca` still lists passkeys.
 */
const scaRequirement = (sca: unknown): PasskeyStatus['sca'] =>
  typeof sca === 'object' &&
  sca !== null &&
  typeof (sca as { required?: unknown }).required === 'boolean'
    ? { required: (sca as { required: boolean }).required }
    : null
