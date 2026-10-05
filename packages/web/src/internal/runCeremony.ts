import type { ResolvedScaSdkConfig } from '../config.js'
import { ScaError } from '../errors.js'
import type { CeremonyFrameKind, FrameReadyMessage, FrameResultMessage } from '../protocol.js'
import { hostAck, hostToken, isOnScaChannel, parseFrameMessage } from '../protocol.js'
import { ceremonyUrl, frameAllowAttribute } from './frameContract.js'
import type { FrameHost, MountedFrame, OpenedWindow } from './frameHost.js'

// Fallback for the error→dismiss window: if the frame never posts `dismiss`
// (e.g. rollout skew where the frame predates the protocol), settle so the
// promise does not hang and the iframe does not leak permanently. Capped by
// what remains of the caller's configured budget, before `ready` as well as
// after it.
const DISMISS_TIMEOUT_MS = 60_000

interface RunCeremonyArgs {
  readonly frameToken: string
  readonly ceremony: CeremonyFrameKind
  readonly container: unknown
  /**
   * A window already opened for this ceremony. When present the ceremony is
   * loaded into it instead of into an iframe in `container`.
   */
  readonly window?: OpenedWindow
  readonly signal?: AbortSignal
}

/**
 * Mounts the Circle ceremony frame, drives it to completion, and resolves with
 * the browser's own ceremony response, relayed verbatim.
 *
 * The ordering below is load-bearing; each step's comment records what breaks
 * without it.
 */
