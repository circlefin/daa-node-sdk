import type { ScaErrorCode } from './errors.js'

/**
 * The postMessage contract between this SDK (distributor origin) and the Circle
 * ceremony document (Circle origin).
 *
 * This module is the *only* place the two halves agree, so it lives here rather
 * than being restated on either side.
 *
 * **Published as `@circle-fin/daa-web-sdk/protocol`, and that subpath is for
 * the Circle ceremony app — not for distributors.** It is a separate entry
 * rather than part of `.` because the ceremony app is in another repository and
 * needs the envelope, while a distributor needs none of it: reading or writing
 * these messages is the SDK's job on their behalf. A distributor handling
 * `message` events itself would be reimplementing the origin and source checks
 * the trust boundary depends on.
 */

/**
 * Channel discriminator.
 *
 * A distributor page receives `message` events from analytics, wallet
 * extensions, embedded players and anything else on the page. Every message is
 * namespaced so this SDK can ignore traffic that is not its own without
 * inspecting it further.
 */
export const SCA_CHANNEL = 'circle.daa.sca' as const

/**
 * Envelope version.
 *
 * Bumped only for a breaking envelope change. A mismatch is reported as
 * `Protocol` rather than being coerced, because the frame and the SDK are
 * served from the same Circle deployment: disagreement means skew that a
 * consumer cannot fix by retrying.
 */
export const SCA_PROTOCOL_VERSION = 1 as const

/**
 * Which of the two flows a ceremony is.
 *
 * Mirrors the `kind` discriminator on DAA's `CeremonyFrame`
 * (`GET /v1/daa/frame/ceremony`), whose values are exactly these two.
 *
 * Named `CeremonyFrameKind` rather than `CeremonyKind` on purpose: DAA already
 * has a **different** field called `ceremonyKind`, on
 * `OpenScaChallengeRequest`, whose values are `"webauthn"` and the
 * V2-deferred `"spc"`. Those are two unrelated axes — which flow versus which
 * WebAuthn branch — and one of them will have to appear in this SDK once SPC
 * ships. Leaving `CeremonyKind` free for DAA's meaning keeps that from
 * becoming a silent mix-up across the boundary.
 */
export type CeremonyFrameKind = 'registration' | 'challenge'

interface Envelope {
  readonly channel: typeof SCA_CHANNEL
  readonly version: number
}

/**
 * Frame has loaded and asks for its ceremony token.
 *
 * The ceremony URL carries no token. One in `iframe.src` is readable by any
 * script on the distributor's page — session replay and analytics tools
 * capture DOM attributes by default — and survives in the page's Resource
 * Timing buffer after the frame is removed. So the frame loads bare and the
 * host answers this with `HostTokenMessage`.
 */
export interface FrameTokenRequestMessage extends Envelope {
  readonly kind: 'token-request'
}

/** Frame has loaded, read its ceremony, and is ready to be shown. */
export interface FrameReadyMessage extends Envelope {
  readonly kind: 'ready'
  readonly ceremony: CeremonyFrameKind
}

/** Frame's content height, in CSS pixels. */
export interface FrameResizeMessage extends Envelope {
  readonly kind: 'resize'
  readonly height: number
}

/**
 * Ceremony completed. `payload` is the browser's own
 * `RegistrationResponseJSON` / `AuthenticationResponseJSON`, relayed verbatim.
 *
 * Typed as `unknown` deliberately: the SDK is a relay and must not reshape,
 * re-serialize or inspect it.
 */
export interface FrameResultMessage extends Envelope {
  readonly kind: 'result'
  readonly ceremony: CeremonyFrameKind
  readonly payload: unknown
}

/** Ceremony failed inside the frame. */
export interface FrameErrorMessage extends Envelope {
  readonly kind: 'error'
  readonly code: ScaErrorCode
  /** Optional message, capped at 2,048 UTF-16 code units by the SDK reader. */
  readonly message?: string
}

/**
 * User dismissed the error view inside the frame.
 *
 * The frame posts this after displaying an error to the user and the user
 * clicks the close/dismiss button. The SDK tears down the frame on receipt,
 * allowing the frame to control when the error UI disappears rather than
 * having the SDK remove the iframe the moment an error is signaled.
 */
export interface FrameDismissMessage extends Envelope {
  readonly kind: 'dismiss'
}

export type FrameMessage =
  | FrameTokenRequestMessage
  | FrameReadyMessage
  | FrameResizeMessage
  | FrameResultMessage
  | FrameErrorMessage
  | FrameDismissMessage

