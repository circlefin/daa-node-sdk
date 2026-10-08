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
  resize,
  result,
  tokenRequest,
} from '../testing.js'

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'

const REGISTRATION_RESPONSE = {
  id: 'credential-id',
  rawId: 'credential-id',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
    attestationObject: 'o2NmbXRkbm9uZQ',
    transports: ['internal', 'hybrid'],
  },
  clientExtensionResults: {},
}

let host: FakeFrameHost
const container = {}
const inline: Presentation = { mode: 'inline', container }

const newClient = (): ReturnType<typeof createScaClientForTesting> =>
  createScaClientForTesting({ environment: 'production' }, host)

beforeEach(() => {
  host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
})

describe('enroll — happy path', () => {
  it('falls back to performance.now when the host does not expose its clock', async () => {
    // Optional for third-party FrameHost implementations: the ceremony still
    // needs a monotonic clock even when a host only supplies timers and DOM.
    Object.defineProperty(host, 'now', { value: undefined })

    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('mounts the frame with no token in its URL and the allow attribute set by the SDK', () => {
    void newClient()
      .enroll('tok-1', inline)
      .catch(() => undefined)

    const frame = host.currentFrame
    expect(frame?.src).toBe(`${CIRCLE_ORIGIN}/ceremony`)
    expect(frame?.allow).toContain(`publickey-credentials-create ${CIRCLE_ORIGIN}`)
    expect(frame?.allow).toContain(`payment ${CIRCLE_ORIGIN}`)
    expect(frame?.container).toBe(container)
  })

  it('acks ready with an explicit target origin, then resolves with the response verbatim', async () => {
    const promise = newClient().enroll('tok-1', inline)

    host.emitFrameMessage(ready('registration'))

    const received = host.currentFrame?.received ?? []
    expect(received).toHaveLength(1)
    // Explicit target origin, never "*": the frame may be embedded by a page
    // that is itself embedded, and "*" would broadcast to every ancestor.
    expect(received[0]?.targetOrigin).toBe(CIRCLE_ORIGIN)
    expect(received[0]?.message).toMatchObject({ kind: 'ack' })

    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    // Same object identity: the SDK is a relay and must not reshape,
    // re-serialize or inspect the response.
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('resolves even when the result arrives before ready', async () => {
    // A cached passkey can resolve before a listener attached after mount would
    // exist. The listener is attached first precisely so this cannot drop a
    // ceremony the user already completed.
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('tears the frame and the listener down on success', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await promise

    expect(host.currentFrame?.destroyed).toBe(true)
    expect(host.listenerCount).toBe(0)
  })
})

describe('enroll — inbound message gates', () => {
  it('ignores a message from any other origin', async () => {
    const promise = newClient().enroll('tok-1', inline)

    host.emitFrameMessage(result('registration', { spoofed: true }), {
      origin: 'https://evil.example',
    })
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('ignores a message from a different frame on the Circle origin', async () => {
    // event.origin alone would accept this: it is the correct origin, from the
    // wrong window.
    const promise = newClient().enroll('tok-1', inline)

    host.emitFrameMessage(result('registration', { spoofed: true }), { source: { other: true } })
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('ignores traffic that is not on the SCA channel', async () => {
    const promise = newClient().enroll('tok-1', inline)

    host.emit({ type: 'webpackHotUpdate' })
    host.emit('some string')
    host.emit(null)
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('fails with Protocol when a message is on the channel but unreadable', async () => {
    // Frame and SDK ship from the same Circle deployment, so this is skew.
    const promise = newClient().enroll('tok-1', inline)
    host.emit({ channel: 'circle.daa.sca', version: 99, kind: 'ready' })
    await expect(promise).rejects.toMatchObject({ code: 'Protocol' })
  })
})

describe('enroll — failure mapping', () => {
  it('relays a frame error code and message once the user dismisses', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(frameError('Cancelled', 'user dismissed the prompt'))
    // frameError alone keeps the frame alive so the user can read the error.
    // The SDK only rejects once the frame signals it is ready to close.
    host.emitFrameMessage(dismiss())

    await expect(promise).rejects.toMatchObject({
      code: 'Cancelled',
      message: 'user dismissed the prompt',
    })
  })

  it('rejects a challenge result answering a registration ceremony', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(result('challenge', REGISTRATION_RESPONSE))
    await expect(promise).rejects.toMatchObject({ code: 'Protocol' })
  })

  it('rejects a result with no response object', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(result('registration', null))
    await expect(promise).rejects.toMatchObject({ code: 'Protocol' })
  })

  it('rejects an empty frameToken as Transport', async () => {
    await expect(newClient().enroll('', inline)).rejects.toMatchObject({ code: 'Transport' })
  })

  it('tears down once the user dismisses after a failure', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(frameError('Unsupported'))

    // Frame is still alive — user can read the error.
    expect(host.currentFrame?.destroyed).toBe(false)
    expect(host.listenerCount).toBe(1)

    host.emitFrameMessage(dismiss())
    await expect(promise).rejects.toMatchObject({ code: 'Unsupported' })

    expect(host.currentFrame?.destroyed).toBe(true)
    expect(host.listenerCount).toBe(0)
  })

  it('ignores a late result that arrives after frameError', async () => {
    // A result in the error→dismiss window must not silently discard the
    // error and resolve as a success.
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(frameError('Unsupported'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    host.emitFrameMessage(dismiss())

    await expect(promise).rejects.toMatchObject({ code: 'Unsupported' })
  })

  it('ignores a late ready that arrives after frameError', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(frameError('Unsupported'))
    host.emitFrameMessage(ready('registration'))

    // A late ready must not restart the ceremony or send an acknowledgement.
    expect(host.currentFrame?.received).toEqual([])
    host.emitFrameMessage(dismiss())
    await expect(promise).rejects.toMatchObject({ code: 'Unsupported' })
  })

  it('settles with the stored error if dismiss never arrives', async () => {
    // Rollout skew: frame posts frameError but is too old to post frameDismiss.
    // The SDK must not hang forever.
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(frameError('Transport', 'network gone'))
    host.advance(60_001)

    await expect(promise).rejects.toMatchObject({ code: 'Transport', message: 'network gone' })
    expect(host.currentFrame?.destroyed).toBe(true)
  })

  it('keeps the first frame error and does not reset its dismissal deadline', async () => {
    const promise = createScaClientForTesting(
      { environment: 'production', ceremonyTimeoutMs: 100 },
      host,
    ).enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(frameError('Transport', 'first error'))

    host.advance(50)
    host.emitFrameMessage(frameError('Cancelled', 'replacement error'))
    host.advance(50)

    await expect(promise).rejects.toMatchObject({
      code: 'Transport',
      message: 'first error',
    })
  })

  it('caps the dismissal window by the configured budget when the frame errors before ready', async () => {
    const promise = createScaClientForTesting(
      { environment: 'production', readyTimeoutMs: 50, ceremonyTimeoutMs: 100 },
      host,
    ).enroll('tok-1', inline)
    host.emitFrameMessage(frameError('Transport', 'failed before ready'))

    // A ready at 49 ms could have run the ceremony to 149 ms, and nothing
    // later — not the hardcoded dismiss fallback.
    host.advance(149)
    expect(host.currentFrame?.destroyed).toBe(false)
    host.advance(1)

    await expect(promise).rejects.toMatchObject({
      code: 'Transport',
      message: 'failed before ready',
    })
    expect(host.currentFrame?.destroyed).toBe(true)
  })

  it('settles immediately when a frame error arrives after the ceremony deadline', async () => {
    const promise = createScaClientForTesting(
      { environment: 'production', ceremonyTimeoutMs: 100 },
      host,
    ).enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))

    // Move only the monotonic reading: leave the fake timer queue untouched so
    // the frame error, not the timeout callback, reaches the expired branch.
    host.now = () => 100
    host.emitFrameMessage(frameError('Expired', 'already past deadline'))

    await expect(promise).rejects.toMatchObject({
      code: 'Expired',
      message: 'already past deadline',
    })
    expect(host.currentFrame?.destroyed).toBe(true)
  })
})

describe('enroll — abort signal', () => {
  it('rejects with Cancelled and tears down when the signal fires mid-ceremony', async () => {
    const controller = new AbortController()
    const promise = newClient().enroll('tok-1', inline, { signal: controller.signal })
    host.emitFrameMessage(ready('registration'))

    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentFrame?.destroyed).toBe(true)
    expect(host.listenerCount).toBe(0)
  })

  it('returns the first frame error when aborted during its error display', async () => {
    const controller = new AbortController()
    const promise = newClient().enroll('tok-1', inline, { signal: controller.signal })
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(frameError('Transport', 'Circle is unavailable'))

    controller.abort()

    await expect(promise).rejects.toMatchObject({
      code: 'Transport',
      message: 'Circle is unavailable',
    })
    expect(host.currentFrame?.destroyed).toBe(true)
    expect(host.listenerCount).toBe(0)
  })

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()

    const promise = newClient().enroll('tok-1', inline, { signal: controller.signal })

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    // Frame was never mounted
    expect(host.frames).toHaveLength(0)
  })

  it('proceeds normally when signal is not aborted', async () => {
    const controller = new AbortController()
    const promise = newClient().enroll('tok-1', inline, { signal: controller.signal })
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))

    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('ignores the signal after ceremony completes', async () => {
    const controller = new AbortController()
    const promise = newClient().enroll('tok-1', inline, { signal: controller.signal })
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await promise

    // Aborting after success has no effect — promise is already settled
    controller.abort()
    expect(host.currentFrame?.destroyed).toBe(true)
  })
})

describe('enroll — timeouts', () => {
  it('reports a frame that never loads as Transport, not Expired', async () => {
    // No `ready` was observed, so the token's server-side state is unknown.
    const promise = newClient().enroll('tok-1', inline)
    host.advance(10_000)
    await expect(promise).rejects.toMatchObject({ code: 'Transport' })
  })

  it('does not fire the ready timeout once the frame is ready', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))
    host.advance(11_000)
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('budgets the ceremony from ready, and reports overrun as Expired', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.advance(9_000)
    host.emitFrameMessage(ready('registration'))
    host.advance(299_000)
    host.emitFrameMessage(resize(100))
    host.advance(2_000)
    await expect(promise).rejects.toMatchObject({ code: 'Expired' })
  })
})

describe('enroll — height', () => {
  it('applies the first posted height on receipt, and later ones from a timer', async () => {
    // requestAnimationFrame and a ResizeObserver's first delivery are both tied
    // to the frame being rendered, which a cross-origin iframe in normal page
    // flow is not guaranteed to be. The first height is not worth a tick's
    // wait: until it lands the frame is at a placeholder height.
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))

    host.emitFrameMessage(resize(320))
    expect(host.currentFrame?.appliedHeights).toEqual([320])

    host.emitFrameMessage(resize(480))
    expect(host.currentFrame?.appliedHeights).toEqual([320])

    host.advance(250)
    expect(host.currentFrame?.appliedHeights).toEqual([320, 480])

    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await promise
  })

  it('applies a height posted before ready as soon as ready arrives', async () => {
    const promise = newClient().enroll('tok-1', inline)

    host.emitFrameMessage(resize(320))
    expect(host.currentFrame?.appliedHeights).toEqual([])

    host.emitFrameMessage(ready('registration'))
    expect(host.currentFrame?.appliedHeights).toEqual([320])

    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await promise
  })

  it('applies only the latest height and never re-applies an unchanged one', async () => {
    const promise = newClient().enroll('tok-1', inline)
    host.emitFrameMessage(ready('registration'))

    host.emitFrameMessage(resize(320))
    host.emitFrameMessage(resize(400))
    host.emitFrameMessage(resize(480))
    host.advance(250)
    host.advance(250)
    host.advance(250)

    expect(host.currentFrame?.appliedHeights).toEqual([320, 480])

    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await promise
  })
})