export const runCeremony = (
  config: ResolvedScaSdkConfig,
  host: FrameHost,
  args: RunCeremonyArgs,
): Promise<unknown> => {
  if (args.frameToken.length === 0) {
    return Promise.reject(new ScaError('Transport', 'frameToken must not be empty'))
  }

  return new Promise<unknown>((resolve, reject) => {
    const now = (): number => host.now?.() ?? globalThis.performance.now()
    let settled = false
    let ready = false
    let tokenSent = false
    let latestHeight: number | null = null
    let appliedHeight: number | null = null
    let pendingError: ScaError | null = null
    // The latest the caller's configured timeouts let this ceremony settle: a
    // `ready` arriving just inside the ready timeout, then the full ceremony
    // timeout after it. `onReady` tightens it to the real deadline. It bounds
    // the error→dismiss window, so a frame that errors before `ready` cannot
    // hold the promise open past what the caller configured either.
    let ceremonyDeadline = now() + config.readyTimeoutMs + config.ceremonyTimeoutMs

    let frame: MountedFrame | undefined
    const teardowns: Array<() => void> = []
    // Separate list so timers can be canceled on frameError without removing
    // the message listener or destroying the frame.
    const timerCancels: Array<() => void> = []

    // Registration goes through a named function rather than a bare
    // `teardowns.push` at each site: the comment above each registration is
    // the reason that teardown exists, and appending in one combined call
    // would strand those comments away from what they explain.
    const track = (teardown: () => void): void => {
      teardowns.push(teardown)
    }

    const trackTimer = (cancel: () => void): void => {
      teardowns.push(cancel)
      timerCancels.push(cancel)
    }

    // Cancels all running timers without removing the message listener or
    // destroying the frame. Called on frameError so the frame can display its
    // error UI without being raced by an Expired timeout.
    const cancelTimers = (): void => {
      for (const cancel of timerCancels) {
        cancel()
      }
      timerCancels.length = 0
    }

    const cleanup = (): void => {
      // LIFO: undo in the opposite order of setup, so the timers armed last
      // are canceled first and the listener attached first is removed last.
      //
      // This ordering is inert *today* — `finish()` sets `settled` before
      // calling here, and the handler's `if (settled) return` discards
      // anything that arrives mid-teardown regardless of order. It is kept
      // because it is the discipline that stays correct if that guard moves,
      // not because a live failure depends on it. Note the frame itself is
      // destroyed after this loop, so the frame outlives the listener, not
      // the other way round.
      //
      // A reversed *copy*: `reverse()` mutates in place, so reversing the live
      // list while tearing it down leaves a half-processed array behind if a
      // teardown re-enters. Drained before the first call for the same reason.
      const ordered = [...teardowns].reverse()
      teardowns.length = 0
      for (const teardown of ordered) {
        try {
          teardown()
        } catch {
          // A failing teardown must not mask the ceremony's own outcome.
        }
      }
      frame?.destroy()
    }

    const finish = (
      outcome: { ok: true; payload: unknown } | { ok: false; error: ScaError },
    ): void => {
      if (settled) return
      settled = true
      cleanup()
      if (outcome.ok) resolve(outcome.payload)
      else reject(outcome.error)
    }

    const fail = (code: ScaError['code'], message: string): void =>
      finish({ ok: false, error: pendingError ?? new ScaError(code, message) })

    // The `ready` and `result` bodies are named functions rather than inline
    // switch cases. Both carry their own branch-crossing and shape checks, and
    // inlining all four kinds pushed the message handler past the cognitive
    // complexity the quality gate allows — the same pressure that split
    // `parseFrameMessage` into per-kind readers. Each one is now readable on
    // its own, and the handler below is the gate plus a dispatch.
    const applyLatestHeight = (): void => {
      if (latestHeight !== null && latestHeight !== appliedHeight) {
        appliedHeight = latestHeight
        frame?.setHeight(latestHeight)
      }
    }

    // The token goes to the frame's own `contentWindow`, targeted at
    // `circleOrigin`: if the frame has navigated anywhere else, the browser
    // drops it rather than delivering it. Once only — the frame keeps the first
    // token it receives, so a second answer could never change the ceremony,
    // and a request after `ready` or an error has nothing left to unlock.
    const onTokenRequest = (): void => {
      if (tokenSent || ready || pendingError !== null) return
      tokenSent = true
      frame?.post(hostToken(args.frameToken), config.circleOrigin)
    }

    const onReady = (message: FrameReadyMessage): void => {
      if (ready) return
      if (message.ceremony !== args.ceremony) {
        // The same branch-crossing check `onResult` makes, for the same
        // reason. Without it a `ready` for the other kind arms the ceremony
        // and resize timers for a ceremony this frame is not running, and
        // answers it with an `ack`. The origin and source gates bound who can
        // reach this today, so it is a consistency gap rather than a live
        // hole — but checking one kind and not the other is how the next
        // reader concludes the check is unnecessary.
        fail(
          'Protocol',
          `Expected a ${args.ceremony} ceremony but the frame reported ${message.ceremony}`,
        )
        return
      }
      ready = true
      frame?.post(hostAck(), config.circleOrigin)

      // Budget starts at ready, not at mount: a slow load should surface as
      // `Transport` via the ready timeout, not eat the user's time to approve.
      ceremonyDeadline = now() + config.ceremonyTimeoutMs
      trackTimer(
        host.setTimeout(
          () => fail('Expired', 'The ceremony expired before it completed'),
          config.ceremonyTimeoutMs,
        ),
      )

      // Height is applied from a timer. `requestAnimationFrame` and a
      // `ResizeObserver`'s first delivery are both tied to the frame being
      // rendered, which a cross-origin iframe in normal page flow is not
      // guaranteed to be.
      trackTimer(host.setInterval(applyLatestHeight, config.resizeIntervalMs))

      // Except the first one, which is applied as soon as it is known — here
      // if it arrived before `ready`, on receipt otherwise. Until then the
      // frame sits at a placeholder height, and waiting out an interval tick
      // is the difference between the content landing and the panel jumping
      // after it. The interval is there to coalesce a burst of resizes, and
      // the first one is not part of a burst.
      applyLatestHeight()
    }

    const onResult = (message: FrameResultMessage): void => {
      if (message.ceremony !== args.ceremony) {
        // Branch crossing: a registration response answering a challenge, or
        // the reverse. Rejected here as well as server-side.
        fail(
          'Protocol',
          `Expected a ${args.ceremony} result but the frame reported ${message.ceremony}`,
        )
        return
      }
      if (typeof message.payload !== 'object' || message.payload === null) {
        fail('Protocol', 'The ceremony surface returned no response object')
        return
      }
      // Relayed as received. The SDK does not reshape, re-serialize or inspect
      // it — re-encoding any nested field would invalidate the signature over
      // it.
      finish({ ok: true, payload: message.payload })
    }

    // 1. Listener first, frame second.
    //
    // A cached passkey can resolve fast enough that the frame is done before a
    // listener attached after mount() would exist. Attaching first means a
    // completed ceremony is never posted into the void.
    track(
      host.onMessage((event) => {
        if (settled) return

        // Origin gate. A message claiming our channel from anywhere else is not
        // a protocol error, it is someone else's traffic — ignore silently.
        if (event.origin !== config.circleOrigin) return

        // Source gate. `event.origin` alone would accept a *different* frame on
        // the Circle origin, including one an attacker put on the page.
        if (frame !== undefined && !frame.isSource(event.source)) return

        const message = parseFrameMessage(event.data)
        if (message === null) {
          // On our channel but unreadable: the frame and this SDK are served
          // from the same Circle deployment, so this is skew, not noise.
          if (isOnScaChannel(event.data)) {
            fail(
              'Protocol',
              'The ceremony surface sent an envelope this SDK version does not understand',
            )
          }
          return
        }

        switch (message.kind) {
          case 'token-request':
            // The source gate above lets a message through before `mount()`
            // returns, when there is no frame to compare against yet. Harmless
            // for the kinds that only report; not for the one that is
            // answered with the capability.
            if (frame === undefined) return
            onTokenRequest()
            return

          case 'ready':
            // Ignore ready/result that arrive after frameError: the ceremony
            // is already in the error→dismiss window and a late success would
            // silently discard the reported error.
            if (pendingError !== null) return
            onReady(message)
            return

          case 'resize':
            latestHeight = message.height
            if (ready && appliedHeight === null) applyLatestHeight()
            return

          case 'result':
            if (pendingError !== null) return
            onResult(message)
            return

          case 'error': {
            // The first frame error is authoritative. A repeated error must
            // not replace it or reset the dismissal deadline.
            if (pendingError !== null) return
            // Store the error and cancel all timers so the frame can display
            // its error UI without being raced by an Expired timeout. The
            // frame controls teardown: it posts `dismiss` once the user
            // acknowledges, and the SDK destroys the iframe then.
            pendingError = new ScaError(
              message.code,
              message.message ?? `The ceremony failed: ${message.code}`,
            )
            cancelTimers()
            // Fallback: if dismiss never arrives (e.g. rollout skew where the
            // frame predates this protocol), settle with the stored error so
            // the promise does not hang and the iframe does not leak.
            const errorForTimeout = pendingError
            const remainingCeremonyMs = Math.min(DISMISS_TIMEOUT_MS, ceremonyDeadline - now())
            if (remainingCeremonyMs <= 0) {
              finish({ ok: false, error: errorForTimeout })
              return
            }
            trackTimer(
              host.setTimeout(() => {
                finish({ ok: false, error: errorForTimeout })
              }, remainingCeremonyMs),
            )
            return
          }

          case 'dismiss':
            finish({
              ok: false,
              error:
                pendingError ?? new ScaError('Protocol', 'Frame closed without reporting an error'),
            })
            return
        }
      }),
    )

    // 2. Abort signal, checked before the frame loads.
    //
    // Registered after the listener so the order of cancellation in cleanup
    // mirrors setup: listener last-in, first-out; signal unregistered before
    // the ready timeout fires. Checked synchronously first so an already-
    // aborted signal is caught without waiting for an event.
    if (args.signal !== undefined) {
      if (args.signal.aborted) {
        // Already aborted — skip all further setup and mount.
        finish({ ok: false, error: new ScaError('Cancelled', 'The ceremony was aborted') })
        return
      }
      const onAbort = () =>
        fail('Cancelled', 'The ceremony was aborted before the SDK observed a result')
      const signal = args.signal
      signal.addEventListener('abort', onAbort, { once: true })
      track(() => signal.removeEventListener('abort', onAbort))
    }

    // 3. Ready timeout, armed before the load starts.
    trackTimer(
      host.setTimeout(() => {
        if (!ready) {
          fail('Transport', 'The ceremony surface did not load')
        }
      }, config.readyTimeoutMs),
    )

    // 4. Mount.
    //
    // A fresh element every time, never reused across ceremonies: every
    // ceremony loads the same URL, and the document keeps the first token it
    // is handed — so a reused element would serve the previous ceremony.
    //
    // A window gets the same URL and the same gates, including the token
    // handshake: `load()` returns a `MountedFrame` whose `post` and `isSource`
    // are the popup's. It needs no `allow`: the ceremony is top-level there,
    // so there is nothing to delegate.
    try {
      const src = ceremonyUrl(config.circleOrigin, config.ceremonyPath)
      frame =
        args.window === undefined
          ? host.mount({
              src,
              allow: frameAllowAttribute(config.circleOrigin),
              container: args.container,
            })
          : args.window.load(src)
    } catch (cause) {
      finish({
        ok: false,
        error: new ScaError('Unsupported', 'Could not mount the ceremony surface', { cause }),
      })
    }
  })
}
