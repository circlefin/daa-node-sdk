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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDomFrameHost } from '../internal/frameHost.js'
import {
  MODAL_CLASS,
  MODAL_STYLE_ATTRIBUTE,
  MODAL_STYLESHEET,
  createModalChrome,
} from '../internal/modalChrome.js'

/**
 * The modal chrome, driven directly against stubbed globals.
 *
 * Same approach as `domFrameHost.test.ts`, and for the same reason: the
 * convention here is to extend the seam rather than add a DOM environment, and this is the
 * one module on the far side of it. What is worth catching here is not how
 * the panel looks — a fake DOM cannot tell — but everything the chrome does
 * to the page around it: the listeners it attaches, the `body` style it
 * overwrites, the focus it moves, and whether `close()` undoes all three. A
 * dialog that leaks any of those outlives the ceremony it belongs to.
 */

class FakeElement {
  readonly children: FakeElement[] = []
  parent: FakeElement | null = null
  readonly attributes = new Map<string, string>()
  readonly listeners = new Map<string, Array<(event: unknown) => void>>()
  readonly style: Record<string, string> = {}
  className = ''
  textContent = ''
  tabIndex = 0
  type = ''
  namespace: string | null = null
  focusCount = 0

  constructor(readonly tag: string) {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }
  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null
  }
  appendChild(child: FakeElement): FakeElement {
    child.parent = this
    this.children.push(child)
    return child
  }
  prepend(child: FakeElement): void {
    child.parent = this
    this.children.unshift(child)
  }
  remove(): void {
    const siblings = this.parent?.children
    if (siblings !== undefined) siblings.splice(siblings.indexOf(this), 1)
    this.parent = null
  }
  addEventListener(type: string, fn: (event: unknown) => void): void {
    const existing = this.listeners.get(type) ?? []
    existing.push(fn)
    this.listeners.set(type, existing)
  }
  removeEventListener(type: string, fn: (event: unknown) => void): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((l) => l !== fn),
    )
  }
  dispatch(type: string, event: unknown = {}): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event)
  }
  focus(): void {
    this.focusCount += 1
    focusOn(this)
  }
  getBoundingClientRect(): object {
    return {}
  }

  /** Enough of a selector engine for `tag` and `tag[attr]`. */
  querySelector(selector: string): FakeElement | null {
    const [, tag, attribute] = /^([a-z]+)(?:\[([^\]]+)\])?$/.exec(selector) ?? []
    for (const descendant of this.descendants()) {
      if (descendant.tag !== tag) continue
      if (attribute === undefined || descendant.attributes.has(attribute)) return descendant
    }
    return null
  }

  *descendants(): Generator<FakeElement> {
    for (const child of this.children) {
      yield child
      yield* child.descendants()
    }
  }

  /** Every element under here whose class list contains `className`. */
  byClass(className: string): FakeElement[] {
    return [...this.descendants()].filter((el) => el.className.split(' ').includes(className))
  }
}

let head: FakeElement
let body: FakeElement
let activeElement: FakeElement | null
let documentListeners: Map<string, Array<(event: unknown) => void>>

/** Records what the browser would treat as `document.activeElement`. */
const focusOn = (element: FakeElement): void => {
  activeElement = element
}

const dispatchOnDocument = (type: string, event: unknown): void => {
  for (const fn of [...(documentListeners.get(type) ?? [])]) fn(event)
}

const root = (): FakeElement => body.byClass(MODAL_CLASS.root)[0]!
const panel = (): FakeElement => body.byClass(MODAL_CLASS.panel)[0]!

