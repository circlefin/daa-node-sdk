/**
 * Copyright (c) 2026, Circle Internet Group, Inc. All rights reserved.
 *
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { ScaSdkConfig } from './config.js'
import type { ScaClient } from './clientTypes.js'
import { createClientWithHost } from './internal/createClient.js'
import type { FrameHost, HostMessageEvent, MountedFrame } from './internal/frameHost.js'
import type { FrameMessage } from './protocol.js'

// Re-exported here rather than from `.`: these name the browser seam, and the
// only entry that accepts one is `createScaClientForTesting` below. A caller
// who needs to name these types is, by definition, writing a test. (There is
// no seam option on `createScaClient` — it was removed; see `index.ts`.)
export type {
  FrameHost,
  HostMessageEvent,
  ModalOptions,
  MountedFrame,
  MountedModal,
  OpenedWindow,
  WindowOptions,
} from './internal/frameHost.js'

/**
 * `createScaClient` with the browser seam injectable.
 *
 * The public factory takes no host on purpose — a distributor-supplied one
 * would bypass the DOM host's own checks. This is the same client with the
 * seam exposed, and it lives here rather than on `.` so reaching it is a
 * deliberate import from a subpath named `testing`.
 */
export const createScaClientForTesting = (config: ScaSdkConfig, host: FrameHost): ScaClient =>
  createClientWithHost(config, host)

/**
 * In-memory `FrameHost` with a virtual clock, for testing ceremony flows
 * without a DOM.
 *
 * Takes `circleOrigin` like `createDomFrameHost`, and uses it as the *default*
 * origin for `emit` — but unlike the DOM host it does not drop a foreign one,
 * so a test can deliver what production would filter and assert that
 * `runCeremony`'s own origin gate still rejects it. Being more permissive than
 * production is the safe direction for a fake: it can fail a test that would
 * have passed, never pass one that would have failed.
 *
 * Shipped under the `./testing` subpath so it cannot be reached from the
 * package's main entry.
 */

export interface FakeFrame {
  readonly src: string
  readonly allow: string
  readonly container: unknown
  /** Heights applied, in order. Empty until the frame is `ready` and has posted a height. */
  readonly appliedHeights: number[]
  /** Messages the SDK posted into the frame, with their target origins. */
  readonly received: Array<{ readonly message: unknown; readonly targetOrigin: string }>
  destroyed: boolean
  /** Opaque stand-in for `contentWindow`. */
  readonly window: object
}

/**
 * A modal the SDK asked for, and the user's side of it.
 *
 * `title` and `dismissible` are recorded already resolved — the factory
 * applies the defaults before the host is called — so a test asserts what the
 * user would actually get rather than what was passed in.
 */
export interface FakeModal {
  readonly title: string
  readonly dismissible: boolean
  /** Opaque stand-in for the panel element, handed straight to `mount`. */
  readonly container: object
  closed: boolean
  /**
   * The user closing the chrome: the X, `Escape`, or the backdrop.
   *
   * A no-op when `dismissible` is false, because the chrome wires nothing up
   * in that case — so a test cannot dismiss a dialog a user could not.
   */
  dismiss(): void
}

/**
 * A ceremony window the SDK opened, and the user's side of it.
 *
 * Opened blank; `src` stays `null` until the SDK has the token and loads the
 * ceremony, which is the ordering the window path exists for.
 */
export interface FakeWindow {
  src: string | null
  /** Messages the SDK posted into the window, with their target origins. */
  readonly received: Array<{ readonly message: unknown; readonly targetOrigin: string }>
  closed: boolean
  /** Opaque stand-in for the `WindowProxy`. */
  readonly window: object
  /** The user closing the window. A no-op once it is closed. */
  userClose(): void
}

export interface FakeFrameHost extends FrameHost {
  readonly frames: readonly FakeFrame[]
  readonly windows: readonly FakeWindow[]
  /** The most recently opened window, or `undefined` if none was. */
  readonly currentWindow: FakeWindow | undefined
  readonly modals: readonly FakeModal[]
  /** The most recently opened modal, or `undefined` if none was. */
  readonly currentModal: FakeModal | undefined
  /** The most recently mounted frame, or `undefined` before the first mount. */
  readonly currentFrame: FakeFrame | undefined
  readonly listenerCount: number
  /**
   * Delivers a message to the SDK. Defaults to the configured Circle origin and
   * the window of the surface loaded most recently — frame or ceremony
   * window — so a test opts *into* a wrong origin or source
   * rather than having to spell out the correct one every time.
   */
  emit(data: unknown, overrides?: Partial<Omit<HostMessageEvent, 'data'>>): void
  /** Delivers a well-formed frame message. */
  emitFrameMessage(message: FrameMessage, overrides?: Partial<Omit<HostMessageEvent, 'data'>>): void
  /** Advances the virtual clock, firing anything due. */
  advance(ms: number): void
}

interface Scheduled {
  readonly fn: () => void
  readonly intervalMs: number | null
  dueAt: number
  cancelled: boolean
}

