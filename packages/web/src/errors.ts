/**
 * Error taxonomy for SCA ceremonies.
 *
 * The codes are identical across the web, Android, iOS and React Native SDKs so
 * a distributor's error handling is not per-platform.
 *
 * `Cancelled` and `Unsupported` MUST stay distinguishable. Several platforms
 * surface both as a generic "not allowed", and disambiguating them is the SDK's
 * job rather than the distributor's: one means "offer a retry", the other means
 * "take the fallback path".
 */
export type ScaErrorCode =
  /** User dismissed the surface, declined verification, or the caller aborted. */
  | 'Cancelled'
  /** Ceremony expired, or a ready timeout left token state unknown. Request a fresh ceremony before retrying. */
  | 'Expired'
  /** No user-verifying authenticator, or the surface is unavailable. Take the fallback. */
  | 'Unsupported'
  /** No active credential for this client entity. Route to enrollment. */
  | 'NotEnrolled'
  /**
   * This end user already holds a credential, so enrollment cannot proceed.
   * Route to step-up instead.
   *
   * The mirror of `NotEnrolled`, and it has two sources that a distributor
   * cannot tell apart without it. The browser raises `InvalidStateError` when
   * `excludeCredentials` matches an authenticator-resident credential, and DAA
   * rejects a duplicate at the server with
   * `PASSKEY_CREDENTIAL_ALREADY_REGISTERED`. Collapsed into `Cancelled` this
   * reads as "user declined" and the distributor offers a retry that can never
   * succeed; collapsed into `Unsupported` it reads as "this browser cannot".
   */
  | 'AlreadyEnrolled'
  /** Network, or Circle unreachable. If `ready` was not received, the token's state is unknown; get a fresh ceremony before retrying. */
  | 'Transport'
  /**
   * The ceremony surface spoke an envelope this SDK does not understand.
   *
   * Distinct from `Transport` on purpose: the frame is served by Circle from the
   * same origin that serves this SDK, so a version mismatch means a deployment
   * skew, not a consumer-side fault. Retrying will not help.
   */
  | 'Protocol'

export class ScaError extends Error {
  readonly code: ScaErrorCode

  constructor(code: ScaErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ScaError'
    this.code = code
  }
}

export const isScaError = (value: unknown): value is ScaError => value instanceof ScaError
