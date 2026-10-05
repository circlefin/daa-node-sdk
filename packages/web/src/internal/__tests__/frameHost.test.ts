import { describe, expect, it } from 'vitest'

import { createDomFrameHost } from '../frameHost.js'

/**
 * The DOM host's *production* paths need a browser and are covered by a
 * separate adapter contract test (see README, "Why there is no jsdom").
 *
 * Its refusal to run without a browser does not: that branch is reachable on
 * plain Node, which is precisely the environment it exists to reject. Left
 * untested it would be the one path an SSR consumer hits first.
 */
describe('createDomFrameHost', () => {
  it('refuses to build without a DOM, naming the seam as the way out', () => {
    expect(() => createDomFrameHost('https://daa-sca.circle.com')).toThrow(
      /requires a browser environment/,
    )
    // The message has to point somewhere: a consumer hitting this on a server
    // render needs to know the fix is to not construct here, not to polyfill.
    expect(() => createDomFrameHost('https://daa-sca.circle.com')).toThrow(/inject a FrameHost/)
  })
})
