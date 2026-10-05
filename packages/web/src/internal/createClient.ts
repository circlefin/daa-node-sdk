/**
 * The client factory, with the browser seam as an explicit parameter.
 *
 * Internal so the seam has exactly two entry points, both deliberate: the
 * public `createScaClient` (no seam, always the real DOM host) and
 * `createScaClientForTesting` under the `./testing` subpath.
 *
 * That is a **supported-API boundary, not a security boundary.** `./testing`
 * is in `exports`, so a distributor who imports `createScaClientForTesting`
 * can inject a host in production. What the split buys is that doing so is an
 * unmistakable, unsupported act rather than an option sitting on the function
 * every integrator already calls. It buys nothing against an adversary:
 * whoever controls the page's JavaScript can replace this SDK wholesale. The
 * boundary that does hold is the Circle-origin iframe plus the server-side
 * checks behind it.
 */

import type { Presentation, ScaSdkConfig } from '../config.js'
import { resolveConfig } from '../config.js'
import { ScaError } from '../errors.js'
import type {
  ScaCapabilities,
  ScaCeremonyOptions,
  ScaClient,
  RegistrationResponseJson,
} from '../clientTypes.js'
import type { CeremonyFrameKind } from '../protocol.js'
import { SCA_PROTOCOL_VERSION } from '../protocol.js'
import type { FrameHost, OpenedWindow } from './frameHost.js'
import { createDomFrameHost } from './frameHost.js'
import { runCeremony } from './runCeremony.js'

/**
 * The dialog's accessible name when `presentation.title` is omitted.
 *
 * Deliberately not the ceremony's heading. "Add a security key" and "Confirm
 * your payment" are the frame's copy, fetched from Circle inside it, and this
 * side of the trust boundary is never told which one is being shown.
 */
const DEFAULT_MODAL_TITLE = 'Circle security check'

/** What a presentation resolves to once its chrome, if any, is up. */
interface CeremonySurface {
  readonly container: unknown
  /** Set when the ceremony runs top-level rather than in a frame. */
  readonly window?: OpenedWindow
  readonly signal: AbortSignal | undefined
  /** Undoes whatever opening the surface did. Idempotent. */
  release(): void
}

/**
 * One signal tripped by either the caller's own signal or the surface itself
 * — the modal's X, or the user closing the ceremony window. Both mean the
 * same thing to the state machine, tear down and reject `Cancelled`, so they
 * are composed here rather than given the ceremony two cancellation paths.
 *
 * Composed by hand rather than with `AbortSignal.any`, which is newer than
 * the browsers this SDK otherwise runs on (Chrome 116, Safari 17.4).
 */
const composeAbort = (
  callerSignal: AbortSignal | undefined,
): { readonly controller: AbortController; readonly detach: () => void } => {
  const controller = new AbortController()
  if (callerSignal === undefined) return { controller, detach: () => undefined }
  if (callerSignal.aborted) {
    controller.abort()
    return { controller, detach: () => undefined }
  }
  const onAbort = (): void => controller.abort()
  callerSignal.addEventListener('abort', onAbort, { once: true })
  return { controller, detach: () => callerSignal.removeEventListener('abort', onAbort) }
}

/**
 * The token, or `Cancelled` as soon as `signal` aborts — whichever is first.
 *
 * Raced rather than simply awaited. Abort and closing the surface are
 * documented to reject immediately, and a bare `await` would leave `enroll`
 * pending until the caller's own fetch settled, which on a slow network is
 * the user watching a spinner for a window they already closed. The token
 * promise is not canceled — it is the caller's — only no longer waited on.
 */
const awaitToken = (
  frameToken: PromiseLike<string>,
  signal: AbortSignal | undefined,
): Promise<unknown> =>
  new Promise((resolve, reject) => {
    const cancelled = (): ScaError =>
      new ScaError('Cancelled', 'The ceremony was aborted before the frame token arrived')
    if (signal?.aborted === true) {
      reject(cancelled())
      return
    }
    const onAbort = (): void => reject(cancelled())
    signal?.addEventListener('abort', onAbort, { once: true })
    const detach = (): void => signal?.removeEventListener('abort', onAbort)
    frameToken.then(
      (token) => {
        detach()
        resolve(token)
      },
      (error: unknown) => {
        detach()
        // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the caller's own rejection, rethrown unchanged by contract
        reject(error)
      },
    )
  })

