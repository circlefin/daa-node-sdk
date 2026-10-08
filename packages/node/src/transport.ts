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

import { DaaTransportError } from './errors.js'
import { DEFAULT_TIMEOUT_MS, validateTimeoutMs } from './config.js'

/**
 * How a request reaches DAA.
 *
 * Injected rather than fixed. That buys three things that matter specifically
 * to a server-side client:
 *
 * 1. **mTLS without a dependency.** `/v1/accounts/passkeys` accepts a bearer
 *    API key over plain HTTPS until an entity is configured to require mTLS —
 *    at which point Cloudflare's edge requires a client certificate. Node's
 *    global `fetch` cannot be given one without reaching for `undici`'s
 *    `Agent`, so rather than take that
 *    dependency for a case most callers do not have, an entity that needs mTLS
 *    supplies a transport configured however its deployment already does TLS.
 * 2. **Testable without a network.** Every test in this package drives a fake.
 * 3. A caller that injects a transport keeps control of its retry, timeout
 *    and observability policy. The default fetch transport has a finite
 *    timeout; retry safety remains specific to each route.
 */
export type DaaTransport = (request: DaaRequest) => Promise<DaaResponse>

export interface DaaRequest {
  readonly method: 'GET' | 'POST' | 'DELETE'
  /** Absolute URL, query string included. */
  readonly url: string
  readonly headers: Readonly<Record<string, string>>
  /** JSON text, or absent for GET and DELETE. */
  readonly body?: string
}

export interface DaaResponse {
  readonly status: number
  /** Response body as text. Parsed by the caller, so a non-JSON error page is still visible. */
  readonly body: string
}

/**
 * Default transport over Node's global `fetch` (built in from Node 18).
 *
 * Suitable for any entity not flagged `mtls_required`. Supply your own
 * transport for one that is.
 */
export const createFetchTransport = (
  fetchImpl: typeof fetch = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): DaaTransport => {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError(
      'No global fetch available. Node 18+ provides one; otherwise pass a transport explicitly.',
    )
  }
  const requestTimeoutMs = validateTimeoutMs(timeoutMs)

  return async (request) => {
    let response: Response
    try {
      response = await fetchImpl(request.url, {
        method: request.method,
        headers: { ...request.headers },
        signal: AbortSignal.timeout(requestTimeoutMs),
        ...(request.body === undefined ? {} : { body: request.body }),
      })
    } catch (cause) {
      // Nothing reached DAA, so the request may or may not have been applied.
      // Surfaced as its own type because the request may have been applied.
      // Retry safety depends on the route's contract; a transport failure does
      // not imply that every method accepts an idempotency key.
      throw new DaaTransportError(`Request to ${request.url} failed`, { cause })
    }

    let body: string
    try {
      body = await response.text()
    } catch (cause) {
      // Headers arrived and the body did not — a connection dropped
      // mid-stream. Still a transport failure, and still one where the request
      // may have been applied, so it must not escape as a raw error: the whole
      // point of the two types is that a caller can classify every failure.
      throw new DaaTransportError(`Reading the response body from ${request.url} failed`, { cause })
    }
    return { status: response.status, body }
  }
}