// The message builders now live in `./protocol`, where the ceremony app can
// reach them: it has to *produce* these six, and a second copy here would be
// the first place the envelope drifts. Three keep their old short names so a
// test reads `ready(...)` rather than `frameReady(...)`; `frameError` already
// carried the prefix, so it passes through unrenamed.
export {
  frameDismiss as dismiss,
  frameError,
  frameReady as ready,
  frameResize as resize,
  frameResult as result,
  frameTokenRequest as tokenRequest,
} from './protocol.js'

export interface FakeFrameHostOptions {
  readonly circleOrigin: string
  /**
   * What `supportsEmbeddedCeremonies` answers. Defaults to `true`; `false`
   * stands in for WebKit, and sends `enroll` and `approve` to a window.
   */
  readonly embeddedCeremonies?: boolean
  /** Make `openWindow` return `null`, as a popup blocker would. */
  readonly blockWindows?: boolean
}

export const createFakeFrameHost = (options: FakeFrameHostOptions): FakeFrameHost => {
  const frames: FakeFrame[] = []
  const windows: FakeWindow[] = []
  let lastSource: object | undefined
  const modals: FakeModal[] = []
  const listeners = new Set<(event: HostMessageEvent) => void>()
  const scheduled = new Set<Scheduled>()
  let now = 0

  const schedule = (fn: () => void, ms: number, intervalMs: number | null): (() => void) => {
    const entry: Scheduled = { fn, intervalMs, dueAt: now + ms, cancelled: false }
    scheduled.add(entry)
    return () => {
      entry.cancelled = true
      scheduled.delete(entry)
    }
  }

  const host: FakeFrameHost = {
    get frames() {
      return frames
    },
    get currentFrame() {
      return frames.at(-1)
    },
    get windows() {
      return windows
    },
    get currentWindow() {
      return windows.at(-1)
    },
    get modals() {
      return modals
    },
    get currentModal() {
      return modals.at(-1)
    },
    get listenerCount() {
      return listeners.size
    },

    now() {
      return now
    },

    mount({ src, allow, container }) {
      const frame: FakeFrame = {
        src,
        allow,
        container,
        appliedHeights: [],
        received: [],
        destroyed: false,
        window: { frameIndex: frames.length },
      }
      frames.push(frame)
      lastSource = frame.window

      const mounted: MountedFrame = {
        setHeight(px) {
          frame.appliedHeights.push(px)
        },
        post(message, targetOrigin) {
          frame.received.push({ message, targetOrigin })
        },
        isSource(source) {
          return source === frame.window
        },
        destroy() {
          frame.destroyed = true
        },
      }
      return mounted
    },

    openModal({ title, dismissible, onDismiss }) {
      const modal: FakeModal = {
        title,
        dismissible,
        container: { modalIndex: modals.length },
        closed: false,
        dismiss: () => {
          if (dismissible) onDismiss()
        },
      }
      modals.push(modal)
      return {
        container: modal.container,
        close: () => {
          modal.closed = true
        },
      }
    },

    supportsEmbeddedCeremonies() {
      return options.embeddedCeremonies ?? true
    },

    openWindow({ onClosed }) {
      if (options.blockWindows === true) return null
      const opened: FakeWindow = {
        src: null,
        received: [],
        closed: false,
        window: { windowIndex: windows.length },
        userClose: () => {
          if (opened.closed) return
          opened.closed = true
          onClosed()
        },
      }
      windows.push(opened)
      const close = (): void => {
        opened.closed = true
      }
      return {
        load(src) {
          opened.src = src
          lastSource = opened.window
          return {
            setHeight() {
              // A window sizes itself.
            },
            post(message, targetOrigin) {
              opened.received.push({ message, targetOrigin })
            },
            isSource(source) {
              return source === opened.window
            },
            destroy: close,
          }
        },
        close,
      }
    },

    onMessage(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    setTimeout(fn, ms) {
      return schedule(fn, ms, null)
    },

    setInterval(fn, ms) {
      return schedule(fn, ms, ms)
    },

    emit(data, overrides = {}) {
      const event: HostMessageEvent = {
        origin: overrides.origin ?? options.circleOrigin,
        source: 'source' in overrides ? overrides.source : lastSource,
        data,
      }
      // Snapshot, not the live Set: a listener that unsubscribes (or
      // subscribes) while being notified would otherwise change what this
      // loop still has to visit. Named rather than spread inline so it reads
      // as a deliberate copy.
      const snapshot = Array.from(listeners)
      for (const listener of snapshot) listener(event)
    },

    emitFrameMessage(message, overrides) {
      host.emit(message, overrides)
    },

    advance(ms) {
      const target = now + ms
      // Fire in due order so a timeout scheduled by another timer's callback is
      // still honoured within the same advance().
      for (;;) {
        const due = [...scheduled]
          .filter((entry) => !entry.cancelled && entry.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt)
        const next = due[0]
        if (next === undefined) break
        now = next.dueAt
        if (next.intervalMs === null) scheduled.delete(next)
        else next.dueAt = now + next.intervalMs
        next.fn()
      }
      now = target
    },
  }

  return host
}
