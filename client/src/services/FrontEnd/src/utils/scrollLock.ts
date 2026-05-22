// Single source of truth for body scroll-lock when a modal / overlay
// opens. Handles three things that ad-hoc `body.style.overflow='hidden'`
// implementations miss:
//
//   1. iOS Safari ignores `body { overflow: hidden }` outright. Only
//      `position:fixed; top:-scrollY` reliably stops the page scrolling
//      under the overlay there. Non-iOS browsers don't need that and
//      get layout-drift from it (sidebars with `position:fixed` resolve
//      `top: auto` against the body's new position), so it's gated.
//   2. Nested overlays — opening B over A must not re-snapshot scrollY
//      (the body is already fixed, so `window.scrollY` reads 0). A
//      refcount makes only the first acquire snapshot, only the last
//      release restore.
//   3. ScrollY restoration on close so the user isn't yanked to the top.

let lockCount = 0
let savedScrollY = 0
let savedStyles: { overflow: string; htmlOverflow: string; position: string; top: string; width: string } | null = null

function isIosSafari(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  const isIos = /iP(hone|od|ad)/.test(ua) || (ua.includes('Mac') && 'ontouchend' in document)
  const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua)
  return isIos && isSafari
}

export function acquireScrollLock() {
  if (lockCount === 0) {
    savedScrollY = window.scrollY
    const body = document.body
    const html = document.documentElement
    savedStyles = {
      overflow: body.style.overflow,
      // index.css sets `html { overflow-x: hidden }`, which per spec makes
      // html's overflow-y compute to `auto` — so <html>, not <body>, owns
      // the page scroll. Locking only body is a no-op on desktop (#210).
      htmlOverflow: html.style.overflow,
      position: body.style.position,
      top: body.style.top,
      width: body.style.width,
    }
    body.style.overflow = 'hidden'
    html.style.overflow = 'hidden'
    if (isIosSafari()) {
      body.style.position = 'fixed'
      body.style.top = `-${savedScrollY}px`
      body.style.width = '100%'
    }
  }
  lockCount++
}

export function releaseScrollLock() {
  lockCount = Math.max(0, lockCount - 1)
  if (lockCount === 0 && savedStyles) {
    const body = document.body
    const wasIosLock = body.style.position === 'fixed'
    body.style.overflow = savedStyles.overflow
    document.documentElement.style.overflow = savedStyles.htmlOverflow
    body.style.position = savedStyles.position
    body.style.top = savedStyles.top
    body.style.width = savedStyles.width
    savedStyles = null
    if (wasIosLock) {
      window.scrollTo(0, savedScrollY)
    }
  }
}
