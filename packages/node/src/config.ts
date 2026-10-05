/**
 * What a distributor's backend configures, and where each environment lives.
 *
 * The environment model is deliberately the same shape and the same field name
 * as the web SDK's `ScaSdkConfig.environment`: a distributor integrating more
 * than one DAA SDK should not meet two spellings of one platform concept.
 */

import type { DaaTransport } from './transport.js'

/**
 * The DAA environments an integration can target.
 *
 * This is the public set: the two environments a distributor can use. Any
 * other Circle host is reached with an explicit `baseUrl` (with
 * `environment: 'sandbox'`), not by naming it here.
 *
 * Exported as a runtime allow-list, not only a type, so a JavaScript caller
 * passing a value the compile-time type cannot catch fails at construction
 * rather than sending requests to a host that does not exist.
 */
export const DAA_ENVIRONMENTS = ['sandbox', 'production'] as const

export type DaaEnvironment = (typeof DAA_ENVIRONMENTS)[number]

/**
 * The public API origin per environment.
 *
 * These are the external hosts of the API gateway that serves
 * `/v1/accounts/passkeys`; the gateway's hosts are the authority rather than
 * any document about them.
 *
 * Each one pairs with the ceremony origin the web SDK selects for the same
 * environment (`api-sandbox` ↔ `daa-sca-sandbox`, `api` ↔ `daa-sca`). Two SDKs
 * configured with the same `environment` therefore cannot end up pointed at
 * two different deployments, which is the mistake a pair of hand-written
 * hostnames invites.
 */
const ENVIRONMENT_BASE_URLS: Readonly<Record<DaaEnvironment, string>> = {
  sandbox: 'https://api-sandbox.circle.com',
  production: 'https://api.circle.com',
}

/**
 * The EU-residency origin per environment, for an API key whose policy carries
 * `eu_restricted`.
 *
 * These are not aliases. The API gateway's mTLS policy rejects an
 * `eu_restricted` principal arriving on any host outside its configured
 * allowlist — **fail-closed, on every authenticated request**, independent of
 * whether the route opted into mTLS checking. So an `eu_restricted` key
 * pointed at `api.circle.com` does not get a passkey error; it gets `403` on
 * everything, before any of this SDK's routes are reached.
 *
 * These are the gateway's per-environment EU hosts, from the same deployment
 * as the map above. Every public environment has one, so the map is an
 * exhaustive `Record` like the one above: an environment added to
 * `DAA_ENVIRONMENTS` without an EU host fails to compile, rather than an
 * `eu_restricted` key silently falling back to the non-EU host.
 */
const EU_ENVIRONMENT_BASE_URLS: Readonly<Record<DaaEnvironment, string>> = {
  sandbox: 'https://api-sandbox-eu.circle.com',
  production: 'https://api-eu.circle.com',
}

export interface DaaSdkConfig {
  /**
   * Which Circle environment to call: `sandbox` or `production`. Selects the
   * API origin unless `baseUrl` is set.
   */
  readonly environment: DaaEnvironment

  /**
   * The distributor's Circle API key.
   *
   * This is the credential the whole trust boundary is about: it never appears
   * in an error message, and it must never reach a browser. If you find
   * yourself wanting it in front-end code, the web SDK is what you want
   * instead.
   */
  readonly apiKey: string

  /**
   * Set this when Circle has told you your API keys are **EU-restricted**.
   *
   * It selects the EU-residency endpoint for `environment` —
   * `api-eu.circle.com` in production. This is a property of the *key*, not of
   * the environment, which is why the SDK cannot infer it: `eu_restricted`
   * lives in the key's server-side policy, so nothing on this side of the call
   * can see it.
   *
   * Getting it wrong is not subtle, in one direction only. An `eu_restricted`
   * key on a non-EU host is rejected **fail-closed with `403` on every
   * authenticated request** — before any route here is reached, so it does not
   * look like a passkey problem. A key that is *not* `eu_restricted` is
   * accepted on either host, so leaving this unset when you did not need it
   * costs nothing.
   *
   * **An `eu_restricted` key is always also `mtls_required`**, so you will
   * need a `transport` carrying a client certificate as well — the default
   * `fetch` transport cannot present one, and a flagged key without a
   * certificate is `403 "Valid mTLS client certificate required."` on every
   * call. `eu_restricted` is *derived*: it can only be set as a side effect of
   * `mtls_required` already being true when the key was minted.
   *
   * MiCA data residency, not SCA. The two overlap — both concern European
   * customers — but they are different flags on different things: SCA scope
   * follows the entity's legal entity, this follows the API key. An EU
   * entity whose key was minted *without* `mtls_required` carries neither
   * flag, and works on either host with no certificate — which is why this is
   * an explicit option and not something inferred from who the customer is.
   */
  readonly euRestricted?: boolean

