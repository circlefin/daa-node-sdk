/**
 * The DAA environments an integration can target.
 *
 * Same list and same field name as the other DAA SDKs' `environment`,
 * deliberately: a distributor integrating more than one should not meet two
 * spellings of one platform concept.
 */
export const DAA_ENVIRONMENTS = ['smokebox', 'sandbox', 'staging', 'production'] as const

export type DaaEnvironment = (typeof DAA_ENVIRONMENTS)[number]

/**
 * Where the Circle ceremony document is served, per environment.
 *
 * **The SDK owns these, not the distributor.** They are Circle infrastructure:
 * an integrator has no way to verify one, and getting it wrong fails
 * *silently* — every inbound `message` is dropped by the origin gate, so the
 * ceremony dies at the ready timeout with a `Transport` error that names
 * nothing. Unverifiable config with a silent failure mode does not belong in
 * the caller's hands.
 *
 * DAA verifies against the same four. The server compares
 * `clientDataJSON.origin` to its configured value by exact equality, so these
 * four strings and DAA's four have to stay identical; a mismatch fails every
 * ceremony with `SCA_ORIGIN_NOT_ALLOWED`.
 */
const ENVIRONMENT_ORIGINS: Readonly<Record<DaaEnvironment, string>> = {
  smokebox: 'https://daa-sca-smokebox.circle.com',
  sandbox: 'https://daa-sca-sandbox.circle.com',
  staging: 'https://daa-sca-staging.circle.com',
  production: 'https://daa-sca.circle.com',
}

/** Configuration for a ceremony client. */
export interface ScaSdkConfig {
  /** Which Circle environment to run ceremonies against. */
  readonly environment: DaaEnvironment

  /**
   * Override the ceremony origin for the environment.
   *
   * **For local development and Circle-internal testing only.** In production,
   * only the canonical origin for `environment` is accepted. Elsewhere, a
   * wrong value silently drops messages from the real frame and makes the SDK
   * trust the origin that serves the configured frame.
   *
   * Must be a bare origin, https, or `http://localhost`.
   */
  readonly circleOrigin?: string

  /**
   * Path of the ceremony document on that origin. Defaults to `/ceremony`.
   *
   * Must be absolute and carry no query or fragment: the ceremony URL is part
   * of the contract with the frame, which is loaded bare and handed its token
   * by `postMessage`.
   */
  readonly ceremonyPath?: string

  /**
   * How long to wait for the frame's `ready` before giving up. Defaults to 10s.
   *
   * A timeout means the frame did not signal readiness. The token's state is
   * unknown because the frame may have read it before the signal was sent; get
   * a fresh ceremony before retrying.
   */
  readonly readyTimeoutMs?: number

  /**
   * Wall-clock budget for the whole ceremony once ready. Defaults to 5 minutes,
   * matching the WebAuthn `timeout` the ceremony options carry.
   */
  readonly ceremonyTimeoutMs?: number

  /**
   * How often the posted height is applied to the frame element. Defaults to
   * 250ms. The first height the frame posts is applied on receipt; this
   * paces every change after it.
   *
   * A timer, deliberately: `requestAnimationFrame` and a `ResizeObserver`'s
   * first delivery are both tied to the frame being rendered, which a
   * cross-origin iframe in normal page flow is not guaranteed to be.
   */
  readonly resizeIntervalMs?: number
}

export interface ResolvedScaSdkConfig {
  readonly circleOrigin: string
  readonly ceremonyPath: string
  readonly readyTimeoutMs: number
  readonly ceremonyTimeoutMs: number
  readonly resizeIntervalMs: number
}

const DEFAULTS = {
  ceremonyPath: '/ceremony',
  readyTimeoutMs: 10_000,
  ceremonyTimeoutMs: 300_000,
  resizeIntervalMs: 250,
} as const

/**
 * A millisecond duration, or the default when omitted.
 *
 * `??` alone only catches `undefined`, so `0`, `-1` and `NaN` reached the
 * ceremony as-is: a zero or negative timeout fires immediately and `NaN` never
 * fires at all, both of which surface as an unexplained ceremony failure far
 * from the config that caused it. Validated here for the same reason
 * `circleOrigin` is — so a bad value fails at construction, before a challenge
 * has been opened and paid for.
 */
const durationMs = (value: number | undefined, fallback: number, field: string): number => {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `${field} must be a finite positive number of milliseconds (got ${String(value)})`,
    )
  }
  return value
}

/**
 * Normalizes and validates config once, at client construction.
 *
 * `circleOrigin` must be a bare origin. A value carrying a path, query or
 * fragment is rejected rather than trimmed: it is compared against
 * `event.origin`, which is always a bare origin, so a "helpfully" trimmed value
 * would make the comparison silently pass for a config the integrator got
 * wrong.
 */
