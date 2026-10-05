import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { supportsEmbeddedCeremonies } from '../internal/embeddedCeremony.js'
import { createDomFrameHost } from '../internal/frameHost.js'

/**
 * The real browser adapter's window surface, driven against stubbed globals
 * for the same reason `domFrameHost.test.ts` is: it tests what the adapter
 * asks the browser to do, which is the part this package owns.
 */

const CIRCLE_ORIGIN = 'https://daa-sca.circle.com'
const SRC = `${CIRCLE_ORIGIN}/ceremony`

class FakeAnchor {
  href = ''
  referrerPolicy = ''
  clicked = false
  click(): void {
    this.clicked = true
  }
}

/** A blank window as `window.open('about:blank')` hands it back. */
class FakePopup {
  closed = false
  readonly posted: Array<{ message: unknown; targetOrigin: string }> = []
  readonly anchors: FakeAnchor[] = []
  readonly replaced: string[] = []
  readonly body = { appendChild: (a: FakeAnchor) => this.anchors.push(a) }
  documentUnreachable = false

  get document(): { createElement: (tag: string) => FakeAnchor; body: FakePopup['body'] } {
    if (this.documentUnreachable) throw new Error('SecurityError')
    return {
      createElement: (tag: string) => {
        expect(tag).toBe('a')
        return new FakeAnchor()
      },
      body: this.body,
    }
  }
  readonly location = { replace: (src: string) => this.replaced.push(src) }
  postMessage(message: unknown, targetOrigin: string): void {
    this.posted.push({ message, targetOrigin })
  }
  close(): void {
    this.closed = true
  }
}

let opens: Array<{ url: string; target: string; features: string }>
let popup: FakePopup | null

beforeEach(() => {
  vi.useFakeTimers()
  opens = []
  popup = new FakePopup()
  vi.stubGlobal('document', {})
  vi.stubGlobal('window', {
    open: (url: string, target: string, features: string) => {
      opens.push({ url, target, features })
      return popup
    },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('supportsEmbeddedCeremonies', () => {
  it('is false for every WebKit browser, including Chrome and Firefox on iOS', () => {
    // All of them report Apple as the vendor, whatever their UA calls them.
    expect(supportsEmbeddedCeremonies({ vendor: 'Apple Computer, Inc.' })).toBe(false)
  })

  it('is true for Chromium and Gecko', () => {
    expect(supportsEmbeddedCeremonies({ vendor: 'Google Inc.' })).toBe(true)
    expect(supportsEmbeddedCeremonies({ vendor: '' })).toBe(true)
  })

  it('is true when there is no navigator to ask', () => {
    expect(supportsEmbeddedCeremonies(undefined)).toBe(true)
    expect(supportsEmbeddedCeremonies({})).toBe(true)
  })

  it('is what the DOM host reports, read from navigator.vendor', () => {
    vi.stubGlobal('navigator', { vendor: 'Apple Computer, Inc.' })
    expect(createDomFrameHost(CIRCLE_ORIGIN).supportsEmbeddedCeremonies?.()).toBe(false)
    vi.stubGlobal('navigator', { vendor: 'Google Inc.' })
    expect(createDomFrameHost(CIRCLE_ORIGIN).supportsEmbeddedCeremonies?.()).toBe(true)
  })
})

describe('createDomFrameHost — openWindow', () => {
  it('opens a fresh blank window, keeping the opener', () => {
    createDomFrameHost(CIRCLE_ORIGIN).openWindow?.({ onClosed: () => undefined })

    expect(opens).toHaveLength(1)
    expect(opens[0]?.url).toBe('about:blank')
    expect(opens[0]?.target).toBe('_blank')
    // `noopener` would leave the ceremony document nothing to post back to.
    expect(opens[0]?.features).not.toMatch(/noopener|noreferrer/)
  })

  it('returns null when the browser blocks the window', () => {
    popup = null
    expect(createDomFrameHost(CIRCLE_ORIGIN).openWindow?.({ onClosed: () => undefined })).toBe(null)
  })

  it('navigates through an anchor carrying strict-origin, not location', () => {
    const opened = createDomFrameHost(CIRCLE_ORIGIN).openWindow?.({ onClosed: () => undefined })
    opened?.load(SRC)

    const anchor = popup?.anchors[0]
    expect(anchor?.href).toBe(SRC)
    expect(anchor?.referrerPolicy).toBe('strict-origin')
    expect(anchor?.clicked).toBe(true)
    expect(popup?.replaced).toEqual([])
  })

  it('falls back to location.replace when the blank document cannot be reached', () => {
    if (popup !== null) popup.documentUnreachable = true
    createDomFrameHost(CIRCLE_ORIGIN)
      .openWindow?.({ onClosed: () => undefined })
      ?.load(SRC)

    expect(popup?.replaced).toEqual([SRC])
  })

  it('posts with the explicit target origin and recognizes only its own window', () => {
    const frame = createDomFrameHost(CIRCLE_ORIGIN)
      .openWindow?.({ onClosed: () => undefined })
      ?.load(SRC)

    frame?.post({ kind: 'ack' }, CIRCLE_ORIGIN)
    expect(popup?.posted).toEqual([{ message: { kind: 'ack' }, targetOrigin: CIRCLE_ORIGIN }])

    expect(frame?.isSource(popup)).toBe(true)
    expect(frame?.isSource(new FakePopup())).toBe(false)
    expect(frame?.isSource(null)).toBe(false)
  })

  it('reports the user closing the window, once', () => {
    const onClosed = vi.fn()
    createDomFrameHost(CIRCLE_ORIGIN).openWindow?.({ onClosed })

    vi.advanceTimersByTime(1_000)
    expect(onClosed).not.toHaveBeenCalled()

    if (popup !== null) popup.closed = true
    vi.advanceTimersByTime(1_000)
    vi.advanceTimersByTime(1_000)
    expect(onClosed).toHaveBeenCalledOnce()
  })

  it('closes the window on destroy and does not report that as the user closing it', () => {
    const onClosed = vi.fn()
    const frame = createDomFrameHost(CIRCLE_ORIGIN).openWindow?.({ onClosed })?.load(SRC)

    frame?.destroy()
    frame?.destroy()
    expect(popup?.closed).toBe(true)

    vi.advanceTimersByTime(1_000)
    expect(onClosed).not.toHaveBeenCalled()
  })

  it('treats height as a no-op: a window sizes itself', () => {
    const frame = createDomFrameHost(CIRCLE_ORIGIN)
      .openWindow?.({ onClosed: () => undefined })
      ?.load(SRC)
    expect(() => frame?.setHeight(400)).not.toThrow()
  })
})
