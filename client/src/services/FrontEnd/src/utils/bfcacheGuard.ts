// bfcacheGuard.ts
//
// iOS Safari (and Chrome on Android) snapshots the entire tab into the
// bfcache when the user switches to another app or tab. When they return,
// the JS heap is restored from that snapshot — no module re-evaluation,
// no React re-mount.
//
// Problem: our SW uses clientsClaim + skipWaiting (autoUpdate). A new
// build can activate while the tab is hidden, evicting the old precached
// chunks and replacing them with new hashed filenames. When the snapshot
// resumes and the frozen JS tries to lazy-load a route chunk, the old
// filename is gone → fetch 404 → blank/white screen. The existing
// lazyWithReload wrapper only catches chunk-load errors triggered by
// navigation events; a passive bfcache restoration doesn't re-navigate,
// so it goes unprotected.
//
// Fix: listen for pageshow with event.persisted === true (bfcache restore).
// Fetch /index.html with no-store to bypass both the SW and the browser
// cache, then compare the caw-client-version meta tag to __CLIENT_VERSION__
// (the version baked into the currently-running JS at build time). If they
// differ, the SW has activated a new build → hard-reload. If they match,
// or if the check fails for any reason, leave the snapshot alone — bfcache
// restores are normally cheap and we don't want spurious reloads.
//
// The session-scoped RELOADED_KEY guard prevents an infinite reload loop
// if, for some reason, the freshly-loaded page itself comes up stale
// (should be impossible, but belt-and-suspenders).

declare const __CLIENT_VERSION__: string | undefined

const RELOADED_KEY = 'caw:bfcache-reloaded'

async function isStaleAfterBfcache(): Promise<boolean> {
  const loaded =
    (typeof __CLIENT_VERSION__ !== 'undefined' && __CLIENT_VERSION__) || null
  if (!loaded) return false // can't compare — be conservative, don't reload

  try {
    // Fetch with no-store to bypass the SW precache and the HTTP cache.
    // credentials: 'omit' avoids a preflight on cross-origin installs and
    // keeps the check lightweight — we only need the <head> HTML.
    const res = await fetch('/index.html', {
      cache: 'no-store',
      credentials: 'omit',
    })
    if (!res.ok) return false

    const html = await res.text()
    const m = html.match(
      /<meta\s+name=["']caw-client-version["']\s+content=["']([^"']+)["']/i,
    )
    if (!m) return false // meta missing (old deploy without the tag) — skip

    const deployed = m[1]
    return deployed !== loaded
  } catch {
    // Network error, CORS, parse failure — be conservative, don't reload.
    return false
  }
}

export function installBfcacheGuard(): void {
  if (typeof window === 'undefined') return

  window.addEventListener('pageshow', async (event) => {
    if (!(event as PageTransitionEvent).persisted) return // fresh navigation, not bfcache
    if (sessionStorage.getItem(RELOADED_KEY)) return // already reloaded once this session

    const stale = await isStaleAfterBfcache()
    if (stale) {
      sessionStorage.setItem(RELOADED_KEY, '1')
      window.location.reload()
    }
  })
}
