import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDomFrameHost } from '../internal/frameHost.js'

/**
 * The real browser adapter, driven directly.
 *
 * Every other suite in this package injects `createFakeFrameHost`, which is
 * what the seam is for — but it also means the one host a distributor
 * actually runs had no coverage at all. The gates that matter most in this
 * SDK live here: the seam's own origin filter, the explicit `targetOrigin` on
 * every outbound post, and the `contentWindow` identity check. A regression in
 * any of them is a security regression, and until now nothing would have
 * caught one.
 *
 * Driven against stubbed globals rather than jsdom, by the convention here:
 * prefer extending that seam over adding a DOM environment. This is not testing the
 * browser — it is testing what this adapter asks the browser to do, which is
 * the part we own. `document`, `window`, `HTMLElement` and the timers are the
 * only globals it touches.
 *
 * **Two origins throughout.** A single-origin test cannot tell "checks the
 * origin" apart from "ignores the origin", which is exactly the bug worth
 * catching.
 */

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'
const OTHER_ORIGIN = 'https://daa-sca-sandbox.circle.com'

/** Minimal stand-ins for the handful of DOM surfaces the adapter touches. */
class FakeElement {
  readonly attributes = new Map<string, string>()
  readonly children: FakeElement[] = []
  contentWindow: object | null = { id: 'frame-window' }
  removed = false

  /**
   * Every write, in order, so "src last" is asserted rather than assumed.
   *
   * It records *all* of them — attributes, plain properties and style — on
   * purpose. An earlier version only recorded `setAttribute` and `src`, which
   * made the ordering assertion vacuous: mutating the adapter to assign
   * `className` after `src` left the recorded order ending in `src` anyway,
   * and the test stayed green. Found by deleting the ordering from the
   * adapter and watching nothing fail.
   */
  static readonly writes: string[] = []

  readonly style: Record<string, string> = new Proxy<Record<string, string>>(
    {},
    {
      set(target, prop, value: string) {
        FakeElement.writes.push(`style:${String(prop)}`)
        target[String(prop)] = value
        return true
      },
    },
  )

  #src = ''
  get src(): string {
    return this.#src
  }
  set src(value: string) {
    FakeElement.writes.push('src')
    this.#src = value
  }

  #className = ''
  get className(): string {
    return this.#className
  }
  set className(value: string) {
    FakeElement.writes.push('className')
    this.#className = value
  }

  #referrerPolicy = ''
  get referrerPolicy(): string {
    return this.#referrerPolicy
  }
  set referrerPolicy(value: string) {
    FakeElement.writes.push('referrerPolicy')
    this.#referrerPolicy = value
  }

  setAttribute(name: string, value: string): void {
    FakeElement.writes.push(`attr:${name}`)
    this.attributes.set(name, value)
  }
  appendChild(child: FakeElement): void {
    this.children.push(child)
  }
  remove(): void {
    this.removed = true
  }
}

type MessageListener = (event: { origin: string; source: unknown; data: unknown }) => void

let listeners: MessageListener[]
let created: FakeElement[]

