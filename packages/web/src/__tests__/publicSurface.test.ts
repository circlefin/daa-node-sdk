import { describe, expect, it } from 'vitest'

import * as protocolEntry from '../protocol.js'
import * as publicEntry from '../index.js'

/**
 * The exported surface of a published SDK is a contract with people who cannot
 * be asked to change their code. These two assertions exist so widening either
 * entry is a deliberate edit to this file rather than a side effect of adding
 * a re-export somewhere.
 */
describe('public entry (`.`)', () => {
  it('exports exactly what a distributor integrates against, and nothing else', () => {
    // Types are erased at runtime, so only values appear here. `ScaSdkConfig`,
    // `Presentation`, `ScaErrorCode`, `ScaClient`, `ScaCapabilities`,
    // `CreateScaClientOptions` and `RegistrationResponseJson` are type-only.
    expect(Object.keys(publicEntry).sort()).toEqual([
      // The environment list is a value so a distributor can iterate it (an
      // environment picker in their own config UI) rather than retype it.
      'DAA_ENVIRONMENTS',
      'ScaError',
      'createScaClient',
      'isScaError',
    ])
  })

  it('does not leak the envelope, its reader, or the config normalizer', () => {
    // Each of these is machinery the SDK runs on the distributor's behalf.
    // Exporting any of it here invites a distributor to handle `message`
    // events themselves, which means reimplementing the origin and source
    // checks the trust boundary depends on.
    for (const name of [
      'parseFrameMessage',
      'isOnScaChannel',
      'hostAck',
      'isHostAck',
      'SCA_CHANNEL',
      'SCA_PROTOCOL_VERSION',
      'resolveConfig',
      // The environment→origin map stays internal: it is Circle
      // infrastructure, and exposing it would invite a distributor to pass a
      // host instead of an environment, which is what this replaced.
      'ENVIRONMENT_ORIGINS',
      // The browser seam and its fake. `createDomFrameHost` is reachable only
      // through `createScaClient`; `createFakeFrameHost` ships under
      // `./testing`, which fails closed in a production build.
      'createDomFrameHost',
      'createFakeFrameHost',
      'runCeremony',
      // The seam-injecting factory. `createScaClient` takes no host, so a
      // distributor cannot substitute one and bypass the DOM host's
      // `container instanceof HTMLElement` and `isSource` checks.
      'createScaClientForTesting',
      'createClientWithHost',
      // Envelope builders belong to `./protocol`. A distributor constructing
      // frame messages would be forging the ceremony's own output.
      'frameReady',
      'frameResult',
    ]) {
      expect(publicEntry).not.toHaveProperty(name)
    }
  })
})

describe('ceremony-app entry (`./protocol`)', () => {
  it('exports the envelope the Circle ceremony app needs', () => {
    expect(Object.keys(protocolEntry).sort()).toEqual([
      'SCA_CHANNEL',
      'SCA_PROTOCOL_VERSION',
      // The frame's half: it produces these, this SDK only reads them.
      'frameDismiss',
      'frameError',
      'frameReady',
      'frameResize',
      'frameResult',
      'frameTokenRequest',
      'hostAck',
      'hostToken',
      'isHostAck',
      'isOnScaChannel',
      'parseFrameMessage',
      'readHostToken',
    ])
  })

  it('does not export the config normalizer either', () => {
    // `resolveConfig` is internal to `createScaClient`. The ceremony app has
    // no config of this shape to normalize.
    expect(protocolEntry).not.toHaveProperty('resolveConfig')
  })
})

describe('testing entry (`./testing`)', () => {
  it('is the only place the browser seam can be injected', async () => {
    const testingEntry = await import('../testing.js')
    expect(Object.keys(testingEntry)).toContain('createScaClientForTesting')
    expect(Object.keys(testingEntry)).toContain('createFakeFrameHost')
  })
})