/**
 * Host → frame acknowledgment of `ready`.
 *
 * The frame may finish before the host has attached its listener (a cached
 * passkey resolves fast). The frame therefore waits for this ack before
 * emitting `result`, so a completed ceremony is never posted into the void.
 */
export interface HostAckMessage extends Envelope {
  readonly kind: 'ack'
}

export const hostAck = (): HostAckMessage => ({
  channel: SCA_CHANNEL,
  version: SCA_PROTOCOL_VERSION,
  kind: 'ack',
})

/**
 * Host → frame answer to `token-request`.
 *
 * Posted once, to `circleOrigin`, into the frame's own `contentWindow` — never
 * `"*"`, which would hand the capability to whatever document the frame had
 * navigated to.
 */
export interface HostTokenMessage extends Envelope {
  readonly kind: 'token'
  readonly token: string
}

export const hostToken = (token: string): HostTokenMessage => ({
  channel: SCA_CHANNEL,
  version: SCA_PROTOCOL_VERSION,
  kind: 'token',
  token,
})

/** The envelope every message carries, written once for both directions. */
const ENVELOPE = { channel: SCA_CHANNEL, version: SCA_PROTOCOL_VERSION } as const

/**
 * Builders for the frame's half of the contract.
 *
 * The ceremony app has to *produce* these six; this SDK only reads them. They
 * live here for the same reason `parseFrameMessage` does — so the channel name
 * and the envelope version are written once. An app that hand-assembled these
 * objects would be the second place the envelope is defined, and the first
 * place it drifts.
 *
 * Each returns its specific message type rather than the `FrameMessage` union,
 * so the app gets a compile error for a missing field instead of a `Protocol`
 * failure at runtime.
 */
export const frameTokenRequest = (): FrameTokenRequestMessage => ({
  ...ENVELOPE,
  kind: 'token-request',
})

export const frameReady = (ceremony: CeremonyFrameKind): FrameReadyMessage => ({
  ...ENVELOPE,
  kind: 'ready',
  ceremony,
})

/** `height` is the content height in CSS pixels. */
export const frameResize = (height: number): FrameResizeMessage => ({
  ...ENVELOPE,
  kind: 'resize',
  height,
})

/**
 * `payload` is the browser's own `RegistrationResponseJSON` /
 * `AuthenticationResponseJSON`, passed in as the browser produced it. Do not
 * reshape or re-serialize it: re-encoding any nested field invalidates the
 * signature over it.
 */
export const frameResult = (ceremony: CeremonyFrameKind, payload: unknown): FrameResultMessage => ({
  ...ENVELOPE,
  kind: 'result',
  ceremony,
  payload,
})

/**
 * `message` is optional and free-form. It is surfaced to the distributor as
 * `ScaError.message`, so it must not carry anything user-identifying or
 * anything about Circle's internals. The SDK caps received text at 2,048
 * UTF-16 code units before exposing it.
 */
export const frameError = (code: ScaErrorCode, message?: string): FrameErrorMessage => ({
  ...ENVELOPE,
  kind: 'error',
  code,
  ...(message === undefined ? {} : { message }),
})

