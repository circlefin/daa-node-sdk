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
import { createFakeFrameHost, createScaClientForTesting, ready, result } from '../testing.js'

/**
 * Step-up, which runs the same machine as enrollment on the other ceremony
 * kind. The gates, timeouts, teardown and height handling are `runCeremony`'s
 * and are covered once in `enroll.test.ts` — duplicating them here would
 * assert the same code twice and say nothing about `approve`.
 *
 * What is tested here is only what the kind changes: which `ready` and which
 * `result` this ceremony accepts, that it rejects the other kind in both
 * directions, and that the assertion comes back untouched.
 */

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'

/**
 * An `AuthenticationResponseJSON`. Every byte field is base64url and must
 * survive the relay exactly — the signature covers `clientDataJSON` and
 * `authenticatorData`, so a single re-encoded character invalidates it.
 */
const ASSERTION = {
  id: 'credential-id',
  rawId: 'credential-id',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
    authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAA',
    signature: 'MEUCIQDx_T7Hs-vVvFvXm3Yl8Yd6Qb8xG2Z1Yv5r8Yb3',
    userHandle: 'dXNlci1oYW5kbGU',
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

describe('approve — happy path', () => {
  it('mounts the frame with no token in its URL', () => {
    void newClient()
      .approve('chal-tok', inline)
      .catch(() => undefined)

    const frame = host.currentFrame
    expect(frame?.src).toBe(`${CIRCLE_ORIGIN}/ceremony`)
    // `publickey-credentials-get` is what a step-up needs, and the allow
    // attribute is the SDK's to set — a frame without it cannot call
    // `navigator.credentials.get()` cross-origin at all.
    expect(frame?.allow).toContain(`publickey-credentials-get ${CIRCLE_ORIGIN}`)
    expect(frame?.container).toBe(container)
  })

  it('resolves with the header value, and every signed field survives it', async () => {
    const promise = newClient().approve('chal-tok', inline)

    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', ASSERTION))

    const header = await promise
    // A string, because that is what `X-Sca-Assertion` takes.
    expect(typeof header).toBe('string')
    // Round-trips to exactly what the frame posted. Serializing the envelope
    // is the only transformation allowed here.
    expect(JSON.parse(header)).toEqual(ASSERTION)

    // And the fields the signature covers are character-identical, asserted
    // against the header text itself rather than the parsed copy — a parse
    // that normalized anything would still deep-equal.
    for (const signed of [
      ASSERTION.response.clientDataJSON,
      ASSERTION.response.authenticatorData,
      ASSERTION.response.signature,
      ASSERTION.rawId,
    ]) {
      expect(header).toContain(`"${signed}"`)
    }
    // Not base64url of the JSON, which DAA rejects by name.
    expect(header.startsWith('{')).toBe(true)
  })

  it('acks the challenge ready with an explicit target origin', async () => {
    const promise = newClient().approve('chal-tok', inline)

    host.emitFrameMessage(ready('challenge'))
    expect(host.currentFrame?.received).toEqual([
      { message: expect.objectContaining({ kind: 'ack' }) as unknown, targetOrigin: CIRCLE_ORIGIN },
    ])

    host.emitFrameMessage(result('challenge', ASSERTION))
    await promise
  })
})

describe('approve — branch crossing', () => {
  it('rejects a registration result answering a challenge', async () => {
    const promise = newClient().approve('chal-tok', inline)

    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('registration', ASSERTION))

    await expect(promise).rejects.toMatchObject({
      code: 'Protocol',
      message: expect.stringContaining('challenge') as unknown as string,
    })
  })

  it('rejects a registration ready answering a challenge', async () => {
    const promise = newClient().approve('chal-tok', inline)

    host.emitFrameMessage(ready('registration'))

    await expect(promise).rejects.toMatchObject({ code: 'Protocol' })
  })

  it('and enroll still rejects a challenge, so the check holds both ways', async () => {
    const promise = newClient().enroll('tok-1', inline)

    host.emitFrameMessage(ready('challenge'))

    await expect(promise).rejects.toMatchObject({ code: 'Protocol' })
  })
})

describe('approve — argument handling', () => {
  it('rejects an empty frameToken as Transport, before mounting anything', async () => {
    await expect(newClient().approve('', inline)).rejects.toMatchObject({ code: 'Transport' })
    expect(host.currentFrame).toBeUndefined()
  })

  it('rejects a missing presentation as Unsupported, not as a raw TypeError', async () => {
    await expect(
      newClient().approve('chal-tok', undefined as unknown as Presentation),
    ).rejects.toMatchObject({ code: 'Unsupported' })
  })

  it('fails closed on a presentation mode it does not know', async () => {
    await expect(
      newClient().approve('chal-tok', { mode: 'sheet' } as unknown as Presentation),
    ).rejects.toMatchObject({ code: 'Unsupported' })
  })
})