beforeEach(() => {
  head = new FakeElement('head')
  body = new FakeElement('body')
  activeElement = null
  documentListeners = new Map()

  vi.stubGlobal('HTMLElement', FakeElement)
  vi.stubGlobal('window', {})
  vi.stubGlobal('document', {
    head,
    body,
    get activeElement() {
      return activeElement
    },
    createElement: (tag: string) => new FakeElement(tag),
    createElementNS: (ns: string, tag: string) => {
      const element = new FakeElement(tag)
      element.namespace = ns
      return element
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn])
    },
    removeEventListener: (type: string, fn: (event: unknown) => void) => {
      documentListeners.set(
        type,
        (documentListeners.get(type) ?? []).filter((l) => l !== fn),
      )
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

/** The default dialog: named, dismissible, with a spy for the user's intent. */
const open = () => {
  const onDismiss = vi.fn()
  const chrome = createModalChrome({ title: 'Circle security check', dismissible: true, onDismiss })
  return { chrome, onDismiss }
}

describe('modal chrome — reached through the seam', () => {
  it('is what the DOM host hands back from openModal', () => {
    // The host's `openModal` is one line of delegation, and this is the
    // linkage worth pinning: the container it returns has to satisfy
    // `mount`'s own `container instanceof HTMLElement` check, or every modal
    // ceremony fails at mount time with `Unsupported`.
    const modal = createDomFrameHost('https://daa-sca.circle.com').openModal({
      title: 'Circle security check',
      dismissible: true,
      onDismiss: () => undefined,
    })

    expect(modal.container).toBe(panel())
    expect(modal.container).toBeInstanceOf(FakeElement)

    modal.close()
    modal.close()
    expect(body.byClass(MODAL_CLASS.root)).toHaveLength(0)
  })
})

describe('modal chrome — the stylesheet', () => {
  it('declares every class the chrome actually applies', () => {
    // The stylesheet spells its selectors out literally so it reads as plain
    // CSS. This is what keeps a rename on one side from silently shipping an
    // unstyled dialog on the other.
    for (const className of Object.values(MODAL_CLASS)) {
      expect(MODAL_STYLESHEET).toContain(`.${className}`)
    }
  })

  it('goes in at the start of <head>, so a distributor’s own rules win a tie', () => {
    const before = new FakeElement('link')
    head.appendChild(before)

    open()

    expect(head.children[0]?.tag).toBe('style')
    expect(head.children[0]?.textContent).toBe(MODAL_STYLESHEET)
    expect(head.children[1]).toBe(before)
  })

  it('is injected once, however many ceremonies run', () => {
    open().chrome.close()
    open()

    expect(head.children.filter((child) => child.tag === 'style')).toHaveLength(1)
    expect(head.children[0]?.getAttribute(MODAL_STYLE_ATTRIBUTE)).toBe('')
  })
})

describe('modal chrome — the dialog', () => {
  it('names itself for assistive technology and mounts the frame in the panel', () => {
    const { chrome } = open()

    expect(root().getAttribute('role')).toBe('dialog')
    expect(root().getAttribute('aria-modal')).toBe('true')
    expect(root().getAttribute('aria-label')).toBe('Circle security check')
    // The container handed back is the panel itself: the frame is the
    // dialog's content, not a sibling of it.
    expect(chrome.container).toBe(panel())
  })

  it('takes the title it was given', () => {
    createModalChrome({ title: 'Approve payment', dismissible: true, onDismiss: vi.fn() })
    expect(root().getAttribute('aria-label')).toBe('Approve payment')
  })

  it('opens in the transitioned-in state, with focus on the panel', () => {
    open()

    // Both classes: the enter transition is a state change, so the panel has
    // to be attached in the closed state and flipped after.
    expect(root().className).toBe(`${MODAL_CLASS.root} ${MODAL_CLASS.open}`)
    expect(activeElement).toBe(panel())
    expect(panel().tabIndex).toBe(-1)
  })
})

describe('modal chrome — dismissal', () => {
  it('reports the X, Escape and a backdrop click as the same thing', () => {
    const { onDismiss } = open()

    body.byClass(MODAL_CLASS.close)[0]?.dispatch('click')
    body.byClass(MODAL_CLASS.overlay)[0]?.dispatch('click')
    dispatchOnDocument('keydown', { key: 'Escape', stopPropagation: () => undefined })

    expect(onDismiss).toHaveBeenCalledTimes(3)
  })

  it('ignores any other key', () => {
    const { onDismiss } = open()

    dispatchOnDocument('keydown', { key: 'Enter', stopPropagation: () => undefined })

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('stops Escape from also reaching the page underneath', () => {
    open()
    const stopPropagation = vi.fn()

    dispatchOnDocument('keydown', { key: 'Escape', stopPropagation })

    // A distributor's own Escape handler closing their surface would strand
    // the ceremony with no visible frame.
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('draws no X and wires nothing up when it is not dismissible', () => {
    const onDismiss = vi.fn()
    createModalChrome({ title: 'Approve payment', dismissible: false, onDismiss })

    expect(body.byClass(MODAL_CLASS.close)).toHaveLength(0)
    body.byClass(MODAL_CLASS.overlay)[0]?.dispatch('click')
    dispatchOnDocument('keydown', { key: 'Escape', stopPropagation: () => undefined })

    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('does not close itself — that is the ceremony’s call', () => {
    const { onDismiss } = open()

    body.byClass(MODAL_CLASS.close)[0]?.dispatch('click')

    // The chrome reports the intent; `runCeremony` aborts, and only then does
    // the factory close it. Closing here would take the frame down before its
    // teardown ran.
    expect(onDismiss).toHaveBeenCalled()
    expect(body.byClass(MODAL_CLASS.root)).toHaveLength(1)
  })
})

describe('modal chrome — the focus trap', () => {
  it('sends focus leaving the top back to the last thing inside', () => {
    const { chrome } = open()
    const frame = new FakeElement('iframe')
    ;(chrome.container as unknown as FakeElement).appendChild(frame)

    body.byClass(MODAL_CLASS.sentinel)[0]?.dispatch('focus')

    // Reverse-tabbing out of the X wraps to the frame, not to the page
    // behind the backdrop.
    expect(activeElement).toBe(frame)
  })

  it('sends focus leaving the bottom back to the first thing inside', () => {
    open()

    body.byClass(MODAL_CLASS.sentinel)[1]?.dispatch('focus')

    expect(activeElement).toBe(body.byClass(MODAL_CLASS.close)[0])
  })

  it('falls back to the panel, from either end, before the frame is mounted', () => {
    // The trap is built at open time; the frame arrives afterwards, and a
    // non-dismissible dialog has no X either — so there is a window where the
    // panel is the only thing in it. Focus has to land somewhere inside the
    // dialog even then, or the first Tab escapes to the page behind it.
    createModalChrome({ title: 'Approve payment', dismissible: false, onDismiss: vi.fn() })
    const [before, after] = body.byClass(MODAL_CLASS.sentinel)

    before?.dispatch('focus')
    expect(activeElement).toBe(panel())

    activeElement = null
    after?.dispatch('focus')
    expect(activeElement).toBe(panel())
  })
})

describe('modal chrome — close()', () => {
  it('undoes everything opening it did', () => {
    const opener = new FakeElement('button')
    body.appendChild(opener)
    opener.focus()
    body.style.overflow = 'auto'

    const { chrome } = open()
    expect(body.style.overflow).toBe('hidden')

    chrome.close()

    expect(body.byClass(MODAL_CLASS.root)).toHaveLength(0)
    // The distributor's own value, not a cleared one.
    expect(body.style.overflow).toBe('auto')
    // Focus goes back where the user left it, rather than to the top of the
    // page, which is what a removed active element leaves behind.
    expect(activeElement).toBe(opener)
    expect(documentListeners.get('keydown')).toHaveLength(0)
  })

  it('is idempotent, so a second ceremony’s state is not clobbered', () => {
    const { chrome } = open()
    chrome.close()

    body.style.overflow = 'clip'
    chrome.close()

    expect(body.style.overflow).toBe('clip')
  })
})
