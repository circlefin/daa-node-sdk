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
 * The half of the SDK↔ceremony-app contract this repository can actually pin.
 *
 * `runCeremony` only ever sees what the framed document posts, so the browser
 * flow rests on both halves agreeing about one envelope and one URL. That is
 * why `./protocol` is a published subpath: the ceremony app is meant to import
 * `frameReady`/`frameResize`/`frameResult`/`frameError` rather than restate
 * the shape.
 *
 * **What this file cannot do.** An earlier version claimed to pin the
 * cross-repo contract by asserting that the ceremony app's envelope is
 * unreadable here. That envelope no longer exists — the app adopted this
 * package's shape — so the case was testing a snapshot of a branch, and a
 * reviewer was right to call it a stale counter-example rather than a
 * contract. Worse, I had reviewed the commit that changed it.
 *
 * A test in this repository cannot observe another repository. What it can do
 * is fix *our* half, so a change here is deliberate rather than incidental,
 * and so the values the app has to match are written down in one place. The
 * only durable fix for the other half is the app importing `./protocol`
 * instead of vendoring a copy of it; until then the two are kept in step by
 * review, and this file is the reference review compares against.
 *
 */
import { describe, expect, it } from 'vitest'

import { ceremonyUrl } from '../internal/frameContract.js'
import {
  frameError,
  frameReady,
  frameResize,
  frameResult,
  frameTokenRequest,
  hostAck,
  hostToken,
  isOnScaChannel,
  parseFrameMessage,
  readHostToken,
  SCA_CHANNEL,
  SCA_PROTOCOL_VERSION,
} from '../protocol.js'

/**
 * What the ceremony app must post, built the only supported way. Asserting
 * against the builders rather than against literals is deliberate: a literal
 * copy here would keep passing after someone changed `SCA_CHANNEL`, which is
 * exactly the class of drift this file exists to catch.
 */
describe('the envelope the ceremony app must emit', () => {
  it('round-trips every message the frame sends', () => {
    const attestation = { id: 'cred', rawId: 'cred', type: 'public-key', response: {} }

    expect(parseFrameMessage(frameReady('registration'))).toEqual({
      channel: expect.any(String),
      version: expect.any(Number),
      kind: 'ready',
      ceremony: 'registration',
    })
    expect(parseFrameMessage(frameResize(420))).toMatchObject({ kind: 'resize', height: 420 })
    expect(parseFrameMessage(frameResult('challenge', attestation))).toMatchObject({
      kind: 'result',
      ceremony: 'challenge',
      payload: attestation,
    })
    expect(parseFrameMessage(frameError('Expired', 'gone'))).toMatchObject({ kind: 'error' })
  })

  it('pins the literal values the app has to match', () => {
    // Written out deliberately. Everything else in this file asserts against
    // the builders, which cannot catch a change to the constants themselves —
    // and the constants are exactly what the other repository has to agree
    // with. If this fails, the app needs a coordinated change, not a rebase.
    expect(SCA_CHANNEL).toBe('circle.daa.sca')
    expect(SCA_PROTOCOL_VERSION).toBe(1)
    expect(frameReady('registration')).toEqual({
      channel: 'circle.daa.sca',
      version: 1,
      kind: 'ready',
      ceremony: 'registration',
    })
  })

  it('carries the version in the envelope, so skew is diagnosable', () => {
    // The property worth keeping if the protocol is ever renegotiated. A
    // version baked into the channel string makes a bumped frame invisible to
    // an older parent: different channel, silently ignored as another
    // library's traffic, surfacing only as a ready timeout. In-band, the SDK
    // can tell "I am being spoken to and cannot read it" from "not for me".
    const skewed = { channel: SCA_CHANNEL, version: 99, kind: 'ready', ceremony: 'registration' }
    expect(parseFrameMessage(skewed)).toBeNull()
    expect(isOnScaChannel(skewed)).toBe(true)

    const foreign = { channel: 'someone.else', version: 1, kind: 'ready' }
    expect(parseFrameMessage(foreign)).toBeNull()
    expect(isOnScaChannel(foreign)).toBe(false)
  })

  it('carries the ceremony kind as a field, which is what makes branch crossing detectable', () => {
    // `runCeremony` rejects a registration result answering a challenge. That
    // check needs the kind *on the message*; an envelope that encodes the kind
    // in its type name instead (`registration-result`) is not less safe, but it
    // moves the check from one comparison to a parse table — and the SDK's
    // version is the one DAA's own `CeremonyFrame.kind` mirrors.
    const ready = parseFrameMessage(frameReady('challenge'))
    expect(ready).toMatchObject({ ceremony: 'challenge' })
  })
})

/**
 * The other half of the contract, and the half this file originally missed.
 *
 * Pinning the postMessage envelope while leaving the token's *delivery*
 * unpinned caught nothing: the SDK wrote `#<token>` and the app read
 * `/[#&]token=([^&]+)/`, so the ceremony failed before a single message was
 * exchanged. The fragment is gone now — a token in `iframe.src` is readable
 * by any script on the distributor's page and outlives the frame in Resource
 * Timing — and the token travels as a message instead. These cases pin that
 * handshake the same way the envelope above is pinned.
 */
describe('how the ceremony app gets its token', () => {
  it('loads a URL with no token in it', () => {
    const url = new URL(ceremonyUrl('https://daa-sca.circle.com', '/ceremony'))
    expect(url.hash).toBe('')
    expect(url.search).toBe('')
  })

  it('pins the literal handshake the app has to match', () => {
    // Written out for the same reason as the envelope literals above: these
    // are what the other repository has to agree with.
    expect(frameTokenRequest()).toEqual({
      channel: 'circle.daa.sca',
      version: 1,
      kind: 'token-request',
    })
    expect(hostToken('tok')).toEqual({
      channel: 'circle.daa.sca',
      version: 1,
      kind: 'token',
      token: 'tok',
    })
  })

  it("round-trips a token through the app's reader", () => {
    const token = 'RbvzUnUCHrZ_kQ8mXt3pA-1bC2dE4fG6hI8jK0lM2nO'
    expect(readHostToken(hostToken(token))).toBe(token)
    expect(parseFrameMessage(frameTokenRequest())).toEqual(frameTokenRequest())
  })

  it('rejects anything that is not a token on this channel and version', () => {
    expect(readHostToken(hostAck())).toBeNull()
    expect(readHostToken({ ...hostToken('tok'), version: 99 })).toBeNull()
    expect(readHostToken({ ...hostToken('tok'), channel: 'someone.else' })).toBeNull()
    expect(readHostToken(hostToken(''))).toBeNull()
    expect(readHostToken({ ...hostToken('tok'), token: 42 })).toBeNull()
    expect(readHostToken(null)).toBeNull()
  })
})
