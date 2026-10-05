import { describe, expect, it, vi } from 'vitest'

import { DEFAULT_TIMEOUT_MS } from '../config.js'
import { isDaaTransportError } from '../errors.js'
import { createFetchTransport } from '../transport.js'
import type { DaaRequest } from '../transport.js'

/**
 * The default transport, driven directly.
 *
 * Every test in `client.test.ts` injects a fake — which is what the seam is
 * for — so nothing there exercises the one transport most callers will
 * actually run. A regression in the request assembly (a dropped body, a lost
 * header) or in the error wrapping would ship silently.
 */

const GET: DaaRequest = {
  method: 'GET',
  url: 'https://api.circle.com/v1/accounts/passkeys?clientEntityId=c',
  headers: { authorization: 'Bearer k', accept: 'application/json' },
}

const POST: DaaRequest = {
  method: 'POST',
  url: 'https://api.circle.com/v1/accounts/passkeys/registrations',
  headers: { authorization: 'Bearer k', 'content-type': 'application/json' },
  body: '{"clientEntityId":"c"}',
}

/**
 * A `fetch` stand-in that records its call and returns a fixed response.
 *
 * Typed with a `string` url rather than `fetch`'s own `string | URL |
 * Request`, because the transport only ever passes the absolute URL it was
 * given — recording it is what the request-shape assertions read.
 */
const fakeFetch = (response: { status?: number; body?: string }) => {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const impl = (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init })
    return Promise.resolve(new Response(response.body ?? '{}', { status: response.status ?? 200 }))
  }
  return { calls, impl: impl as unknown as typeof fetch }
}

describe('createFetchTransport', () => {
  it('passes the method, headers and body straight through', async () => {
    const fake = fakeFetch({ body: '{"registrationId":"r"}' })
    const result = await createFetchTransport(fake.impl)(POST)

    expect(result).toEqual({ status: 200, body: '{"registrationId":"r"}' })
    expect(fake.calls[0]?.url).toBe(POST.url)
    expect(fake.calls[0]?.init?.method).toBe('POST')
    expect(fake.calls[0]?.init?.headers).toEqual(POST.headers)
    expect(fake.calls[0]?.init?.body).toBe(POST.body)
  })

  it('omits the body entirely when there is none', async () => {
    // Not `body: undefined`: `fetch` treats an explicit undefined body on a
    // GET differently from an absent one in some runtimes, and a GET with a
    // body is a request DAA will not answer.
    const fake = fakeFetch({ body: '{"passkeys":[]}' })
    await createFetchTransport(fake.impl)(GET)

    expect(fake.calls[0]?.init).not.toHaveProperty('body')
  })

  it('returns the status verbatim rather than throwing on a non-2xx', async () => {
    // Status classification belongs to the client, which needs the body to
    // read Circle's error envelope out of.
    const fake = fakeFetch({ status: 409, body: '{"code":420053}' })
    await expect(createFetchTransport(fake.impl)(POST)).resolves.toEqual({
      status: 409,
      body: '{"code":420053}',
    })
  })

  it('wraps a rejected fetch as DaaTransportError, keeping the cause', async () => {
    const cause = new Error('ECONNREFUSED')
    const impl = (() => Promise.reject(cause)) as unknown as typeof fetch

    try {
      await createFetchTransport(impl)(POST)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isDaaTransportError(error)).toBe(true)
      expect((error as Error).message).toContain(POST.url)
      expect((error as { cause?: unknown }).cause).toBe(cause)
    }
  })

  it('wraps a body that fails to arrive after the headers did', async () => {
    // A connection dropped mid-stream. The request may still have been
    // applied, so it has to be a transport error and not a raw rejection.
    const cause = new Error('terminated')
    const impl = (() =>
      Promise.resolve({
        status: 200,
        text: () => Promise.reject(cause),
      })) as unknown as typeof fetch

    try {
      await createFetchTransport(impl)(GET)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(isDaaTransportError(error)).toBe(true)
      expect((error as Error).message).toContain('response body')
      expect((error as { cause?: unknown }).cause).toBe(cause)
    }
  })

  it('attaches an abort signal honoring a configured timeout', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fake = fakeFetch({ body: '{"passkeys":[]}' })
    await createFetchTransport(fake.impl, 5_000)(GET)

    expect(timeoutSpy).toHaveBeenCalledWith(5_000)
    expect(fake.calls[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    timeoutSpy.mockRestore()
  })

  it('defaults the abort timeout to DEFAULT_TIMEOUT_MS', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fake = fakeFetch({ body: '{"passkeys":[]}' })
    await createFetchTransport(fake.impl)(GET)

    expect(timeoutSpy).toHaveBeenCalledWith(DEFAULT_TIMEOUT_MS)
    timeoutSpy.mockRestore()
  })

  it('validates the supported timer range at construction', () => {
    const fake = fakeFetch({})
    for (const timeoutMs of [0, Number.NaN, 1.5, 2_147_483_648]) {
      expect(() => createFetchTransport(fake.impl, timeoutMs)).toThrow(
        /timeoutMs must be an integer from 1 to 2147483647 milliseconds/,
      )
    }
    expect(() => createFetchTransport(fake.impl, 2_147_483_647)).not.toThrow()
  })

  it('fails at construction when the runtime has no global fetch', () => {
    // Raised where the transport is built rather than on the first call, so a
    // runtime without `fetch` is a startup failure and not a request failure.
    //
    // Driven by removing the global rather than by passing `undefined`:
    // `fetchImpl` is a defaulted parameter, so an explicit `undefined`
    // *selects* `globalThis.fetch` instead of bypassing it. Testing it the
    // other way would have asserted the default away.
    vi.stubGlobal('fetch', undefined)
    try {
      expect(() => createFetchTransport()).toThrow(TypeError)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
