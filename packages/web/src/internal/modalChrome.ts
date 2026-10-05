/**
 * The modal surface, in DOM.
 *
 * `{ mode: 'modal' }` mounts the ceremony frame inside a dialog this SDK
 * draws, so a distributor does not have to build one and every distributor's
 * ceremony looks the same. Only the chrome is ours: the panel's *contents* are
 * the Circle-origin document, and nothing in this file can see or change them.
 * What it supplies is what surrounds them — backdrop, panel, close
 * affordance, focus and scroll behavior.
 *
 * **The geometry and color below are literals, on purpose.** This package
 * takes no runtime dependency and ships no stylesheet to import, because it
 * runs on the *distributor's* page: it cannot assume a CSS framework, a build
 * step, a theme, or a cascade it did not write. Plain CSS in a single
 * injected `<style>` is the only thing that works everywhere this is
 * embedded, so the panel matches the framed document no matter what surrounds
 * it.
 *
 * Light only, deliberately. The ceremony document pins `color-scheme: light`
 * on its own `<html>`, so a dark panel would frame a light iframe.
 */

/**
 * Class names on the chrome. Documented styling hooks: single-class, so a
 * distributor's own rule at equal specificity wins by coming later in the
 * document — which is also why the stylesheet is injected at the *start* of
 * `<head>`.
 *
 * The stylesheet below spells these out literally rather than interpolating
 * them, so it reads as plain CSS. `modalChrome.test.ts` asserts every name
 * here appears there, which is what keeps a rename honest.
 */
export const MODAL_CLASS = {
  root: 'circle-sca-modal',
  open: 'circle-sca-modal-open',
  container: 'circle-sca-modal-container',
  overlay: 'circle-sca-modal-overlay',
  panel: 'circle-sca-modal-panel',
  close: 'circle-sca-modal-close',
  sentinel: 'circle-sca-modal-sentinel',
} as const

/** Marks the injected `<style>`, so a second ceremony reuses the first one's. */
export const MODAL_STYLE_ATTRIBUTE = 'data-circle-sca-modal'

/**
 * The dialog, as one stylesheet.
 *
 * A small centered panel: `32rem` wide from the `40rem` breakpoint up, full
 * width less a `1rem` gutter below it, `0.75rem` corners, a hairline border,
 * a soft two-layer shadow, and a dimmed backdrop over the page behind. It is
 * the shape a payment confirmation is expected to take, so the user reads it
 * as one.
 *
 * **Centered on phones too, not a bottom sheet or full screen.** The platform
 * passkey prompt is itself a sheet rising from the bottom, so a sheet here
 * would stack two, and a full-screen takeover would hide the page the user is
 * confirming a payment on. `100dvh` follows the `100vh` fallback because iOS
 * Safari's `vh` is the viewport with its toolbar collapsed, which centers the
 * panel too low while the toolbar is showing. The side gutters grow into the
 * safe area, so a landscape notch does not cover the panel on a page that
 * sets `viewport-fit=cover`.
 *
 * **The close button's hit area is larger than its box.** The visible box is
 * `1.75rem`; a `::before` extends the target to `2.75rem` (44px, the iOS
 * minimum) without moving the icon or growing the hover fill.
 *
 * **The panel carries no padding.** The inset the user sees — `1.5rem` on
 * every side — comes from the framed document, which lays out its own
 * content. Adding it again out here would double it. `overflow: hidden` is
 * what keeps the iframe's square corners from filling in the rounded ones.
 *
 * **The frame opens at `315px`, not at the browser's `150px` default.** Its
 * real height is only known once the framed document reports it, which is
 * after `ready` and on the resize interval — so without a reservation the
 * panel opens short and jumps once the content lands. `315px` is roughly the
 * loaded ceremony, so the usual case does not move at all; `setHeight` writes
 * an inline style, which overrides this, and any difference animates rather
 * than snaps. A reservation rather than a `min-height`, so content shorter
 * than it does not leave blank panel underneath. `:where` keeps the rule at
 * the one-class specificity of `.circle-sca-frame`, so a distributor's own
 * rule for that hook still wins.
 */