describe('enroll — token handshake', () => {
  it('answers token-request with the token, targeted at the Circle origin', () => {
    void newClient()
      .enroll('tok-1', inline)
      .catch(() => undefined)

    host.emitFrameMessage(tokenRequest())

    expect(host.currentFrame?.received).toEqual([
      {
        message: { channel: 'circle.daa.sca', version: 1, kind: 'token', token: 'tok-1' },
        // Never "*": if the frame has navigated off the Circle origin, the
        // browser drops the message instead of delivering the capability.
        targetOrigin: CIRCLE_ORIGIN,
      },
    ])
  })

  it('sends the token once, however many times it is asked', () => {
    void newClient()
      .enroll('tok-1', inline)
      .catch(() => undefined)

    host.emitFrameMessage(tokenRequest())
    host.emitFrameMessage(tokenRequest())

    expect(host.currentFrame?.received).toHaveLength(1)
  })

  it('does not answer a token-request from another origin or another frame', () => {
    void newClient()
      .enroll('tok-1', inline)
      .catch(() => undefined)

    host.emitFrameMessage(tokenRequest(), { origin: 'https://evil.example' })
    host.emitFrameMessage(tokenRequest(), { source: { someOtherFrame: true } })

    expect(host.currentFrame?.received).toEqual([])
  })

  it('does not answer a token-request that arrives before the frame is mounted', () => {
    // No frame to check `event.source` against yet, so whoever sent it cannot
    // be told apart from the frame. Ignored outright — not answered into the
    // void and counted as sent, which would strand the real frame's request.
    const mount = host.mount.bind(host)
    Object.defineProperty(host, 'mount', {
      value: (options: Parameters<typeof mount>[0]) => {
        host.emitFrameMessage(tokenRequest(), { source: undefined })
        return mount(options)
      },
    })

    void newClient()
      .enroll('tok-1', inline)
      .catch(() => undefined)
    expect(host.currentFrame?.received).toEqual([])

    host.emitFrameMessage(tokenRequest())
    expect(host.currentFrame?.received).toHaveLength(1)
    expect(host.currentFrame?.received[0]?.message).toMatchObject({ token: 'tok-1' })
  })

  it('does not answer a token-request after ready', () => {
    void newClient()
      .enroll('tok-1', inline)
      .catch(() => undefined)

    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(tokenRequest())

    expect(host.currentFrame?.received.map((r) => (r.message as { kind: string }).kind)).toEqual([
      'ack',
    ])
  })
})

