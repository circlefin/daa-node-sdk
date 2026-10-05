import { describe, expect, it } from 'vitest'

import { DAA_ENVIRONMENTS, resolveConfig } from '../config.js'
import { ceremonyUrl, frameAllowAttribute } from '../internal/frameContract.js'

describe('resolveConfig', () => {
  it('accepts a bare https origin and fills defaults', () => {
    expect(
      resolveConfig({ environment: 'production', circleOrigin: 'https://daa-sca.circle.com' }),
    ).toEqual({
      circleOrigin: 'https://daa-sca.circle.com',
      ceremonyPath: '/ceremony',
      readyTimeoutMs: 10_000,
      ceremonyTimeoutMs: 300_000,
      resizeIntervalMs: 250,
    })
  })

  it('rejects an origin carrying a path, query or fragment instead of trimming it', () => {
    // Trimming would make the event.origin comparison silently pass for a
    // misconfigured integration.
    for (const origin of [
      'https://daa-sca.circle.com/',
      'https://daa-sca.circle.com/ceremony',
      'https://daa-sca.circle.com?a=1',
      'https://daa-sca.circle.com#x',
    ]) {
      expect(() => resolveConfig({ environment: 'production', circleOrigin: origin })).toThrow(
        /bare origin/,
      )
    }
  })

  it('rejects a non-https origin but allows http on localhost outside production', () => {
    expect(() =>
      resolveConfig({ environment: 'sandbox', circleOrigin: 'http://evil.example' }),
    ).toThrow(/https/)
    expect(() =>
      resolveConfig({ environment: 'sandbox', circleOrigin: 'http://localhost:3000' }),
    ).not.toThrow()
  })

  it('exempts only http on localhost, not every scheme on localhost', () => {
    // The exemption used to be `protocol !== 'https:' && hostname !==
    // 'localhost'` — an AND, so a localhost hostname skipped the scheme check
    // entirely. `ftp://localhost` and `ws://localhost` also produce a
    // well-formed `URL.origin`, so they cleared the bare-origin check too.
    for (const origin of ['ftp://localhost', 'ws://localhost', 'wss://localhost']) {
      expect(() => resolveConfig({ environment: 'sandbox', circleOrigin: origin })).toThrow(/https/)
    }
  })

  it('does not exempt loopback addresses, only the literal localhost', () => {
    // Narrow on purpose: widening the exemption is the opposite of the point.
    expect(() =>
      resolveConfig({ environment: 'sandbox', circleOrigin: 'http://127.0.0.1:3000' }),
    ).toThrow(/https/)
  })

  it('rejects a non-positive or non-finite duration instead of passing it through', () => {
    // `??` only catches `undefined`. A zero or negative timeout fires
    // immediately and NaN never fires at all — both surface as an
    // unexplained ceremony failure far from the config that caused it.
    const base = { environment: 'production' as const }
    for (const field of ['readyTimeoutMs', 'ceremonyTimeoutMs', 'resizeIntervalMs'] as const) {
      for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(() => resolveConfig({ ...base, [field]: value })).toThrow(
          new RegExp(`${field} must be a finite positive number`),
        )
      }
    }
  })

  it('accepts an explicit positive duration', () => {
    expect(
      resolveConfig({
        environment: 'production',
        circleOrigin: 'https://daa-sca.circle.com',
        readyTimeoutMs: 1,
      }).readyTimeoutMs,
    ).toBe(1)
  })

  it('rejects a malformed URL and a relative ceremonyPath', () => {
    expect(() => resolveConfig({ environment: 'production', circleOrigin: 'not a url' })).toThrow(
      /valid URL/,
    )
    expect(() =>
      resolveConfig({
        environment: 'production',
        circleOrigin: 'https://daa-sca.circle.com',
        ceremonyPath: 'ceremony',
      }),
    ).toThrow(/must start with/)
  })

  // The ceremony URL is loaded as written, in a DOM attribute page scripts can
  // read; it carries the path and nothing else.
  it('rejects a ceremonyPath carrying a query or fragment', () => {
    for (const ceremonyPath of ['/ceremony#legacy', '/ceremony?x=1', '/ceremony#', '/ceremony?']) {
      expect(() =>
        resolveConfig({
          environment: 'production',
          circleOrigin: 'https://daa-sca.circle.com',
          ceremonyPath,
        }),
      ).toThrow(/no query or fragment/)
    }
  })
})

