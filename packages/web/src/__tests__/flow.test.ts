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
  tokenRequest,
} from '../testing.js'

/**
 * Both ceremonies, in the order a distributor runs them, on one client.
 *
 * The per-call behavior is covered in `enroll.test.ts` and `approve.test.ts`.
 * What only a sequence can show is that the two do not interfere: that the
 * frame and the listener from the first are really gone before the second
 * starts, and that a message from the retired frame cannot reach the live
 * ceremony. Those are the failures a single-call test cannot have.
 *
 * The server half is plain values here. `packages/web` cannot depend on
 * `packages/node`, even for tests — that dependency is the trust boundary this
 * repo is organized around — so what this proves is the browser half of the
 * flow, with the tokens standing in for what the backend returns.
 */

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'

/** What `POST /v1/accounts/passkeys/registrations` hands back. */
const REGISTRATION_TOKEN = 'reg-frame-token'
/** What `POST /v1/accounts/passkeys/challenges` hands back. */
const CHALLENGE_TOKEN = 'chal-frame-token'

const ATTESTATION = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0',
    attestationObject: 'o2NmbXRkbm9uZQ',
    transports: ['internal'],
  },
}

const ASSERTION = {
  id: 'cred-1',
  rawId: 'cred-1',
  type: 'public-key',
  response: {
    clientDataJSON: 'eyJ0eXBlIjoid2ViYXV0aG4uZ2V0In0',
    authenticatorData: 'SZYN5YgOjGh0NBcPZHZgW4_krrmihjLHmVzzuoMdl2MFAAAAAA',
    signature: 'MEUCIQDx_T7Hs',
  },
}

let host: FakeFrameHost
const container = {}
const inline: Presentation = { mode: 'inline', container }

const newClient = (): ReturnType<typeof createScaClientForTesting> =>
  createScaClientForTesting({ environment: 'production' }, host)

beforeEach(() => {
  host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
})

describe('enroll then approve, on one client', () => {
  it('runs both ceremonies and returns each response verbatim', async () => {
    const sca = newClient()

    // ① Enrollment. Only the frameToken crosses into the page.
    const enrolling = sca.enroll(REGISTRATION_TOKEN, inline)
    host.emitFrameMessage(tokenRequest())
    expect(host.currentFrame?.received[0]?.message).toMatchObject({ token: REGISTRATION_TOKEN })
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', ATTESTATION))
    const attestation = await enrolling

    // The backend posts this to `POST /v1/accounts/passkeys` as
    // `attestationResponse`, unreshaped — hence identity, not equality.
    expect(attestation).toBe(ATTESTATION)

    // ② Step-up, after the backend has opened a challenge.
    const approving = sca.approve(CHALLENGE_TOKEN, inline)
    host.emitFrameMessage(tokenRequest())
    expect(host.currentFrame?.received[0]?.message).toMatchObject({ token: CHALLENGE_TOKEN })
    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', ASSERTION))
    const assertion = await approving

    // Already the X-Sca-Assertion header value — a string, not the object.
    expect(JSON.parse(assertion)).toEqual(ASSERTION)
  })

  it('mounts a second frame rather than reusing the first', async () => {
    const sca = newClient()

    const enrolling = sca.enroll(REGISTRATION_TOKEN, inline)
    const first = host.currentFrame
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', ATTESTATION))
    await enrolling

    const approving = sca.approve(CHALLENGE_TOKEN, inline)
    const second = host.currentFrame

    expect(host.frames).toHaveLength(2)
    expect(second).not.toBe(first)
    expect(first?.destroyed).toBe(true)
    // The premise of the fresh-element rule: both ceremonies load the same
    // URL, and the document keeps the first token it is handed — so a reused
    // element would still be serving ceremony ①.
    expect(first?.src).toBe(second?.src)

    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', ASSERTION))
    await approving
  })

  it('leaves nothing listening between ceremonies', async () => {
    const sca = newClient()
    expect(host.listenerCount).toBe(0)

    const enrolling = sca.enroll(REGISTRATION_TOKEN, inline)
    expect(host.listenerCount).toBe(1)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', ATTESTATION))
    await enrolling
    // Not "one per ceremony" — zero. A listener that outlived its ceremony
    // would keep receiving from the Circle origin for the life of the page.
    expect(host.listenerCount).toBe(0)

    const approving = sca.approve(CHALLENGE_TOKEN, inline)
    expect(host.listenerCount).toBe(1)
    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', ASSERTION))
    await approving
    expect(host.listenerCount).toBe(0)
    expect(host.frames.every((f) => f.destroyed)).toBe(true)
  })

  it('ignores a message from the retired frame during the live ceremony', async () => {
    const sca = newClient()

    const enrolling = sca.enroll(REGISTRATION_TOKEN, inline)
    const retired = host.currentFrame
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', ATTESTATION))
    await enrolling

    const approving = sca.approve(CHALLENGE_TOKEN, inline)
    host.emitFrameMessage(ready('challenge'))

    // The retired frame's window, on the correct origin, posting a
    // well-formed error for the ceremony kind now running. Only the source
    // gate separates this from a ceremony-killing message — `event.origin`
    // would accept it.
    // Note an `error` carries no ceremony kind — it is terminal either way —
    // so the source gate is the only thing standing between the retired frame
    // and a killed ceremony here.
    host.emitFrameMessage(frameError('Cancelled', 'from the old frame'), {
      source: retired?.window,
    })

    host.emitFrameMessage(result('challenge', ASSERTION))
    await expect(approving).resolves.toBe(JSON.stringify(ASSERTION))
  })

  it('lets a failed step-up be retried without re-enrolling', async () => {
    const sca = newClient()

    const enrolling = sca.enroll(REGISTRATION_TOKEN, inline)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', ATTESTATION))
    await enrolling

    // The user dismisses the prompt. The backend opens a new challenge — the
    // old one is spent — and the page runs step-up again on the same client.
    const failing = sca.approve(CHALLENGE_TOKEN, inline)
    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(frameError('Cancelled', 'The user dismissed the prompt'))
    host.emitFrameMessage(dismiss())
    await expect(failing).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.listenerCount).toBe(0)

    const retrying = sca.approve('chal-frame-token-2', inline)
    host.emitFrameMessage(tokenRequest())
    expect(host.currentFrame?.received[0]?.message).toMatchObject({
      token: 'chal-frame-token-2',
    })
    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', ASSERTION))
    await expect(retrying).resolves.toBe(JSON.stringify(ASSERTION))
  })
})
