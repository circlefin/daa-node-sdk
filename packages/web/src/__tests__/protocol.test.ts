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

import type { ScaErrorCode } from '../errors.js'
import {
  frameDismiss,
  frameError,
  frameReady,
  frameResize,
  frameResult,
  hostAck,
  isHostAck,
  isOnScaChannel,
  parseFrameMessage,
  SCA_CHANNEL,
  SCA_PROTOCOL_VERSION,
} from '../protocol.js'

const envelope = { channel: SCA_CHANNEL, version: SCA_PROTOCOL_VERSION }

describe('parseFrameMessage', () => {
  it('never throws on arbitrary cross-origin data', () => {
    for (const data of [undefined, null, 0, '', 'ready', [], () => {}, Symbol('x')]) {
      expect(() => parseFrameMessage(data)).not.toThrow()
      expect(parseFrameMessage(data)).toBeNull()
    }
  })

  it('ignores another library postMessage traffic on the page', () => {
    expect(parseFrameMessage({ type: 'webpackHotUpdate' })).toBeNull()
    expect(parseFrameMessage({ channel: 'some.other.sdk', kind: 'ready' })).toBeNull()
  })

  it('rejects a different envelope version rather than coercing it', () => {
    expect(
      parseFrameMessage({
        channel: SCA_CHANNEL,
        version: 99,
        kind: 'ready',
        ceremony: 'registration',
      }),
    ).toBeNull()
  })

  it('reads ready, resize, result and error', () => {
    expect(
      parseFrameMessage({ ...envelope, kind: 'ready', ceremony: 'registration' }),
    ).toMatchObject({
      kind: 'ready',
      ceremony: 'registration',
    })
    expect(parseFrameMessage({ ...envelope, kind: 'resize', height: 412 })).toMatchObject({
      kind: 'resize',
      height: 412,
    })
    expect(
      parseFrameMessage({ ...envelope, kind: 'result', ceremony: 'challenge', payload: { a: 1 } }),
    ).toMatchObject({
      kind: 'result',
      ceremony: 'challenge',
    })
    expect(parseFrameMessage({ ...envelope, kind: 'error', code: 'Cancelled' })).toMatchObject({
      kind: 'error',
      code: 'Cancelled',
    })
  })

  it('caps an error message at 2,048 characters', () => {
    const message = 'x'.repeat(2_050)
    const parsed = parseFrameMessage({ ...envelope, kind: 'error', code: 'Transport', message })

    expect(parsed).toMatchObject({ kind: 'error', code: 'Transport' })
    expect(parsed?.kind === 'error' ? parsed.message : undefined).toBe('x'.repeat(2_048))
    expect(parsed?.kind === 'error' ? parsed.message?.length : undefined).toBe(2_048)
  })

  it('accepts every code in the taxonomy, so the frame can report any of them', () => {
    // The set in this module is the wire contract: a code the frame emits but
    // this set omits is silently dropped rather than surfaced.
    const codes: ScaErrorCode[] = [
      'Cancelled',
      'Expired',
      'Unsupported',
      'NotEnrolled',
      'AlreadyEnrolled',
      'Transport',
      'Protocol',
    ]
    for (const code of codes) {
      expect(parseFrameMessage({ ...envelope, kind: 'error', code })).toMatchObject({ code })
    }
  })

  it('does not resolve a kind that names an Object.prototype member', () => {
    // The dispatch table is a Map, not an object literal. An object lookup
    // would resolve these to something inherited from Object.prototype and
    // then call it — and `kind` is attacker-controlled.
    for (const kind of ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty']) {
      expect(parseFrameMessage({ ...envelope, kind })).toBeNull()
    }
  })

  it('rejects an unknown ceremony kind and an unknown error code', () => {
    expect(parseFrameMessage({ ...envelope, kind: 'ready', ceremony: 'login' })).toBeNull()
    expect(parseFrameMessage({ ...envelope, kind: 'error', code: 'Boom' })).toBeNull()
  })

  it('rejects a non-finite or negative height', () => {
    for (const height of [Number.NaN, Number.POSITIVE_INFINITY, -1, '400']) {
      expect(parseFrameMessage({ ...envelope, kind: 'resize', height })).toBeNull()
    }
  })

  it('accepts a result with a null payload at the envelope layer', () => {
    // The envelope is well-formed; rejecting a missing response object is the
    // ceremony runner's call, so the two failures stay distinguishable.
    expect(
      parseFrameMessage({ ...envelope, kind: 'result', ceremony: 'registration', payload: null }),
    ).toMatchObject({
      kind: 'result',
    })
  })
})