describe('frameAllowAttribute', () => {
  it('scopes all three policies to the Circle origin', () => {
    const allow = frameAllowAttribute('https://daa-sca.circle.com')
    expect(allow).toBe(
      'publickey-credentials-get https://daa-sca.circle.com; ' +
        'publickey-credentials-create https://daa-sca.circle.com; ' +
        'payment https://daa-sca.circle.com',
    )
  })

  it('includes payment even though the SPC branch is deferred', () => {
    // Enrollment in a cross-origin frame is gated by `payment`, not by
    // publickey-credentials-create (Integration Plan §2.4). Dropping it makes
    // enrollment fall back to a popup.
    expect(frameAllowAttribute('https://x.example')).toContain('payment https://x.example')
  })
})

describe('ceremonyUrl', () => {
  it('carries no token, so page scripts and Resource Timing never see one', () => {
    // The token is delivered by postMessage in answer to `token-request`.
    const url = ceremonyUrl('https://daa-sca.circle.com', '/ceremony')
    expect(url).toBe('https://daa-sca.circle.com/ceremony')
    expect(new URL(url).hash).toBe('')
    expect(new URL(url).search).toBe('')
  })
})

describe('environment', () => {
  /**
   * These strings are the deployment the ceremony app actually serves
   * (its `CANONICAL_URL` and external ingress rule per environment).
   * Pinned here because a wrong origin does not error anywhere — it makes the
   * host reject every message from the real frame, and the ceremony dies at
   * the ready timeout with a `Transport` that names nothing.
   */
  it('maps each environment to the origin the ceremony app serves', () => {
    const origins = DAA_ENVIRONMENTS.map(
      (environment) => resolveConfig({ environment }).circleOrigin,
    )
    expect(origins).toEqual(['https://daa-sca-sandbox.circle.com', 'https://daa-sca.circle.com'])
  })

  it('names the valid environments when given one that is not', () => {
    // Reachable from plain JavaScript, or from a distributor reading the value
    // out of their own runtime config. Without this, `undefined` would be
    // compared against every inbound origin and reject everything.
    expect(() =>
      resolveConfig({ environment: 'prod' as unknown as (typeof DAA_ENVIRONMENTS)[number] }),
    ).toThrow(/environment must be one of sandbox, production/)
  })

  it('exposes only sandbox and production, with or without an override', () => {
    // Only the public environments are names. Anything else is reached through
    // `circleOrigin`, so an internal name is an unknown environment like any
    // other — even when an override would otherwise have decided the origin.
    expect(DAA_ENVIRONMENTS).toEqual(['sandbox', 'production'])
    for (const environment of ['development', 'test']) {
      const env = environment as unknown as (typeof DAA_ENVIRONMENTS)[number]
      expect(() => resolveConfig({ environment: env })).toThrow(/environment must be one of/)
      expect(() =>
        resolveConfig({ environment: env, circleOrigin: 'https://daa-sca-test.circle.com' }),
      ).toThrow(/environment must be one of/)
    }
  })

  it('reaches another Circle ceremony host through sandbox and circleOrigin', () => {
    // How Circle's own testing targets a host outside the public set.
    expect(
      resolveConfig({ environment: 'sandbox', circleOrigin: 'https://daa-sca-test.circle.com' })
        .circleOrigin,
    ).toBe('https://daa-sca-test.circle.com')
  })

  it('lets non-production environments use an explicit circleOrigin for local dev', () => {
    expect(
      resolveConfig({ environment: 'sandbox', circleOrigin: 'http://localhost:3000' }).circleOrigin,
    ).toBe('http://localhost:3000')
  })
})