export const createClientWithHost = (config: ScaSdkConfig, injected?: FrameHost): ScaClient => {
  // Resolved eagerly so a bad `circleOrigin` fails at construction rather than
  // mid-ceremony, after a challenge has already been opened and paid for.
  const resolved = resolveConfig(config)
  let host: FrameHost | undefined = injected

  const requireHost = (): FrameHost => {
    if (host !== undefined) return host
    try {
      host = createDomFrameHost(resolved.circleOrigin)
    } catch (cause) {
      // Mapped into the SDK's error model here rather than left to escape.
      // The seam throws a plain `TypeError` — correct for an internal
      // adapter — but callers are told to narrow with `isScaError` and read
      // `err.code`, and a raw `TypeError` is invisible to that. This is the
      // failure a server-side render hits first, so it is the last one that
      // should escape the taxonomy. Same wrapping `runCeremony` applies to a
      // throwing `host.mount()`.
      throw new ScaError(
        'Unsupported',
        'This environment has no DOM, so a ceremony frame cannot be mounted',
        { cause },
      )
    }
    return host
  }

  /**
   * Opens the surface the ceremony runs in, and hands back what `runCeremony`
   * needs to drive it.
   *
   * `inline` is a pass-through — the container is the distributor's and there
   * is nothing to undo. `modal` is the one that has state: chrome to draw,
   * chrome to remove, and a dismissal that has to reach the state machine.
   */
  const validatePresentation = (presentation: Presentation): void => {
    // Both checks below read through `unknown` rather than off the union.
    // `Presentation` has no third member and is not optional, so to the type
    // checker this is dead code — but a distributor on plain JavaScript, or
    // one passing a value out of their own runtime config, reaches here with
    // anything at all, including nothing.
    //
    // The object check is not belt-and-braces for the mode check: it is the
    // difference between the documented failure and an undocumented one. A
    // missing `presentation` makes the property read below throw a raw
    // `TypeError`, which is invisible to the `isScaError(err) && err.code`
    // narrowing every caller is told to use — so the one input most likely to
    // arrive by accident is the one input that escapes the error taxonomy.
    const given: unknown = presentation
    if (typeof given !== 'object' || given === null) {
      throw new ScaError(
        'Unsupported',
        `presentation is required: pass { mode: "inline", container } or { mode: "modal" } (got ${JSON.stringify(given)})`,
      )
    }

    // A mode nobody declared. Without this it is `container: undefined`
    // reaching `mount()`, surfacing as `Unsupported` with no mention of the
    // mode that caused it.
    const declaredMode: unknown = (given as { readonly mode?: unknown }).mode
    if (declaredMode !== 'inline' && declaredMode !== 'modal') {
      throw new ScaError(
        'Unsupported',
        `presentation.mode ${JSON.stringify(declaredMode)} is not a surface this SDK can draw; use { mode: "inline", container } or { mode: "modal" }`,
      )
    }
  }

  const openSurface = (
    presentation: Presentation,
    callerSignal: AbortSignal | undefined,
  ): CeremonySurface => {
    validatePresentation(presentation)

    if (presentation.mode === 'inline') {
      return { container: presentation.container, signal: callerSignal, release: () => undefined }
    }

    // One controller, two ways to trip it: the caller's own signal, and the
    // chrome's X / Escape / backdrop.
    const { controller, detach: detachCaller } = composeAbort(callerSignal)
    const modal = requireHost().openModal({
      // The frame owns the heading the user reads; this is only the dialog's
      // accessible name, which a screen reader announces on open.
      title: presentation.title ?? DEFAULT_MODAL_TITLE,
      dismissible: presentation.dismissible ?? true,
      onDismiss: () => controller.abort(),
    })

    return {
      container: modal.container,
      signal: controller.signal,
      release: () => {
        // Listener first: a caller who keeps their `AbortController` across
        // several ceremonies would otherwise accumulate one listener per run.
        detachCaller()
        modal.close()
      },
    }
  }

  /**
   * Opens the top-level window a ceremony runs in where it cannot run inside a
   * cross-origin frame (see `embeddedCeremony.ts`).
   *
   * `presentation` is still validated, so an integration that is wrong on
   * WebKit is wrong everywhere, but nothing is drawn for it: the window is the
   * surface. A modal left up behind it would be an empty dialog, and an
   * inline container is left as the distributor had it.
   */
  const openWindowSurface = (
    host: FrameHost,
    presentation: Presentation,
    callerSignal: AbortSignal | undefined,
  ): CeremonySurface => {
    validatePresentation(presentation)
    if (host.openWindow === undefined) {
      throw new ScaError(
        'Unsupported',
        'This browser cannot run the ceremony in a frame, and the host cannot open a window',
      )
    }
    const { controller, detach } = composeAbort(callerSignal)
    const opened = host.openWindow({ onClosed: () => controller.abort() })
    if (opened === null) {
      detach()
      // Almost always a call made after an `await` in the click handler,
      // which spends the user activation the popup blocker is looking for.
      throw new ScaError(
        'Unsupported',
        'The browser blocked the Circle ceremony window. Call enroll() or approve() synchronously from the click handler, passing the frame token as a promise if it is still being fetched.',
      )
    }
    return {
      container: undefined,
      window: opened,
      signal: controller.signal,
      release: () => {
        detach()
        opened.close()
      },
    }
  }

  /**
   * Runs one ceremony on its surface, and closes the surface whatever happens.
   *
   * The `finally` is the whole point of routing both methods through here. A
   * modal that stays up after a rejection is not a cosmetic bug: it covers the
   * page with a dialog whose only content has already been destroyed.
   */
  const runOnSurface = async (
    ceremony: CeremonyFrameKind,
    frameToken: string | PromiseLike<string>,
    presentation: Presentation,
    options: ScaCeremonyOptions | undefined,
  ): Promise<unknown> => {
    // Everything up to the `await` below runs synchronously inside the
    // caller's click handler. That is what lets the window open: it has to be
    // up before the token is, because the token comes from the distributor's
    // backend and the click's user activation does not survive the fetch.
    const host = requireHost()
    // Both kinds, not only registration: WebKit refuses `create()` in the
    // frame, and its framed `get()` carries no `topOrigin`, which DAA rejects.
    const inWindow = !(host.supportsEmbeddedCeremonies?.() ?? true)
    const surface = inWindow
      ? openWindowSurface(host, presentation, options?.signal)
      : openSurface(presentation, options?.signal)
    try {
      // A string is used as-is, not awaited: an await would move the mount a
      // microtask later, and a frame that answers from cache inside that gap
      // must still find it mounted. A rejected token promise is the caller's
      // own failure, and is passed through unchanged rather than dressed up
      // as a ceremony error.
      const token: unknown =
        typeof frameToken === 'string' ? frameToken : await awaitToken(frameToken, surface.signal)
      if (typeof token !== 'string') {
        throw new ScaError('Transport', `frameToken must be a string (got ${typeof token})`)
      }
      return await runCeremony(resolved, host, {
        frameToken: token,
        ceremony,
        container: surface.container,
        ...(surface.window === undefined ? {} : { window: surface.window }),
        ...(surface.signal === undefined ? {} : { signal: surface.signal }),
      })
    } finally {
      surface.release()
    }
  }

  return {
    async enroll(frameToken, presentation, options?: ScaCeremonyOptions) {
      const payload = await runOnSurface('registration', frameToken, presentation, options)
      return payload as RegistrationResponseJson
    },

    async approve(frameToken, presentation, options?: ScaCeremonyOptions) {
      // The same machine as `enroll`, on the other ceremony kind. Everything
      // that differs between the two — which credential options the
      // authenticator is given, what copy the user sees, what the signature
      // covers — is decided by DAA and rendered by the frame. From here the
      // only difference is the kind, which is exactly what the branch-crossing
      // checks in `runCeremony` enforce in both directions.
      const payload = await runOnSurface('challenge', frameToken, presentation, options)
      // Serialized here, once, rather than left to each caller. The header
      // takes text; DAA rejects base64url of this JSON by name; and DAA's own
      // `AuthenticationResponseJson` javadoc states that the outer envelope's
      // formatting carries no cryptographic weight, only the base64url fields
      // inside it — which `JSON.stringify` reproduces character for
      // character. So this is the one transformation the relay is allowed to
      // make, and making it is what stops the documented mistake.
      return JSON.stringify(payload)
    },

    capabilities(): ScaCapabilities {
      return {
        protocolVersion: SCA_PROTOCOL_VERSION,
        frame: typeof document !== 'undefined' || injected !== undefined,
        securePaymentConfirmation: 'unknown',
      }
    },
  }
}
