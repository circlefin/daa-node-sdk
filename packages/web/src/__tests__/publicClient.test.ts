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

import { describe, expect, it } from 'vitest'

import type { Presentation } from '../config.js'
import { createScaClient, isScaError } from '../index.js'

const inline: Presentation = { mode: 'inline', container: {} }

/**
 * The public entry, exercised through the public entry.
 *
 * `enroll.test.ts` drives the state machine through
 * `createScaClientForTesting`, which means nothing there touches the function
 * a distributor actually calls. These cover what `createScaClient` guarantees
 * on its own, all of which is reachable without a DOM.
 */
describe('createScaClient', () => {
  it('validates the origin at construction, not mid-ceremony', () => {
    // A ceremony has already been opened and paid for by the time enroll()
    // runs, so a bad origin must not wait until then to surface.
    expect(() =>
      createScaClient({ environment: 'production', circleOrigin: 'http://evil.example' }),
    ).toThrow(/circleOrigin cannot be overridden in production/)
    expect(() => createScaClient({ environment: 'production', circleOrigin: 'not a url' })).toThrow(
      /valid URL/,
    )
  })

  it('constructs off a browser without touching the DOM', () => {
    // Server-side rendering imports and constructs; only enroll() needs a
    // browser. The host is built lazily for exactly this reason.
    expect(() => createScaClient({ environment: 'production' })).not.toThrow()
  })

  it('reports frame support as false where no frame can be mounted', () => {
    expect(createScaClient({ environment: 'production' }).capabilities()).toEqual({
      protocolVersion: 1,
      frame: false,
      securePaymentConfirmation: 'unknown',
    })
  })

  it('fails enroll() with a typed error off a browser, rather than a raw TypeError', async () => {
    // A distributor routing on `isScaError` to pick retry vs. fallback must
    // not meet a raw `TypeError` here — this is the failure a server-side
    // render hits first. Asserting the *type*, not just the message: the
    // message alone passed while the error was still a bare TypeError.
    const client = createScaClient({ environment: 'production' })
    try {
      await client.enroll('tok-1', inline)
      expect.unreachable('enroll() must not resolve without a DOM')
    } catch (err) {
      expect(isScaError(err)).toBe(true)
      expect((err as { code: string }).code).toBe('Unsupported')
      // The underlying seam error stays reachable for anyone debugging.
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(TypeError)
    }
  })

  it('maps a missing DOM to Unsupported on approve() too, not only enroll()', async () => {
    // This used to assert that approve() was unimplemented. It is implemented
    // now, so the same no-DOM path has to be asserted for it explicitly —
    // otherwise removing that test would have silently dropped the only
    // coverage of the public entry's step-up path.
    const client = createScaClient({ environment: 'production' })
    try {
      await client.approve('chal-tok', inline)
      expect.unreachable('approve() must not resolve without a DOM')
    } catch (err) {
      expect(isScaError(err)).toBe(true)
      expect((err as { code: string }).code).toBe('Unsupported')
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(TypeError)
    }
  })
})
