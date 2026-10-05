/**
 * The browser seam.
 *
 * Every DOM and timer capability this package needs is reached through
 * `FrameHost`, so the ceremony state machine is unit-testable on plain Node
 * with no DOM environment.
 */

import { supportsEmbeddedCeremonies } from './embeddedCeremony.js'
import type { ModalChromeOptions } from './modalChrome.js'
import { createModalChrome } from './modalChrome.js'

/**
 * How often an open ceremony window is checked for having been closed.
 *
 * Polled because nothing fires on the opener when a cross-origin window it
 * opened is closed: `unload` is on the other side of the boundary, and
 * `closed` is the one property a cross-origin `WindowProxy` still answers.
 */
const WINDOW_CLOSED_POLL_MS = 500

/**
 * Size of the ceremony window. The ceremony document is laid out for the
 * modal's `32rem` panel; this leaves room for the browser's own passkey sheet.
 */
const WINDOW_FEATURES = 'popup,width=480,height=720'

export interface HostMessageEvent {
  readonly origin: string
  /** Opaque `WindowProxy`. Compared by identity only; never read through. */
  readonly source: unknown
  readonly data: unknown
}

export interface MountedFrame {
  /** Applies a content height, in CSS pixels. */
  setHeight(px: number): void
  /** Posts to the framed document with an explicit target origin. */
  post(message: unknown, targetOrigin: string): void
  /**
   * Identity check against this frame's own `contentWindow`.
   *
   * Works cross-origin: a `WindowProxy` reference can be held and compared even
   * though nothing can be read through it. This is the second half of the
   * inbound check — `event.origin` alone would accept a *different* frame on
   * the same Circle origin.
   */
  isSource(source: unknown): boolean
  /** Removes the element. Idempotent. */
  destroy(): void
}

/**
 * What `{ mode: 'modal' }` asks the host for.
 *
 * Every field is already resolved: the factory applies the defaults for
 * `presentation.title` and `presentation.dismissible`, so a host never has to
 * know what they are and a test can read back exactly what was asked for.
 */
export type ModalOptions = ModalChromeOptions

export interface MountedModal {
  /**
   * Where the ceremony frame mounts. Opaque to the state machine, which hands
   * it straight back to `mount()` — the same treatment an inline
   * `presentation.container` gets.
   */
  readonly container: unknown
  /** Removes the chrome. Idempotent. */
  close(): void
}

/**
 * What `openWindow` is told: the one event the state machine needs from a
 * window, which is the user closing it.
 */
export interface WindowOptions {
  /** The user closed the window. Not called for `close()`. */
  readonly onClosed: () => void
}

/**
 * A top-level ceremony window, opened blank and pointed at the ceremony once
 * the token is known.
 *
 * Opened before the token exists because it has to be: a window can only be
 * opened during the user's click, and the token arrives from the
 * distributor's backend after it.
 */
export interface OpenedWindow {
  /**
   * Navigates the window to the ceremony document and returns it as the
   * surface `runCeremony` drives — the same `MountedFrame` an iframe is, with
   * `setHeight` a no-op because the window sizes itself. Called at most once.
   */
  load(src: string): MountedFrame
  /** Closes the window. Idempotent. */
  close(): void
}

export interface FrameHost {
  /** Optional monotonic time seam, used to keep ceremony deadlines bounded. */
  now?(): number
  mount(options: {
    readonly src: string
    readonly allow: string
    readonly container: unknown
  }): MountedFrame
  /**
   * Draws the modal chrome and returns the element to mount into.
   *
   * On the seam rather than in the state machine because it is DOM, and
   * because that is what keeps `{ mode: 'modal' }` testable on plain Node:
   * the fake host records what was asked for and hands back an opaque
   * container, exactly as it does for a frame.
   */
  openModal(options: ModalOptions): MountedModal
  /**
   * Whether a passkey ceremony can run inside a cross-origin frame here. When
   * `false`, `enroll` and `approve` run in a window from `openWindow` instead.
   * See `embeddedCeremony.ts` for why WebKit answers `false`.
   *
   * Optional so a host written before the window surface existed keeps the
   * frame; an omitted method reads as `true`.
   */
  supportsEmbeddedCeremonies?(): boolean
  /**
   * Opens a blank top-level window, **synchronously** — it has to happen
   * inside the user's click, or the popup blocker wins. Returns `null` when
   * the browser blocked it.
   *
   * Required only by a host whose `supportsEmbeddedCeremonies` can return
   * `false`.
   */
  openWindow?(options: WindowOptions): OpenedWindow | null
  /** Subscribes to inbound messages. Returns an unsubscribe function. */
  onMessage(listener: (event: HostMessageEvent) => void): () => void
  /** Returns a cancel function. */
  setTimeout(fn: () => void, ms: number): () => void
  /** Returns a cancel function. */
  setInterval(fn: () => void, ms: number): () => void
}

/**
 * Production `FrameHost`, backed by `document` and `window`.
 *
 * Takes the Circle origin so the `message` listener can drop anything from
 * anywhere else at the seam. `runCeremony` checks the origin again against the
 * same value — that is deliberate defense in depth, not redundancy: the seam
 * makes the check unconditional for anything that reaches this listener, and
 * the state machine's own gate is what stays under test.
 *
 * `createFakeFrameHost` takes the same argument, so the two hosts have the
 * same shape. The fake deliberately does *not* filter, so tests can deliver
 * what this host would drop and exercise `runCeremony`'s gate. A fake that is
 * more permissive than production can only cause a false failure in a test,
 * never a false pass in a distributor's build.
 */
