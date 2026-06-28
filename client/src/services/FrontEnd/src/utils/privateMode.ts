// Best-effort detection of a private / incognito browsing window.
//
// Why we care: CAW's session, the secp256k1 Quick Sign key, and the encrypted
// passkey backup all rely on persistent storage (localStorage / IndexedDB).
// Private windows either wipe that on close or, on iOS Safari, partition it so
// aggressively that the user looks logged-out within hours. There is no single
// reliable API for this, so we layer a few heuristics and only report `true`
// when we are fairly confident — a false positive would scare off a legitimate
// user, so we bias toward NOT flagging when a probe is inconclusive.
//
// Detection is best-effort by nature: browsers actively work to defeat it.
// Treat a `true` result as "warn the user", never as a hard gate.

/**
 * localStorage is unavailable, throws, or doesn't round-trip → private-mode
 * signal. We write a value AND read it back: some locked-down WebViews and old
 * Safari private builds let setItem succeed but silently no-op, so the value
 * doesn't persist even within the same page load. Catching that case needs the
 * read-back, not just a try/catch around the write.
 *
 * NOTE: this does NOT catch modern iOS Safari 16+ private mode, where storage
 * round-trips fine in-session and is only wiped on close (ephemeral, not
 * broken). That case is covered — imperfectly — by the quota heuristic.
 */
function localStorageBroken(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    const k = '__caw_pm_probe__'
    const v = 'caw'
    localStorage.setItem(k, v)
    const readBack = localStorage.getItem(k)
    localStorage.removeItem(k)
    // Write succeeded but the value didn't stick → storage is a no-op shim.
    return readBack !== v
  } catch {
    // QuotaExceededError / SecurityError on write — classic private-mode tell
    // (older Safari, locked-down WebViews).
    return true
  }
}

/**
 * StorageManager quota heuristic. Private windows are handed a much smaller
 * quota than a normal profile. Chrome/Edge incognito caps at ~120 MB; a normal
 * window reports gigabytes. We treat a quota under ~300 MB as a private signal.
 * Returns null when the API is unavailable or the number looks normal.
 */
async function quotaLooksPrivate(): Promise<boolean | null> {
  if (!navigator.storage?.estimate) return null
  try {
    const { quota } = await navigator.storage.estimate()
    if (typeof quota !== 'number') return null
    // Normal profiles report well into the GBs; incognito is capped low.
    return quota < 300 * 1024 * 1024
  } catch {
    return null
  }
}

/**
 * IndexedDB open probe — the Safari-specific tell. In some private-mode Safari
 * builds opening a database errors outright; in others it "succeeds" but never
 * persists. We only count a hard open error here. Resolves false on success or
 * timeout (inconclusive ≠ private).
 */
function indexedDbBroken(): Promise<boolean> {
  return new Promise(resolve => {
    if (!('indexedDB' in window)) {
      resolve(false)
      return
    }
    let settled = false
    const done = (v: boolean) => {
      if (settled) return
      settled = true
      resolve(v)
    }
    // Don't hang the welcome screen on a wedged request.
    const timer = setTimeout(() => done(false), 1500)
    try {
      const req = indexedDB.open('__caw_pm_probe__')
      req.onerror = () => {
        clearTimeout(timer)
        done(true)
      }
      req.onsuccess = () => {
        clearTimeout(timer)
        try { req.result.close() } catch { /* ignore */ }
        try { indexedDB.deleteDatabase('__caw_pm_probe__') } catch { /* ignore */ }
        done(false)
      }
    } catch {
      clearTimeout(timer)
      done(true)
    }
  })
}

/**
 * Returns true when the current window is *probably* private/incognito.
 *
 * A broken localStorage or IndexedDB is conclusive on its own. The quota
 * heuristic is softer, so we only let it flip the result when storage APIs
 * exist but report a suspiciously small quota. Any thrown error resolves to
 * false — we never want detection itself to block onboarding.
 */
export async function isPrivateWindow(): Promise<boolean> {
  try {
    if (localStorageBroken()) return true

    const [quota, idb] = await Promise.all([
      quotaLooksPrivate(),
      indexedDbBroken(),
    ])
    if (idb) return true
    if (quota === true) return true
    return false
  } catch {
    return false
  }
}
