/**
 * In-app browser (embedded webview) detection.
 *
 * Several apps open links inside their own embedded webview instead of the
 * system browser. On iOS especially, those webviews frequently CANNOT run
 * WebAuthn passkey enrollment (`navigator.credentials.create`) even though
 * `window.PublicKeyCredential` exists — the call rejects at runtime with an
 * opaque NotAllowedError, which reads to the user like "the prompt timed out".
 *
 * Telegram's iOS webview is the one that bit us: an invite link opened in TG
 * silently fails passkey creation, and the user has to "open in Safari".
 *
 * We use these heuristics to (a) warn the user BEFORE they tap "Create passkey"
 * and (b) rewrite a post-failure error into "open in your system browser"
 * instead of the misleading timeout copy.
 *
 * Detection is best-effort UA sniffing — apps change their UA strings, so treat
 * a positive as "very likely embedded", and never HARD-block on it (the real
 * gate is still whether create() succeeds).
 */

export type InAppBrowser =
  | 'telegram'
  | 'instagram'
  | 'facebook'
  | 'tiktok'
  | 'snapchat'
  | 'line'
  | 'twitter'
  | 'generic' // matched a generic embedded-webview marker but no specific app

interface InAppBrowserInfo {
  /** True if the page appears to be running inside an embedded app webview. */
  isInApp: boolean
  /** Which app, when identifiable. undefined when isInApp is false. */
  app?: InAppBrowser
  /** True on iOS (iPhone/iPad), where webview WebAuthn restrictions are worst. */
  isIOS: boolean
}

function ua(): string {
  if (typeof navigator === 'undefined') return ''
  return navigator.userAgent || ''
}

/** iPhone / iPad (including iPadOS reporting as desktop Safari with touch). */
export function isIOS(): boolean {
  const s = ua()
  if (/iPhone|iPad|iPod/i.test(s)) return true
  // iPadOS 13+ masquerades as Mac; detect via touch + Mac platform.
  return (
    typeof navigator !== 'undefined' &&
    /Macintosh/i.test(s) &&
    (navigator as any).maxTouchPoints > 1
  )
}

/**
 * Identify the embedded app webview, if any, from the user-agent string.
 * Returns the matched InAppBrowser or null.
 *
 * Notes on the markers:
 *  - Telegram on iOS does NOT reliably put "Telegram" in the UA. Its webview
 *    is a plain WKWebView, so the strongest tell on iOS is "AppleWebKit"
 *    present WITHOUT "Safari" / "CriOS" / "FxiOS" — i.e. a non-Safari WKWebView.
 *    We treat that as a generic in-app match so TG (and other plain webviews)
 *    still trigger the warning. Android Telegram does include "Telegram".
 */
export function detectInAppBrowser(): InAppBrowserInfo {
  const s = ua()
  const ios = isIOS()

  if (!s) return { isInApp: false, isIOS: ios }

  // Specific apps (work across platforms where they tag their UA).
  if (/Telegram/i.test(s)) return { isInApp: true, app: 'telegram', isIOS: ios }
  if (/Instagram/i.test(s)) return { isInApp: true, app: 'instagram', isIOS: ios }
  if (/FBAN|FBAV|FB_IAB/i.test(s)) return { isInApp: true, app: 'facebook', isIOS: ios }
  if (/Snapchat/i.test(s)) return { isInApp: true, app: 'snapchat', isIOS: ios }
  if (/\bLine\//i.test(s)) return { isInApp: true, app: 'line', isIOS: ios }
  if (/TikTok|musical_ly|BytedanceWebview/i.test(s)) return { isInApp: true, app: 'tiktok', isIOS: ios }
  if (/Twitter/i.test(s)) return { isInApp: true, app: 'twitter', isIOS: ios }

  // Generic iOS WKWebView: AppleWebKit present, but none of the real iOS
  // browser markers. Telegram's iOS webview falls here. Standalone PWAs also
  // lack "Safari", so exclude display-mode standalone to avoid false positives.
  if (ios && /AppleWebKit/i.test(s) && !/Safari|CriOS|FxiOS|EdgiOS|OPiOS/i.test(s)) {
    const standalone =
      typeof window !== 'undefined' &&
      (window.matchMedia?.('(display-mode: standalone)')?.matches ||
        (window.navigator as any).standalone === true)
    if (!standalone) return { isInApp: true, app: 'generic', isIOS: ios }
  }

  // Generic Android webview marker.
  if (/; wv\)/i.test(s)) return { isInApp: true, app: 'generic', isIOS: ios }

  return { isInApp: false, isIOS: ios }
}

/**
 * Best-effort check that this environment can plausibly create a platform
 * passkey. Combines the synchronous `PublicKeyCredential` presence check with
 * the async `isUserVerifyingPlatformAuthenticatorAvailable()` probe.
 *
 * Returns false in most passkey-incapable webviews. A `true` is NOT a
 * guarantee create() will work (some webviews report available then reject),
 * which is why callers still warn on in-app browsers regardless.
 */
export async function isPlatformAuthenticatorLikelyAvailable(): Promise<boolean> {
  if (typeof window === 'undefined' || !window.PublicKeyCredential) return false
  try {
    const fn = (window.PublicKeyCredential as any)
      .isUserVerifyingPlatformAuthenticatorAvailable
    if (typeof fn !== 'function') return true // can't probe — don't block
    return await fn.call(window.PublicKeyCredential)
  } catch {
    return false
  }
}

/** The reason passkey enrollment can't run here, mapped to a copy key. */
export type PasskeyBlockReason =
  | 'ios-webview'      // iOS in-app webview → must open in Safari
  | 'unsupported'      // not an iOS webview, but no platform passkey support
  | null               // good to go

export interface PasskeyGate {
  /** True when passkey enrollment should be blocked up-front. */
  blocked: boolean
  reason: PasskeyBlockReason
  /** i18n key for the message to show. */
  messageKey: string | null
}

/**
 * Decide — as early as the FIRST onboarding step — whether this browser can
 * enroll a passkey, and WHY not. Lets us block on step 1 instead of letting the
 * user fill in name + vault only to hit a dead wall on the passkey step.
 *
 * Decision tree (matches the product copy):
 *   - iOS in-app webview (Telegram/IG/etc.)  → 'ios-webview'  → "Open in Safari"
 *   - any other context with no platform authenticator → 'unsupported'
 *       → "passkey not supported on this browser; open your native browser or
 *          use a different device"
 *   - otherwise → not blocked.
 *
 * NOTE: an iOS in-app webview is blocked even if the capability probe reports
 * "available" — those webviews lie (probe says yes, create() then rejects with
 * the opaque NotAllowedError the user just saw). The webview signal wins on iOS.
 */
export async function evaluatePasskeyGate(): Promise<PasskeyGate> {
  const info = detectInAppBrowser()

  // iOS in-app webview: hard signal. Open-in-Safari is the only fix.
  if (info.isInApp && info.isIOS) {
    return { blocked: true, reason: 'ios-webview', messageKey: 'onboarding.passkey.gate_ios_webview' }
  }

  // Anything else: trust the capability probe. Covers non-iOS webviews,
  // ancient browsers, and desktop contexts with no platform authenticator.
  const ok = await isPlatformAuthenticatorLikelyAvailable()
  if (!ok) {
    return { blocked: true, reason: 'unsupported', messageKey: 'onboarding.passkey.gate_unsupported' }
  }

  return { blocked: false, reason: null, messageKey: null }
}
