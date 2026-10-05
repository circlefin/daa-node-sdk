import { beforeEach, describe, expect, it } from 'vitest'

import type { Presentation } from '../config.js'
import { isScaError } from '../errors.js'
import type { FakeFrameHost } from '../testing.js'
import {
  createFakeFrameHost,
  createScaClientForTesting,
  frameError,
  ready,
  result,
  tokenRequest,
} from '../testing.js'

/**
 * `enroll` and `approve` on a browser where a ceremony cannot run in a
 * cross-origin frame — WebKit — so it runs in a Circle window instead.
 */

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'

const REGISTRATION_RESPONSE = {
  id: 'credential-id',
  rawId: 'credential-id',
  type: 'public-key',
  response: { clientDataJSON: 'e30', attestationObject: 'o2M' },
}

const modal: Presentation = { mode: 'modal' }
const inline: Presentation = { mode: 'inline', container: {} }

let host: FakeFrameHost

const newClient = () => createScaClientForTesting({ environment: 'production' }, host)

/** A token promise the test settles when it chooses to. */
const deferredToken = () => {
  let resolve!: (token: string) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<string>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Lets the SDK's `await` on the token run. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN, embeddedCeremonies: false })
})

describe('enroll on WebKit — the window surface', () => {
  it('opens the window synchronously, before the token exists', () => {
    const token = deferredToken()
    void newClient()
      .enroll(token.promise, modal)
      .catch(() => undefined)

    // Still inside the "click": the window is up and blank.
    expect(host.windows).toHaveLength(1)
    expect(host.currentWindow?.src).toBe(null)
  })

  it('draws no modal and mounts no frame', () => {
    void newClient()
      .enroll('tok-1', modal)
      .catch(() => undefined)

    expect(host.modals).toHaveLength(0)
    expect(host.frames).toHaveLength(0)
  })

  it('loads the ceremony once the token arrives, then relays the result verbatim', async () => {
    const token = deferredToken()
    const promise = newClient().enroll(token.promise, inline)

    token.resolve('tok-1')
    await flush()
    expect(host.currentWindow?.src).toBe(`${CIRCLE_ORIGIN}/ceremony`)

    host.emitFrameMessage(tokenRequest())
    host.emitFrameMessage(ready('registration'))
    expect(host.currentWindow?.received).toEqual([
      {
        message: expect.objectContaining({ kind: 'token', token: 'tok-1' }),
        targetOrigin: CIRCLE_ORIGIN,
      },
      { message: expect.objectContaining({ kind: 'ack' }), targetOrigin: CIRCLE_ORIGIN },
    ])

    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('takes a plain string token too', async () => {
    const promise = newClient().enroll('tok-1', modal)

    expect(host.currentWindow?.src).toBe(`${CIRCLE_ORIGIN}/ceremony`)
    host.emitFrameMessage(tokenRequest())
    expect(host.currentWindow?.received[0]?.message).toMatchObject({ token: 'tok-1' })
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('gives the token only to the ceremony window, once', () => {
    void newClient()
      .enroll('tok-1', modal)
      .catch(() => undefined)

    host.emitFrameMessage(tokenRequest(), { source: { someOtherWindow: true } })
    host.emitFrameMessage(tokenRequest(), { origin: 'https://evil.example' })
    expect(host.currentWindow?.received).toHaveLength(0)

    host.emitFrameMessage(tokenRequest())
    host.emitFrameMessage(tokenRequest())
    expect(host.currentWindow?.received).toEqual([
      {
        message: expect.objectContaining({ kind: 'token', token: 'tok-1' }),
        targetOrigin: CIRCLE_ORIGIN,
      },
    ])
  })

  it('does not answer a token-request before the token has arrived', async () => {
    // The window is up and blank while the caller's fetch is in flight, and
    // nothing is loaded into it yet — so nothing can be the ceremony asking.
    const token = deferredToken()
    void newClient()
      .enroll(token.promise, modal)
      .catch(() => undefined)

    host.emitFrameMessage(tokenRequest())
    expect(host.currentWindow?.received).toHaveLength(0)

    token.resolve('tok-1')
    await flush()
    host.emitFrameMessage(tokenRequest())
    expect(host.currentWindow?.received[0]?.message).toMatchObject({ token: 'tok-1' })
  })

  it('ignores a message from a different window on the Circle origin', async () => {
    const promise = newClient().enroll('tok-1', modal)

    host.emitFrameMessage(ready('registration'), { source: { someOtherWindow: true } })
    expect(host.currentWindow?.received).toHaveLength(0)

    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })

  it('rejects Cancelled when the user closes the window', async () => {
    const promise = newClient().enroll('tok-1', modal)
    host.emitFrameMessage(ready('registration'))

    host.currentWindow?.userClose()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
  })

  it('rejects Cancelled and closes the window when the caller aborts', async () => {
    const controller = new AbortController()
    const promise = newClient().enroll('tok-1', modal, { signal: controller.signal })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('rejects Cancelled without loading anything when the window is closed before the token arrives', async () => {
    const token = deferredToken()
    const promise = newClient().enroll(token.promise, modal)

    host.currentWindow?.userClose()
    token.resolve('tok-1')

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentWindow?.src).toBe(null)
  })

  // A token promise that never settles stands in for a slow backend. Without
  // racing the wait against the signal, these stayed pending for as long as
  // the caller's fetch did.
  it('rejects Cancelled at once when the window is closed while the token is still pending', async () => {
    const token = deferredToken()
    const promise = newClient().enroll(token.promise, modal)

    host.currentWindow?.userClose()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentWindow?.src).toBe(null)
  })

  it('rejects Cancelled at once and closes the window when the caller aborts while the token is still pending', async () => {
    const token = deferredToken()
    const controller = new AbortController()
    const promise = newClient().enroll(token.promise, modal, { signal: controller.signal })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('loads nothing when a token arrives after the ceremony was canceled', async () => {
    const token = deferredToken()
    const promise = newClient().enroll(token.promise, modal)

    host.currentWindow?.userClose()
    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })

    token.resolve('tok-late')
    await flush()
    expect(host.currentWindow?.src).toBe(null)
    expect(host.frames).toHaveLength(0)
  })

  it('reports the frame error the ceremony window sent, then closes it on dismiss', async () => {
    const promise = newClient().enroll('tok-1', modal)
    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(frameError('AlreadyEnrolled', 'Already registered'))
    host.emitFrameMessage({ channel: 'circle.daa.sca', version: 1, kind: 'dismiss' })

    await expect(promise).rejects.toMatchObject({ code: 'AlreadyEnrolled' })
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('passes a rejected token promise through unchanged and closes the window', async () => {
    const token = deferredToken()
    const promise = newClient().enroll(token.promise, modal)

    const failure = new Error('backend said no')
    token.reject(failure)

    await expect(promise).rejects.toBe(failure)
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('rejects Transport for a promise that resolves to something other than a string', async () => {
    const promise = newClient().enroll(Promise.resolve(undefined as unknown as string), modal)

    await expect(promise).rejects.toMatchObject({ code: 'Transport' })
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('rejects Unsupported, naming the fix, when the window is blocked', async () => {
    host = createFakeFrameHost({
      circleOrigin: CIRCLE_ORIGIN,
      embeddedCeremonies: false,
      blockWindows: true,
    })

    const error: unknown = await newClient()
      .enroll('tok-1', modal)
      .catch((e: unknown) => e)

    expect(isScaError(error) && error.code).toBe('Unsupported')
    expect((error as Error).message).toMatch(/synchronously from the click handler/)
    expect(host.frames).toHaveLength(0)
  })

  it('rejects Unsupported when the host cannot open a window', async () => {
    Object.defineProperty(host, 'openWindow', { value: undefined })

    await expect(newClient().enroll('tok-1', modal)).rejects.toMatchObject({
      code: 'Unsupported',
    })
  })

  it('still validates the presentation, so a wrong integration fails everywhere', async () => {
    await expect(
      newClient().enroll('tok-1', { mode: 'sideways' } as unknown as Presentation),
    ).rejects.toMatchObject({ code: 'Unsupported' })
    expect(host.windows).toHaveLength(0)
  })
})

// WebKit completes a step-up in the frame, but its `clientDataJSON` carries no
// `topOrigin`, and DAA rejects a cross-origin assertion that cannot prove its
// embedder. So `approve` takes the window there too.
describe('approve on WebKit — the window surface', () => {
  const ASSERTION = {
    id: 'credential-id',
    rawId: 'credential-id',
    type: 'public-key',
    response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' },
  }

  it('opens the window synchronously, before the token exists, and draws nothing', () => {
    const token = deferredToken()
    void newClient()
      .approve(token.promise, modal)
      .catch(() => undefined)

    expect(host.windows).toHaveLength(1)
    expect(host.currentWindow?.src).toBe(null)
    expect(host.modals).toHaveLength(0)
    expect(host.frames).toHaveLength(0)
  })

  it('hands the window its token, then returns the assertion as header text', async () => {
    const token = deferredToken()
    const promise = newClient().approve(token.promise, modal)

    token.resolve('chal-tok')
    await flush()
    expect(host.currentWindow?.src).toBe(`${CIRCLE_ORIGIN}/ceremony`)

    host.emitFrameMessage(tokenRequest())
    expect(host.currentWindow?.received[0]).toEqual({
      message: expect.objectContaining({ kind: 'token', token: 'chal-tok' }),
      targetOrigin: CIRCLE_ORIGIN,
    })

    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', ASSERTION))
    await expect(promise).resolves.toBe(JSON.stringify(ASSERTION))
    expect(host.currentWindow?.closed).toBe(true)
  })

  it('rejects Unsupported, naming approve, when the window is blocked', async () => {
    host = createFakeFrameHost({
      circleOrigin: CIRCLE_ORIGIN,
      embeddedCeremonies: false,
      blockWindows: true,
    })

    const error: unknown = await newClient()
      .approve('chal-tok', modal)
      .catch((e: unknown) => e)

    expect(isScaError(error) && error.code).toBe('Unsupported')
    expect((error as Error).message).toMatch(/approve\(\) synchronously from the click handler/)
    expect(host.frames).toHaveLength(0)
  })

  it('rejects Cancelled when the user closes the window', async () => {
    const promise = newClient().approve('chal-tok', modal)
    host.emitFrameMessage(ready('challenge'))

    host.currentWindow?.userClose()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
  })
})

describe('the frame is kept where it works', () => {
  it('runs approve in the frame elsewhere, with a promised token as well', async () => {
    host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
    const promise = newClient().approve(Promise.resolve('chal-tok'), inline)

    await flush()
    expect(host.windows).toHaveLength(0)
    expect(host.frames).toHaveLength(1)
    host.emitFrameMessage(tokenRequest())
    expect(host.currentFrame?.received[0]?.message).toMatchObject({ token: 'chal-tok' })

    host.emitFrameMessage(ready('challenge'))
    host.emitFrameMessage(result('challenge', { id: 'credential-id' }))
    await expect(promise).resolves.toBe(JSON.stringify({ id: 'credential-id' }))
  })

  it('rejects Cancelled at once when the modal is dismissed while the token is still pending', async () => {
    host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
    const token = deferredToken()
    const promise = newClient().enroll(token.promise, modal)

    host.currentModal?.dismiss()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.currentModal?.closed).toBe(true)
    expect(host.frames).toHaveLength(0)
  })

  it('rejects Cancelled at once when an inline caller aborts while the token is still pending', async () => {
    host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
    const token = deferredToken()
    const controller = new AbortController()
    const promise = newClient().enroll(token.promise, inline, { signal: controller.signal })

    controller.abort()

    await expect(promise).rejects.toMatchObject({ code: 'Cancelled' })
    expect(host.frames).toHaveLength(0)
  })

  it('runs enroll in the frame elsewhere, with a promised token as well', async () => {
    host = createFakeFrameHost({ circleOrigin: CIRCLE_ORIGIN })
    const promise = newClient().enroll(Promise.resolve('tok-1'), inline)

    await flush()
    expect(host.windows).toHaveLength(0)
    expect(host.currentFrame?.src).toBe(`${CIRCLE_ORIGIN}/ceremony`)
    host.emitFrameMessage(tokenRequest())
    expect(host.currentFrame?.received[0]?.message).toMatchObject({ token: 'tok-1' })

    host.emitFrameMessage(ready('registration'))
    host.emitFrameMessage(result('registration', REGISTRATION_RESPONSE))
    await expect(promise).resolves.toBe(REGISTRATION_RESPONSE)
  })
})
