/**
 * Throw a friendly error if the page can't use the Web Crypto API.
 *
 * `crypto.subtle` is gated on a "secure context" — HTTPS, or localhost/loopback.
 * On plain HTTP over a network host, the browser silently leaves `subtle`
 * undefined; calling `crypto.subtle.digest(...)` then crashes with the opaque
 * "Cannot read properties of undefined (reading 'digest')" message.
 *
 * Call `requireSecureCrypto()` at the entrypoint of any flow that needs
 * `crypto.subtle` (DM key derivation, session-key encryption, etc.) so the
 * operator sees a clear "use HTTPS" message instead of a runtime null-deref.
 *
 * Some mobile in-app browsers (notably some MetaMask / wallet in-app
 * webviews) also strip `crypto.subtle` even on HTTPS — same message applies:
 * open the site in the system browser instead.
 */
export function requireSecureCrypto(feature = 'This feature'): void {
  if (typeof crypto === 'undefined' || !crypto?.subtle?.digest) {
    const reason =
      typeof window !== 'undefined' && window.isSecureContext === false
        ? `${feature} requires HTTPS (or localhost). The page is loaded over plain HTTP, so the browser disables the Web Crypto API. Please use the https:// version of this site.`
        : `${feature} requires the Web Crypto API, which isn't available in this browser. If you're using a wallet's in-app browser, try opening the site in the system browser instead.`
    throw new Error(reason)
  }
}
