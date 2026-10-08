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

import { beforeEach, describe, expect, it } from 'vitest'

import type { Presentation } from '../config.js'
import type { FakeFrameHost } from '../testing.js'
import {
  createFakeFrameHost,
  createScaClientForTesting,
  dismiss,
  frameError,
  ready,
  result,
} from '../testing.js'

/**
 * `{ mode: 'modal' }` — the surface the SDK draws rather than the distributor.
 *
 * Driven through the fake host, so what is asserted here is the *contract*:
 * what the chrome is asked for, that the frame lands inside it, and that it
 * comes down on every path out of a ceremony. What the chrome looks like is
 * `modalChrome.test.ts`'s job.
 */

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'

const REGISTRATION_RESPONSE = {
  id: 'credential-id',
  rawId: 'credential-id',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
    attestationObject: 'o2NmbXRkbm9uZQ',
  },
}

let host: FakeFrameHost
const modal: Presentation = { mode: 'modal' }

const newClient = (): ReturnType<typeof createScaClientForTesting> =>
  createScaClientForTesting({ environment: 'production' }, host)

beforeEach(() => {
  host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
})

describe('modal presentation — what the chrome is asked for', () => {
  it('mounts the frame into the chrome, not into anything the caller supplied', () => {
    void newClient()
      .enroll('tok-1', modal)
      .catch(() => undefined)

    expect(host.modals).toHaveLength(1)
    // The distributor names no container in this mode, so the only way the
    // frame can be placed is inside the panel the chrome just created.
    expect(host.currentFrame?.container).toBe(host.currentModal?.container)
  })

  it('defaults the accessible name and leaves the dialog dismissible', () => {
    void newClient()
      .enroll('tok-1', modal)
      .catch(() => undefined)

    // Not the ceremony's heading: that copy lives inside the frame and this
    // side of the boundary is never told which ceremony is running.
    expect(host.currentModal?.title).toBe('Circle security check')
    expect(host.currentModal?.dismissible).toBe(true)
  })

  it('passes a caller’s title and dismissible through, already resolved', () => {
    void newClient()
      .approve('chal-tok', { mode: 'modal', title: 'Approve payment', dismissible: false })
      .catch(() => undefined)

    expect(host.currentModal?.title).toBe('Approve payment')
    expect(host.currentModal?.dismissible).toBe(false)
  })
})

describe('modal presentation — the chrome always comes down', () => {
  it('on success', async () => {
    const promise = newClient().enroll('tok-1', modal)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    await expect(promise).resolves.toMatchObject({ id: 'credential-id' })
    expect(host.currentModal?.closed).toBe(true)
  })

  it('on a frame error, but only once the frame has been dismissed', async () => {
    const promise = newClient().enroll('tok-1', modal)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(frameError('Expired', 'Ceremony expired.'))

    // The error→dismiss window: the frame is showing its own error UI inside
    // the panel, so tearing the chrome down here would hide it.
    expect(host.currentModal?.closed).toBe(false)

    host.emitFrameMessage(dismiss())
    await expect(promise).rejects.toMatchObject({ code: 'Expired' })
    expect(host.currentModal?.closed).toBe(true)
  })

  it('on a ready timeout, when the frame never loaded at all', async () => {
    const promise = newClient().enroll('tok-1', modal)
    host.advance(10_000)

    await expect(promise).rejects.toMatchObject({ code: 'Transport' })
    // Otherwise a backdrop covers the page with nothing behind it.
    expect(host.currentModal?.closed).toBe(true)
  })

  it('on a rejection raised before anything is mounted', async () => {
    await expect(newClient().enroll('', modal)).rejects.toMatchObject({ code: 'Transport' })

    expect(host.currentFrame).toBeUndefined()
    expect(host.currentModal?.closed).toBe(true)
  })
})

describe('modal presentation — dismissal', () => {
  it('cancels the ceremony and destroys the frame', async () => {
    const promise = newClient().enroll('tok-1', modal)
    host.emitFrameMessage(ready('registration'))

    host.currentModal?.dismiss()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentFrame?.destroyed).toBe(true)
    expect(host.currentModal?.closed).toBe(true)
  })

  it('does nothing when the dialog was opened non-dismissible', async () => {
    const promise = newClient().enroll('tok-1', { mode: 'modal', dismissible: false })
    host.emitFrameMessage(ready('registration'))

    host.currentModal?.dismiss()
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    // The ceremony the user was mid-way through is the one that finishes.
    await expect(promise).resolves.toMatchObject({ id: 'credential-id' })
  })

  it('leaves the caller’s own AbortSignal working', async () => {
    const controller = new AbortController()
    const promise = newClient().enroll('tok-1', modal, { signal: controller.signal })
    host.emitFrameMessage(ready('registration'))

    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentModal?.closed).toBe(true)
  })

  it('honours a signal that was already aborted before the call', async () => {
    const promise = newClient().enroll('tok-1', modal, { signal: AbortSignal.abort() })

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentFrame).toBeUndefined()
    expect(host.currentModal?.closed).toBe(true)
  })

  it('does not leave a listener on a caller’s signal it outlives', async () => {
    // One controller across several ceremonies is the documented pattern, so
    // a listener left behind per run accumulates for as long as the page is
    // open. Counted through the signal itself rather than a spy: `abort()`
    // after both ceremonies have settled must reach nothing.
    const controller = new AbortController()
    let aborts = 0
    controller.signal.addEventListener('abort', () => (aborts += 1))

    for (const token of ['tok-1', 'tok-2']) {
      const promise = newClient().enroll(token, modal, { signal: controller.signal })
      host.emitFrameMessage(ready('registration'))
      host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
      await promise
    }

    controller.abort()
    expect(aborts).toBe(1)
    expect(host.modals.every((m) => m.closed)).toBe(true)
  })
})