  /**
   * Override the API origin outright.
   *
   * Prefer `euRestricted` over hand-typing an EU host. By default, custom
   * origins must be on `circle.com` or one of its subdomains. That is also how
   * a Circle host outside the public environments is reached: keep
   * `environment: 'sandbox'` and set `baseUrl` to the origin Circle gave you.
   * `environment` is still validated, and `euRestricted` is ignored — the
   * origin is used exactly as given. Set `allowNonCircleBaseUrl: true` only for
   * a non-Circle origin Circle has explicitly provided.
   *
   * Must be a bare HTTPS origin. `http://localhost` is allowed only with the
   * explicit opt-in above. Never use an untrusted origin: the entity API key
   * is sent to every configured host.
   */
  readonly baseUrl?: string

  /**
   * Explicitly allow a custom HTTPS `baseUrl` outside `circle.com`, or
   * `http://localhost` for local development. Keep unset for normal use.
   */
  readonly allowNonCircleBaseUrl?: true

  /**
   * Deadline for requests made by the default fetch transport. Defaults to
   * 30 seconds. Must be an integer from 1 to 2,147,483,647 milliseconds.
   * A custom `transport` owns its own timeout policy.
   */
  readonly timeoutMs?: number

  /**
   * How requests reach DAA. Defaults to Node's global `fetch`.
   *
   * Supply one for an entity flagged `mtls_required`, where Cloudflare's edge
   * requires a client certificate — see `DaaTransport`.
   */
  readonly transport?: DaaTransport
}

const validateOrigin = (baseUrl: string, field: string, allowNonCircleBaseUrl: boolean): string => {
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new TypeError(`${field} is not a valid URL: ${baseUrl}`)
  }
  // Checked as a *shape*, not by comparing against the raw string. The URL
  // parser lowercases the scheme and host, so comparing `url.origin` to what
  // the caller wrote rejected `https://API.circle.com` — which has no path,
  // query or fragment — with an error naming the wrong problem.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new TypeError(
      `${field} must be a bare origin with no path, query or fragment (got "${baseUrl}")`,
    )
  }
  if (url.username !== '' || url.password !== '') {
    // Credentials in a base URL would be appended to every request and land in
    // any log that records the URL — and this SDK already has one credential
    // whose whole design is that it never gets there.
    throw new TypeError(`${field} must not carry credentials (got "${baseUrl}")`)
  }
  const isCircleHost = url.hostname === 'circle.com' || url.hostname.endsWith('.circle.com')
  const isLocalhost = url.hostname === 'localhost'
  const isLoopbackHttp = url.protocol === 'http:' && isLocalhost

  if (!isCircleHost && !allowNonCircleBaseUrl) {
    throw new TypeError(
      `${field} host "${url.hostname}" is not a Circle host; set allowNonCircleBaseUrl: true only for an origin Circle provided`,
    )
  }
  if (url.protocol !== 'https:' && !(isLoopbackHttp && allowNonCircleBaseUrl)) {
    throw new TypeError(
      `${field} must be https${allowNonCircleBaseUrl ? ' (except http on localhost)' : ''} (got "${baseUrl}")`,
    )
  }
  return url.origin
}

/**
 * The origin every route is appended to.
 *
 * `environment` is checked with `Object.hasOwn` rather than against
 * `undefined` so the exhaustive `Record` above stays the single list — an
 * environment added to `DAA_ENVIRONMENTS` without an origin fails to compile,
 * and a value that is not in the list at all fails here with the list in the
 * message.
 *
 * It is checked before `baseUrl`, so an override does not make an
 * environment outside the list acceptable: the value is still part of the
 * config, and a name that is not in it would only mislead whoever reads it.
 */
export const resolveBaseUrl = (config: DaaSdkConfig): string => {
  if (!Object.hasOwn(ENVIRONMENT_BASE_URLS, config.environment)) {
    throw new TypeError(
      `environment must be one of ${DAA_ENVIRONMENTS.join(', ')} (got "${String(
        config.environment,
      )}")`,
    )
  }

  if (config.baseUrl !== undefined) {
    return validateOrigin(config.baseUrl, 'baseUrl', config.allowNonCircleBaseUrl === true)
  }

  return config.euRestricted === true
    ? EU_ENVIRONMENT_BASE_URLS[config.environment]
    : ENVIRONMENT_BASE_URLS[config.environment]
}

/** The default request deadline used by the built-in fetch transport. */
export const DEFAULT_TIMEOUT_MS = 30_000

const MAX_TIMEOUT_MS = 2_147_483_647

export const validateTimeoutMs = (timeoutMs: number): number => {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new TypeError(
      `timeoutMs must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds (got ${String(timeoutMs)})`,
    )
  }
  return timeoutMs
}

export const resolveTimeoutMs = (config: DaaSdkConfig): number =>
  validateTimeoutMs(config.timeoutMs ?? DEFAULT_TIMEOUT_MS)