describe('hostAck', () => {
  it('is on the channel and at the current version, so the frame accepts it', () => {
    const ack = hostAck()
    expect(ack).toEqual({
      channel: SCA_CHANNEL,
      version: SCA_PROTOCOL_VERSION,
      kind: 'ack',
    })
  })

  it('is a fresh object each call, so a caller cannot mutate a shared one', () => {
    expect(hostAck()).not.toBe(hostAck())
  })
})

describe('isOnScaChannel', () => {
  it('separates "not ours" from "ours but unreadable"', () => {
    expect(isOnScaChannel({ channel: 'other' })).toBe(false)
    expect(isOnScaChannel({ channel: SCA_CHANNEL, version: 99 })).toBe(true)
    expect(isOnScaChannel({ channel: SCA_CHANNEL, kind: 'nonsense' })).toBe(true)
    expect(isOnScaChannel(null)).toBe(false)
  })
})

describe('isHostAck', () => {
  it('accepts exactly what hostAck builds, so the two halves cannot drift', () => {
    expect(isHostAck(hostAck())).toBe(true)
  })

  it('rejects a foreign channel, a skewed version, and another kind', () => {
    expect(isHostAck({ ...envelope, kind: 'ready' })).toBe(false)
    expect(isHostAck({ channel: 'other', version: SCA_PROTOCOL_VERSION, kind: 'ack' })).toBe(false)
    expect(isHostAck({ channel: SCA_CHANNEL, version: 99, kind: 'ack' })).toBe(false)
  })

  it('is total against whatever an arbitrary origin posts', () => {
    for (const data of [undefined, null, 0, '', 'ack', [], () => undefined, Symbol('ack')]) {
      expect(isHostAck(data)).toBe(false)
    }
  })
})

describe('frame builders', () => {
  /**
   * The point of this module is that the two halves cannot disagree. These
   * assert it directly: what the ceremony app builds is what this SDK reads
   * back, field for field. A drift in the channel name or the envelope version
   * fails here rather than as a `Protocol` error in a browser.
   */
  it('round-trip through parseFrameMessage, unchanged', () => {
    const payload = { id: 'cred', response: { clientDataJSON: 'e30' } }
    for (const built of [
      frameReady('registration'),
      frameReady('challenge'),
      frameResize(480),
      frameResult('registration', payload),
      frameError('Cancelled'),
      frameError('Expired', 'the ceremony token had already been consumed'),
      frameDismiss(),
    ]) {
      expect(parseFrameMessage(built)).toEqual(built)
    }
  })

  it('relays the result payload by reference, never a copy', () => {
    // Re-serializing any nested field would invalidate the signature over it,
    // so the builder must not clone what it is handed.
    const payload = { response: { attestationObject: 'o2NmbXQ' } }
    expect(frameResult('registration', payload).payload).toBe(payload)
  })

  it('omits message entirely when none is given, rather than sending undefined', () => {
    // `{ message: undefined }` survives structured clone as a present key, so
    // the reader would see a message field that is not a string.
    expect('message' in frameError('Cancelled')).toBe(false)
    expect(frameError('Cancelled', 'user dismissed').message).toBe('user dismissed')
  })

  it('carries the current envelope, so a skewed frame is detectable', () => {
    expect(frameReady('registration')).toMatchObject({
      channel: SCA_CHANNEL,
      version: SCA_PROTOCOL_VERSION,
    })
  })
})