export const createDomFrameHost = (circleOrigin: string): FrameHost => {
  // Compared to `undefined` directly rather than through `typeof`, which is
  // only needed to probe a possibly-undeclared *identifier* — these are
  // property accesses.
  //
  // The `Partial` is not decoration. `lib.dom` declares `document` and
  // `window` as always present, which is a compile-time fiction on exactly
  // the non-browser targets this guard exists for; without it the comparison
  // is "always false" to the type checker and the check reads as dead code.
  const maybeDom = globalThis as Partial<Pick<typeof globalThis, 'document' | 'window'>>
  if (maybeDom.document === undefined || maybeDom.window === undefined) {
    throw new TypeError(
      'createDomFrameHost requires a browser environment; inject a FrameHost on non-DOM targets',
    )
  }

  return {
    now() {
      return globalThis.performance.now()
    },

    mount({ src, allow, container }) {
      if (!(container instanceof HTMLElement)) {
        throw new TypeError('presentation.container must be an HTMLElement')
      }

      const iframe = document.createElement('iframe')
      iframe.setAttribute('allow', allow)
      iframe.setAttribute('title', 'Secured by Circle')
      // Set by the SDK rather than inherited from the embedding page. The
      // ceremony URL carries no token, so this is not about the token — it is
      // that a distributor running
      // `Referrer-Policy: unsafe-url` would otherwise send their full page
      // URL, query string included, to the Circle origin on the frame's first
      // navigation. `strict-origin` keeps the scheme+host Circle needs to
      // recognize the embedder and drops the rest.
      iframe.referrerPolicy = 'strict-origin'
      // Zero-specificity so a distributor's own CSS wins deliberately; the class
      // is a documented styling hook. Only the frame's *contents* are Circle's.
      iframe.className = 'circle-sca-frame'
      iframe.style.border = 'none'
      iframe.style.width = '100%'
      iframe.style.display = 'block'
      // `src` is assigned last: the load must not start before the element is
      // configured, and the host's message listener is already attached by the
      // time mount() is called.
      iframe.src = src
      container.appendChild(iframe)

      let destroyed = false
      return {
        setHeight(px) {
          if (!destroyed) iframe.style.height = `${px}px`
        },
        post(message, targetOrigin) {
          iframe.contentWindow?.postMessage(message, targetOrigin)
        },
        isSource(source) {
          return source !== null && source === iframe.contentWindow
        },
        destroy() {
          if (destroyed) return
          destroyed = true
          iframe.remove()
        },
      }
    },

    openModal(options) {
      return createModalChrome(options)
    },

    supportsEmbeddedCeremonies() {
      return supportsEmbeddedCeremonies(globalThis.navigator)
    },

    openWindow({ onClosed }) {
      // Not `noopener`: the ceremony document asks `window.opener` for its
      // token and posts its result there, and `noopener` would leave it
      // nobody to talk to. A fresh window every time, for the same reason
      // `mount()` makes a fresh iframe: every ceremony loads the same URL, and
      // the document keeps the first token it is handed.
      const popup = window.open('about:blank', '_blank', WINDOW_FEATURES)
      if (popup === null) return null

      let closed = false
      const stop = (): void => {
        if (closed) return
        closed = true
        globalThis.clearInterval(poll)
      }
      const poll = globalThis.setInterval(() => {
        if (!popup.closed) return
        stop()
        onClosed()
      }, WINDOW_CLOSED_POLL_MS)

      const close = (): void => {
        stop()
        if (!popup.closed) popup.close()
      }

      return {
        load(src) {
          navigateWithStrictReferrer(popup, src)
          return {
            setHeight() {
              // A window sizes itself; the posted height is for an iframe.
            },
            post(message, targetOrigin) {
              popup.postMessage(message, targetOrigin)
            },
            isSource(source) {
              return source !== null && source === popup
            },
            destroy: close,
          }
        },
        close,
      }
    },

    onMessage(listener) {
      const handler = (event: MessageEvent): void => {
        // Origin check at the seam. A `message` listener on `globalThis`
        // receives whatever any frame or opener cares to post, so this is the
        // first place the Circle origin can be required.
        if (event.origin !== circleOrigin) return
        listener({ origin: event.origin, source: event.source, data: event.data })
      }
      globalThis.addEventListener('message', handler)
      return () => globalThis.removeEventListener('message', handler)
    },

    setTimeout(fn, ms) {
      const id = globalThis.setTimeout(fn, ms)
      return () => globalThis.clearTimeout(id)
    },

    setInterval(fn, ms) {
      const id = globalThis.setInterval(fn, ms)
      return () => globalThis.clearInterval(id)
    },
  }
}

/**
 * Points a freshly opened blank window at `src` with `strict-origin`, the
 * same referrer policy `mount()` gives the iframe.
 *
 * Not `popup.location.replace(src)`, which takes its referrer policy from the
 * *opener* — so a distributor on `Referrer-Policy: unsafe-url` would send its
 * full page URL, query string included, to the Circle origin. An anchor inside
 * the blank document carries its own `referrerpolicy`, and the blank document
 * is still same-origin with the opener, so it can be written to. The
 * `location` form is kept as a fallback in case a browser hands back a window
 * whose document cannot be reached.
 */
const navigateWithStrictReferrer = (popup: Window, src: string): void => {
  try {
    const doc = popup.document
    const anchor = doc.createElement('a')
    anchor.href = src
    anchor.referrerPolicy = 'strict-origin'
    // The initial blank document always has a body; a browser that
    // disagrees throws here and takes the fallback.
    doc.body.appendChild(anchor)
    anchor.click()
  } catch {
    popup.location.replace(src)
  }
}