export const MODAL_STYLESHEET = `
.circle-sca-modal {
  position: fixed;
  inset: 0;
  z-index: 60;
  overflow-y: auto;
}
.circle-sca-modal-container {
  position: relative;
  display: flex;
  min-height: 100vh;
  min-height: 100dvh;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.circle-sca-modal-overlay {
  position: fixed;
  inset: 0;
  background-color: rgba(17, 24, 39, 0.7);
  opacity: 0;
  transition: opacity 300ms cubic-bezier(0.4, 0, 0.2, 1);
}
.circle-sca-modal-panel {
  position: relative;
  display: inline-block;
  width: 100%;
  margin-left: max(1rem, env(safe-area-inset-left));
  margin-right: max(1rem, env(safe-area-inset-right));
  overflow: hidden;
  border: 1px solid rgba(17, 24, 39, 0.1);
  border-radius: 0.75rem;
  background-color: #ffffff;
  box-shadow: 0 0 6px -2px rgba(0, 0, 0, 0.15), 0 6px 15px -3px rgba(0, 0, 0, 0.15);
  text-align: left;
  opacity: 0;
  transform: scale(0.95);
  transition:
    opacity 300ms cubic-bezier(0.4, 0, 0.2, 1),
    transform 300ms cubic-bezier(0.4, 0, 0.2, 1);
}
.circle-sca-modal-panel:focus {
  outline: none;
}
:where(.circle-sca-modal-panel) > .circle-sca-frame {
  height: 315px;
  transition: height 200ms cubic-bezier(0.4, 0, 0.2, 1);
}
.circle-sca-modal-close {
  position: absolute;
  top: 1.25rem;
  right: 1.25rem;
  z-index: 10;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border: none;
  border-radius: 0.375rem;
  background-color: transparent;
  color: #4e4763;
  cursor: pointer;
  appearance: none;
}
.circle-sca-modal-close::before {
  content: '';
  position: absolute;
  inset: -0.5rem;
}
.circle-sca-modal-close:hover {
  background-color: rgba(17, 24, 39, 0.05);
}
.circle-sca-modal-close:focus-visible {
  outline: 2px solid #1aa3ff;
  outline-offset: 2px;
}
.circle-sca-modal-sentinel {
  position: absolute;
  width: 1px;
  height: 0;
  overflow: hidden;
}
.circle-sca-modal-open .circle-sca-modal-overlay {
  opacity: 1;
}
.circle-sca-modal-open .circle-sca-modal-panel {
  opacity: 1;
  transform: none;
}
@media (min-width: 40rem) {
  .circle-sca-modal-panel {
    max-width: 32rem;
    margin-block: 2rem;
  }
}
@media (prefers-reduced-motion: reduce) {
  .circle-sca-modal-overlay,
  .circle-sca-modal-panel,
  :where(.circle-sca-modal-panel) > .circle-sca-frame {
    transition: none;
  }
}
`

export interface ModalChromeOptions {
  /** Accessible name for the dialog. The heading itself is the frame's. */
  readonly title: string
  /** Whether the X, Escape and a backdrop click are wired to `onDismiss`. */
  readonly dismissible: boolean
  /** Called when the user asks to close. The chrome does not close itself. */
  readonly onDismiss: () => void
}

export interface ModalChrome {
  /** The panel. This is what the ceremony frame mounts into. */
  readonly container: HTMLElement
  /** Removes the chrome and undoes everything it changed. Idempotent. */
  close(): void
}

const SVG_NS = 'http://www.w3.org/2000/svg'

/** A 20x20 X, drawn on the same grid as the rest of the dialog's iconography. */
const CLOSE_ICON_PATH =
  'M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94z'

const div = (className: string): HTMLDivElement => {
  const element = document.createElement('div')
  element.className = className
  return element
}

/**
 * Injects the stylesheet once per document.
 *
 * `prepend`, not `append`: these are single-class rules, and a distributor
 * overriding one should win. Under equal specificity that means coming later,
 * so ours goes first and every stylesheet the page loads outranks it.
 */
const ensureStylesheet = (): void => {
  if (document.head.querySelector(`style[${MODAL_STYLE_ATTRIBUTE}]`) !== null) return
  const style = document.createElement('style')
  style.setAttribute(MODAL_STYLE_ATTRIBUTE, '')
  style.textContent = MODAL_STYLESHEET
  document.head.prepend(style)
}