describe('enroll — element reuse', () => {
  it('mounts a fresh element per ceremony', async () => {
    // Every ceremony loads the same URL, and the document keeps the first
    // token it is handed — so a reused element would serve the previous
    // ceremony.
    const client = newClient()

    const first = client.enroll('tok-1', inline)
    host.emitFrameMessage(tokenRequest())
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await first

    const second = client.enroll('tok-2', inline)
    host.emitFrameMessage(tokenRequest())
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await second

    expect(host.frames).toHaveLength(2)
    expect(host.frames[0]?.received[0]?.message).toMatchObject({ token: 'tok-1' })
    expect(host.frames[1]?.received[0]?.message).toMatchObject({ token: 'tok-2' })
  })
})

describe('client surface', () => {
  it('rejects a missing presentation as Unsupported, not as a raw TypeError', async () => {
    // The input most likely to arrive by accident — an omitted argument, or a
    // value read out of a distributor's own config that was not there. The
    // property read that finds the mode throws a bare `TypeError` on these,
    // and a `TypeError` is invisible to the `isScaError(err) && err.code`
    // narrowing every caller is told to use.
    for (const absent of [undefined, null]) {
      await expect(
        newClient().enroll('tok-1', absent as unknown as Presentation),
      ).rejects.toMatchObject({ code: 'Unsupported' })
    }
    expect(host.currentFrame).toBeUndefined()
    expect(host.currentModal).toBeUndefined()
  })

  it('fails closed on a presentation mode it does not know', async () => {
    // Only reachable from plain JavaScript, or from a mode read out of a
    // distributor's own runtime config. The two modes the type allows are
    // both implemented; this is the third one nobody declared.
    await expect(
      newClient().enroll('tok-1', { mode: 'sheet' } as unknown as Presentation),
    ).rejects.toMatchObject({ code: 'Unsupported' })
    expect(host.currentFrame).toBeUndefined()
    expect(host.currentModal).toBeUndefined()
  })

  it('reports SPC support as unknown rather than false', () => {
    // "We did not look" and "the browser cannot" lead a distributor to
    // different decisions.
    expect(newClient().capabilities()).toEqual({
      protocolVersion: 1,
      frame: true,
      securePaymentConfirmation: 'unknown',
    })
  })

  it('rejects a bad origin at construction, not mid-ceremony', () => {
    expect(() =>
      createScaClientForTesting(
        { environment: 'production', circleOrigin: 'http://evil.example' },
        host,
      ),
    ).toThrow(/circleOrigin cannot be overridden in production/)
  })
})

describe('enroll — branch crossing', () => {
  it('rejects a ready for the other ceremony kind, as it already does for a result', () => {
    // Without this the challenge `ready` arms the ceremony and resize timers
    // for a ceremony this frame is not running, and is answered with an `ack`.
    const promise = newClient().enroll('tok-1', inline)

    host.emitFrameMessage(ready('challenge'))

    expect(host.currentFrame?.received).toEqual([])
    return expect(promise).rejects.toMatchObject({
      code: 'Protocol',
      message: expect.stringContaining('challenge'),
    })
  })
})

describe('enroll — mount failure', () => {
  it('maps a throwing mount() to Unsupported and leaves nothing armed', async () => {
    // The DOM host throws when `container` is not somewhere a frame can go.
    // Asserted here because the state machine claims no untested branch.
    const throwing = {
      ...host,
      mount() {
        throw new Error('container is not an element')
      },
    }
    const client = createScaClientForTesting({ environment: 'production' }, throwing)

    await expect(client.enroll('tok-1', inline)).rejects.toMatchObject({
      code: 'Unsupported',
      message: expect.stringContaining('mount'),
    })
    // The listener registered before mount must not survive the failure.
    expect(host.listenerCount).toBe(0)
  })
})
