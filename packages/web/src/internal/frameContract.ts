/**
 * Pure helpers that define what the ceremony frame is handed.
 *
 * Deliberately free of DOM: these are part of the wire contract with the
 * ceremony app, not part of the browser host, and they are asserted by tests
 * that need no browser.
 */

/**
 * Permissions Policy the frame needs, scoped to the Circle origin.
 *
 * Set by the SDK, never by the distributor: a typo here fails WebAuthn with an
 * error that names nothing, so it is not something to ask an integrator to
 * hand-write (Integration Plan §6.1).
 *
 * `payment` is not optional even with the SPC branch deferred — measured
 * behavior is that enrollment in a cross-origin frame is gated by `payment`,
 * not by `publickey-credentials-create` (Integration Plan §2.4). Omitting it
 * makes enrollment fall back to a popup.
 */
export const frameAllowAttribute = (circleOrigin: string): string =>
  [
    `publickey-credentials-get ${circleOrigin}`,
    `publickey-credentials-create ${circleOrigin}`,
    `payment ${circleOrigin}`,
  ].join('; ')

/**
 * Ceremony document URL. Carries no token.
 *
 * The token used to ride the fragment, which kept it out of server logs and
 * `Referer` but not out of the distributor's page: `iframe.src` is a DOM
 * attribute any script there can read, and the frame's Resource Timing entry
 * keeps the fragment for the life of the document — past `destroy()`, and
 * readable by an observer registered after the ceremony ended. The token is
 * delivered by `postMessage` instead, in answer to the frame's
 * `token-request`; see `runCeremony`.
 */
export const ceremonyUrl = (circleOrigin: string, ceremonyPath: string): string =>
  `${circleOrigin}${ceremonyPath}`