/** User dismissed the error view. See `FrameDismissMessage`. */
export const frameDismiss = (): FrameDismissMessage => ({
  ...ENVELOPE,
  kind: 'dismiss',
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const ERROR_CODES: ReadonlySet<string> = new Set<ScaErrorCode>([
  'Cancelled',
  'Expired',
  'Unsupported',
  'NotEnrolled',
  'AlreadyEnrolled',
  'Transport',
  'Protocol',
])

const CEREMONY_KINDS: ReadonlySet<string> = new Set<CeremonyFrameKind>([
  'registration',
  'challenge',
])

// Error text is surfaced to integrators and may be logged. Bound it even
// though only the Circle-origin frame can send it.
const MAX_FRAME_ERROR_MESSAGE_LENGTH = 2_048

const asCeremonyFrameKind = (value: unknown): CeremonyFrameKind | null =>
  typeof value === 'string' && CEREMONY_KINDS.has(value) ? (value as CeremonyFrameKind) : null

type Reader = (data: Record<string, unknown>) => FrameMessage | null

const readTokenRequest: Reader = () => ({ ...ENVELOPE, kind: 'token-request' })

const readReady: Reader = (data) => {
  const ceremony = asCeremonyFrameKind(data.ceremony)
  return ceremony === null ? null : { ...ENVELOPE, kind: 'ready', ceremony }
}

const readResize: Reader = (data) => {
  const { height } = data
  if (typeof height !== 'number' || !Number.isFinite(height) || height < 0) return null
  return { ...ENVELOPE, kind: 'resize', height }
}

const readResult: Reader = (data) => {
  const ceremony = asCeremonyFrameKind(data.ceremony)
  // `payload` is intentionally unvalidated here: the envelope layer's job is
  // to establish that this is a well-formed `result`, and rejecting a missing
  // response object is the ceremony runner's call so the two failures stay
  // distinguishable.
  return ceremony === null ? null : { ...ENVELOPE, kind: 'result', ceremony, payload: data.payload }
}

const readError: Reader = (data) => {
  const { code, message } = data
  if (typeof code !== 'string' || !ERROR_CODES.has(code)) return null
  return {
    ...ENVELOPE,
    kind: 'error',
    code: code as ScaErrorCode,
    ...(typeof message === 'string'
      ? { message: message.slice(0, MAX_FRAME_ERROR_MESSAGE_LENGTH) }
      : {}),
  }
}

const readDismiss: Reader = () => ({ ...ENVELOPE, kind: 'dismiss' })

/**
 * One reader per message kind.
 *
 * A `Map` rather than an object literal, deliberately: `data.kind` is
 * attacker-controlled, and an object lookup would resolve `'constructor'` or
 * `'__proto__'` to something inherited from `Object.prototype` and then call
 * it. A `Map` has no prototype chain to walk into.
 */
const READERS: ReadonlyMap<string, Reader> = new Map<string, Reader>([
  ['token-request', readTokenRequest],
  ['ready', readReady],
  ['resize', readResize],
  ['result', readResult],
  ['error', readError],
  ['dismiss', readDismiss],
])

/**
 * Strict, total reader for an inbound `message` payload.
 *
 * Never throws: it is fed arbitrary cross-origin data. Returns `null` for
 * anything that is not a well-formed message on this channel — including a
 * version mismatch, which the caller reports as `Protocol` only once it has
 * established the message was on our channel at all.
 *
 * Dispatches to a per-kind reader rather than validating inline. Each reader
 * stays small enough to read at a glance, each kind's validation sits next to
 * the type it produces, and adding a kind is one reader plus one table entry.
 */
export const parseFrameMessage = (data: unknown): FrameMessage | null => {
  if (!isRecord(data)) return null
  if (data.channel !== SCA_CHANNEL) return null
  if (data.version !== SCA_PROTOCOL_VERSION) return null

  const read = typeof data.kind === 'string' ? READERS.get(data.kind) : undefined
  return read === undefined ? null : read(data)
}

/**
 * True when `data` claims this channel, regardless of whether it parsed.
 *
 * Used to tell "not ours, ignore silently" apart from "ours but malformed or a
 * different envelope version", which is a `Protocol` failure worth surfacing.
 */
export const isOnScaChannel = (data: unknown): boolean =>
  isRecord(data) && data.channel === SCA_CHANNEL

/**
 * The frame's mirror of `parseFrameMessage`: is this the host's `ack`?
 *
 * The ceremony app consumes this module precisely so neither half restates the
 * envelope, and the ack is the one message that travels host → frame. Without
 * this the app has to hand-roll `isOnScaChannel(data) && data.kind === 'ack'`
 * with a cast, skipping the version check — which is the version-skew bug this
 * module exists to make impossible.
 *
 * Total, like every reader here: the frame's `message` handler sees whatever
 * any origin cares to post, so this narrows or returns false and never throws.
 */
export const isHostAck = (data: unknown): data is HostAckMessage =>
  isRecord(data) &&
  data.channel === SCA_CHANNEL &&
  data.version === SCA_PROTOCOL_VERSION &&
  data.kind === 'ack'

/**
 * The frame's reader for `HostTokenMessage`: the token, or `null`.
 *
 * Total, like `isHostAck`. It checks the envelope only — who sent the message
 * is the frame's to check, on `event.source` and, once the ceremony is read,
 * against `postMessageTargetOrigin`.
 */
export const readHostToken = (data: unknown): string | null => {
  if (!isRecord(data)) return null
  if (data.channel !== SCA_CHANNEL || data.version !== SCA_PROTOCOL_VERSION) return null
  if (data.kind !== 'token') return null
  return typeof data.token === 'string' && data.token.length > 0 ? data.token : null
}