const closeButton = (label: string, onDismiss: () => void): HTMLButtonElement => {
  const button = document.createElement('button')
  button.className = MODAL_CLASS.close
  // `type` is set because this may be rendered inside a distributor's form,
  // where the default is `submit` and closing the ceremony would post it.
  button.type = 'button'
  button.setAttribute('aria-label', label)

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 20 20')
  svg.setAttribute('width', '20')
  svg.setAttribute('height', '20')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('fill', 'currentColor')
  path.setAttribute('d', CLOSE_ICON_PATH)
  svg.appendChild(path)
  button.appendChild(svg)

  button.addEventListener('click', onDismiss)
  return button
}

/**
 * Builds the chrome, attaches it, and returns the panel to mount into.
 *
 * Only ever called from `createDomFrameHost`, which has already established
 * that there is a DOM to build in.
 */
export const createModalChrome = ({
  title,
  dismissible,
  onDismiss,
}: ModalChromeOptions): ModalChrome => {
  ensureStylesheet()

  const root = div(MODAL_CLASS.root)
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  // The dialog's name, not its heading — the heading is inside the frame and
  // is copy this side of the boundary never sees.
  root.setAttribute('aria-label', title)

  const container = div(MODAL_CLASS.container)
  const overlay = div(MODAL_CLASS.overlay)
  const panel = div(MODAL_CLASS.panel)
  // Focusable but not tabbable, so the dialog itself can take focus on open.
  // A dialog that opens with focus still behind it reads to a screen reader
  // as if nothing happened, and the first Tab goes to the page underneath.
  panel.tabIndex = -1

  const x = dismissible ? closeButton('Close', onDismiss) : null
  if (x !== null) panel.appendChild(x)

  // Focus wrap. The tabbables inside the dialog are the X and the frame, and
  // the frame is cross-origin — its contents cannot be enumerated, so the
  // trap is built from sentinels either side of the panel rather than from a
  // list of everything focusable. They are absolutely positioned, so they
  // take no space in the flex container.
  const sentinelBefore = div(MODAL_CLASS.sentinel)
  const sentinelAfter = div(MODAL_CLASS.sentinel)
  sentinelBefore.tabIndex = 0
  sentinelAfter.tabIndex = 0

  const tabbables = (): HTMLElement[] => {
    const list: HTMLElement[] = x === null ? [] : [x]
    const frame = panel.querySelector('iframe')
    if (frame !== null) list.push(frame)
    return list
  }
  sentinelBefore.addEventListener('focus', () => (tabbables().at(-1) ?? panel).focus())
  sentinelAfter.addEventListener('focus', () => (tabbables()[0] ?? panel).focus())

  container.appendChild(sentinelBefore)
  container.appendChild(overlay)
  container.appendChild(panel)
  container.appendChild(sentinelAfter)
  root.appendChild(container)

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return
    // Stopped here rather than left to bubble: a distributor's own Escape
    // handler closing their own surface underneath this one would strand the
    // ceremony with no visible frame.
    event.stopPropagation()
    onDismiss()
  }
  if (dismissible) {
    overlay.addEventListener('click', onDismiss)
    document.addEventListener('keydown', onKeyDown)
  }

  // Restored verbatim on close, including the empty string, so a distributor
  // who sets their own `overflow` gets theirs back rather than a cleared one.
  const previousOverflow = document.body.style.overflow
  const previouslyFocused = document.activeElement
  document.body.style.overflow = 'hidden'
  document.body.appendChild(root)

  // Forces a style flush, so the open state below is a transition from the
  // closed one rather than the element's first computed style. Without it the
  // panel appears at full opacity and the enter animation never runs.
  panel.getBoundingClientRect()
  root.className = `${MODAL_CLASS.root} ${MODAL_CLASS.open}`
  panel.focus()

  let closed = false
  return {
    container: panel,
    close() {
      if (closed) return
      closed = true
      document.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      // Removed outright rather than faded out: `runCeremony` destroys the
      // iframe before the chrome is closed, so a leave transition would
      // animate an empty panel collapsing.
      root.remove()
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus()
    },
  }
}