export const resolveConfig = (config: ScaSdkConfig): ResolvedScaSdkConfig => {
  // The environment is checked even though the type says it cannot be wrong:
  // a distributor on plain JavaScript, or one reading the value out of their
  // own runtime config, gets a named error here instead of `undefined` being
  // compared against every inbound origin — which would reject everything and
  // surface as an unexplained `Transport` timeout.
  // `Object.hasOwn` rather than comparing the lookup to `undefined`: the map is
  // deliberately an exhaustive `Record`, so adding an environment without an
  // origin is a compile error — which also means the type checker considers a
  // missing key impossible and rejects the comparison as dead code. The check
  // is not dead, though. A distributor on plain JavaScript, or one reading the
  // value out of their own runtime config, would otherwise have `undefined`
  // compared against every inbound origin: everything rejected, surfacing as
  // an unexplained `Transport` timeout.
  if (!Object.hasOwn(ENVIRONMENT_ORIGINS, config.environment)) {
    throw new TypeError(
      `environment must be one of ${DAA_ENVIRONMENTS.join(', ')} (got ${JSON.stringify(config.environment)})`,
    )
  }
  const circleOrigin = config.circleOrigin ?? ENVIRONMENT_ORIGINS[config.environment]

  let url: URL
  try {
    url = new URL(circleOrigin)
  } catch {
    throw new TypeError(`circleOrigin is not a valid URL: ${circleOrigin}`)
  }
  if (url.origin !== circleOrigin) {
    throw new TypeError(
      `circleOrigin must be a bare origin with no path, query or fragment (got "${circleOrigin}", origin is "${url.origin}")`,
    )
  }
  if (config.environment === 'production' && url.origin !== ENVIRONMENT_ORIGINS.production) {
    throw new TypeError('circleOrigin cannot be overridden in production')
  }
  // https everywhere, with exactly one exemption: http on localhost, for local
  // development against a dev ceremony server.
  //
  // Written as an allow-list rather than `protocol !== 'https:' && hostname !==
  // 'localhost'`. That form is an AND, so a localhost hostname skipped the
  // scheme check entirely: `ftp://localhost` and `ws://localhost` were both
  // accepted, and both produce a well-formed `URL.origin` so they cleared the
  // bare-origin check above too. This function is what every inbound `message`
  // origin is compared against, so it fails closed on anything not explicitly
  // allowed. `127.0.0.1` and `[::1]` are deliberately NOT exempt — widening the
  // hole is the opposite of the point.
  const isHttps = url.protocol === 'https:'
  const isLocalhostHttp = url.protocol === 'http:' && url.hostname === 'localhost'
  if (!isHttps && !isLocalhostHttp) {
    throw new TypeError(`circleOrigin must be https, or http on localhost (got "${circleOrigin}")`)
  }

  // Same rigor as `circleOrigin` above, for the same reason: reject rather than
  // trim. The ceremony URL is loaded exactly as written and carries nothing
  // but the path; a `#` or `?` is state the frame never agreed to receive,
  // and in a DOM attribute the distributor's page scripts can read.
  const ceremonyPath = config.ceremonyPath ?? DEFAULTS.ceremonyPath
  if (!ceremonyPath.startsWith('/') || ceremonyPath.includes('#') || ceremonyPath.includes('?')) {
    throw new TypeError(
      `ceremonyPath must start with "/" and carry no query or fragment (got "${ceremonyPath}")`,
    )
  }

  return {
    circleOrigin: url.origin,
    ceremonyPath,
    readyTimeoutMs: durationMs(config.readyTimeoutMs, DEFAULTS.readyTimeoutMs, 'readyTimeoutMs'),
    ceremonyTimeoutMs: durationMs(
      config.ceremonyTimeoutMs,
      DEFAULTS.ceremonyTimeoutMs,
      'ceremonyTimeoutMs',
    ),
    resizeIntervalMs: durationMs(
      config.resizeIntervalMs,
      DEFAULTS.resizeIntervalMs,
      'resizeIntervalMs',
    ),
  }
}

/**
 * Where the SDK puts the ceremony surface.
 *
 * `inline` mounts the frame into an element the distributor owns and lays out.
 * `modal` has the SDK draw the dialog around it — backdrop, panel, close
 * affordance, focus and scroll behavior — so every distributor's ceremony
 * looks the same and none of them has to rebuild it.
 */
export type Presentation =
  | { readonly mode: 'inline'; readonly container: unknown }
  | {
      readonly mode: 'modal'
      /**
       * The dialog's accessible name. Defaults to `Circle security check`.
       *
       * Not the heading the user reads — that is inside the frame, fetched
       * from Circle, and this side of the boundary is never told which
       * ceremony is being shown. This is what a screen reader announces when
       * the dialog opens.
       */
      readonly title?: string
      /**
       * Whether the X, `Escape` and a backdrop click close the dialog.
       * Defaults to `true`.
       *
       * Dismissing this way is the same outcome as aborting: the frame is
       * destroyed and the promise rejects `Cancelled`. The frame keeps its own
       * Cancel button either way, so `false` does not trap the user — it
       * leaves the decision with the surface that knows whether a passkey
       * prompt is currently open.
       */
      readonly dismissible?: boolean
    }