beforeEach(() => {
  listeners = []
  created = []
  FakeElement.writes.length = 0

  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('iframe')
      const el = new FakeElement()
      created.push(el)
      return el
    },
  })
  vi.stubGlobal('addEventListener', (type: string, fn: MessageListener) => {
    expect(type).toBe('message')
    listeners.push(fn)
  })
  vi.stubGlobal('removeEventListener', (_type: string, fn: MessageListener) => {
    listeners = listeners.filter((l) => l !== fn)
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Delivers to every registered listener, the way the browser would. */
const deliver = (event: { origin: string; source?: unknown; data: unknown }): void => {
  for (const l of [...listeners]) l({ source: null, ...event })
}

const mountOne = (host: ReturnType<typeof createDomFrameHost>) =>
  host.mount({
    src: `${CIRCLE_ORIGIN}/ceremony#tok`,
    allow: 'payment',
    container: new FakeElement(),
  })

describe('createDomFrameHost — the inbound origin gate', () => {
  it('exposes the browser performance clock for ceremony deadlines', () => {
    const performance = { now: vi.fn(() => 123.5) }
    vi.stubGlobal('performance', performance)

    expect(createDomFrameHost(CIRCLE_ORIGIN).now?.()).toBe(123.5)
    expect(performance.now).toHaveBeenCalledOnce()
  })

  it('drops a message from another origin and delivers one from the Circle origin', () => {
    const seen: unknown[] = []
    createDomFrameHost(CIRCLE_ORIGIN).onMessage((e) => seen.push(e.data))

    // A real, plausible other origin — another Circle SCA environment, not a
    // strawman. Mixing up sandbox and production is the realistic mistake.
    deliver({ origin: OTHER_ORIGIN, data: { kind: 'result', payload: 'from-sandbox' } })
    expect(seen).toEqual([])

    deliver({ origin: CIRCLE_ORIGIN, data: { kind: 'result', payload: 'from-prod' } })
    expect(seen).toEqual([{ kind: 'result', payload: 'from-prod' }])
  })

  it('compares the origin exactly, not by prefix or suffix', () => {
    const seen: unknown[] = []
    createDomFrameHost(CIRCLE_ORIGIN).onMessage((e) => seen.push(e.origin))

    for (const origin of [
      'https://daa-sca.circle.com.evil.example',
      'https://evil.example/https://daa-sca.circle.com',
      'http://daa-sca.circle.com',
      `${CIRCLE_ORIGIN}/`,
      `${CIRCLE_ORIGIN}:443`,
    ]) {
      deliver({ origin, data: { kind: 'ready' } })
    }
    expect(seen).toEqual([])
  })

  it('passes origin, source and data through untouched', () => {
    const received: { origin: string; source: unknown; data: unknown }[] = []
    createDomFrameHost(CIRCLE_ORIGIN).onMessage((e) => received.push(e))

    const source = { id: 'some-window' }
    const data = { kind: 'result', payload: { nested: 'value' } }
    deliver({ origin: CIRCLE_ORIGIN, source, data })

    // By identity: the adapter must not clone the payload on the way in. A
    // copy would be structurally equal and have re-encoded nothing visibly,
    // but `isSource` compares the source by reference and the ceremony relays
    // the payload by reference.
    expect(received[0]?.source).toBe(source)
    expect(received[0]?.data).toBe(data)
    expect(received[0]?.origin).toBe(CIRCLE_ORIGIN)
  })

  it('stops delivering once unsubscribed', () => {
    const seen: unknown[] = []
    const unsubscribe = createDomFrameHost(CIRCLE_ORIGIN).onMessage((e) => seen.push(e.data))

    deliver({ origin: CIRCLE_ORIGIN, data: 1 })
    unsubscribe()
    deliver({ origin: CIRCLE_ORIGIN, data: 2 })

    expect(seen).toEqual([1])
    expect(listeners).toHaveLength(0)
  })
})

describe('createDomFrameHost — the outbound target origin', () => {
  it('forwards the target origin verbatim and never substitutes "*"', () => {
    const frame = mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    const posted: { message: unknown; targetOrigin: unknown }[] = []
    created[0]!.contentWindow = {
      postMessage: (message: unknown, targetOrigin: unknown) =>
        posted.push({ message, targetOrigin }),
    }

    frame.post({ kind: 'ack' }, CIRCLE_ORIGIN)

    expect(posted).toEqual([{ message: { kind: 'ack' }, targetOrigin: CIRCLE_ORIGIN }])
    // "*" would broadcast to every ancestor of a frame that is itself
    // embedded. The adapter does not choose this value — it must not rewrite
    // it either.
    expect(posted[0]?.targetOrigin).not.toBe('*')
  })

  it('does not throw when the frame has no contentWindow yet', () => {
    const frame = mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    created[0]!.contentWindow = null

    // A frame removed or not yet navigated. Posting into it is a no-op, not a
    // crash that would take down a ceremony already being torn down.
    expect(() => frame.post({ kind: 'ack' }, CIRCLE_ORIGIN)).not.toThrow()
  })
})

describe('createDomFrameHost — the source identity check', () => {
  it('accepts only this frame’s own contentWindow', () => {
    const frame = mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    const own = created[0]!.contentWindow

    expect(frame.isSource(own)).toBe(true)
    // A different frame on the same Circle origin: the exact case
    // `event.origin` alone cannot tell apart.
    expect(frame.isSource({ id: 'another-frame-on-the-same-origin' })).toBe(false)
    expect(frame.isSource(null)).toBe(false)
    expect(frame.isSource(undefined)).toBe(false)
  })

  it('does not match when the frame never had a contentWindow', () => {
    const frame = mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    created[0]!.contentWindow = null

    // Guards the `source !== null` half: without it, a message whose source
    // is null would match a frame whose contentWindow is also null.
    expect(frame.isSource(null)).toBe(false)
  })
})

describe('createDomFrameHost — the mounted element', () => {
  it('configures the element before navigating it', () => {
    mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    const el = created[0]!

    expect(el.attributes.get('allow')).toBe('payment')
    expect(el.attributes.get('title')).toBe('Secured by Circle')
    expect(el.referrerPolicy).toBe('strict-origin')
    expect(el.className).toBe('circle-sca-frame')
    expect(el.src).toBe(`${CIRCLE_ORIGIN}/ceremony#tok`)
    // `src` last, so the load cannot start against a half-configured element.
    expect(FakeElement.writes.at(-1)).toBe('src')
  })

  it('appends into the caller’s container, and rejects one that is not an element', () => {
    const host = createDomFrameHost(CIRCLE_ORIGIN)
    const container = new FakeElement()
    host.mount({ src: 'https://x.example/#t', allow: '', container })
    expect(container.children).toHaveLength(1)

    expect(() => host.mount({ src: 'https://x.example/#t', allow: '', container: {} })).toThrow(
      TypeError,
    )
  })

  it('removes the element on destroy, and destroy is idempotent', () => {
    const frame = mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    frame.destroy()
    frame.destroy()
    expect(created[0]?.removed).toBe(true)
  })

  it('stops applying height once destroyed', () => {
    const frame = mountOne(createDomFrameHost(CIRCLE_ORIGIN))
    frame.setHeight(120)
    expect(created[0]?.style.height).toBe('120px')

    frame.destroy()
    frame.setHeight(999)
    // A resize arriving during teardown must not resurrect a removed element.
    expect(created[0]?.style.height).toBe('120px')
  })
})

describe('createDomFrameHost — timers', () => {
  it('returns a cancel function that actually cancels', () => {
    vi.useFakeTimers()
    try {
      const host = createDomFrameHost(CIRCLE_ORIGIN)
      const fired: string[] = []

      const cancelTimeout = host.setTimeout(() => fired.push('timeout'), 100)
      host.setTimeout(() => fired.push('kept'), 100)
      cancelTimeout()

      vi.advanceTimersByTime(200)
      // The cancel functions are what `runCeremony`'s teardown holds. If one
      // silently did nothing, a canceled ready timeout would still fire and
      // fail a ceremony that had already succeeded — after the promise
      // settled, so invisibly.
      expect(fired).toEqual(['kept'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels an interval rather than only its next tick', () => {
    vi.useFakeTimers()
    try {
      const host = createDomFrameHost(CIRCLE_ORIGIN)
      let ticks = 0

      const cancel = host.setInterval(() => (ticks += 1), 50)
      vi.advanceTimersByTime(120)
      expect(ticks).toBe(2)

      cancel()
      vi.advanceTimersByTime(500)
      // A resize interval that outlives its ceremony would keep writing a
      // height onto a removed element for as long as the page is open.
      expect(ticks).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('createDomFrameHost — environment guard', () => {
  it('refuses to construct without a DOM', () => {
    vi.stubGlobal('document', undefined)
    expect(() => createDomFrameHost(CIRCLE_ORIGIN)).toThrow(TypeError)

    vi.stubGlobal('document', {})
    vi.stubGlobal('window', undefined)
    expect(() => createDomFrameHost(CIRCLE_ORIGIN)).toThrow(TypeError)
  })
})
