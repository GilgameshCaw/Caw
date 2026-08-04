/**
 * Deploy-epoch guard: force a one-time local-state reset when the contracts are
 * redeployed with new addresses / reassigned tokenIds.
 *
 * A full CawProfile-cascade redeploy (new Ledger/Actions/Minter + a DB reset)
 * invalidates EVERYTHING a returning browser has cached: caw-token-data (old
 * tokenIds that no longer exist), per-tokenId passkey credentials, the known-
 * passkey-wallets set, Quick Sign sessions registered against the OLD Ledger, the
 * auth session (old authorized tokenIds → 403s), wagmi/DM/invite state. Without a
 * reset a returning user sees a broken chooser, dead sessions, and InvalidSig
 * everywhere.
 *
 * Bump DEPLOY_EPOCH on every contract redeploy that reassigns tokenIds / changes
 * the core addresses. On boot, if the stored epoch differs, we wipe local + session
 * storage + IndexedDB + wagmi, set the new epoch, and reload once — so every
 * returning browser self-heals automatically.
 *
 * Only bump this for a tokenId-reassigning / core-address redeploy — NOT for a
 * routine FE ship (that would needlessly log everyone out).
 */

// 2026-07-24 testnet redeploy: CawProfile (250k lzReceive gas) + Marketplace
// (lzDestId param) + full cascade + DB reset. New contracts from tokenId 0.
// -r2: the first guard build skipped the wipe for pre-guard browsers (no epoch
// key → treated as first-visit) and mis-stamped them. Bump so those browsers
// re-evaluate and wipe. hasPriorDeploymentState() now covers the null case too.
export const DEPLOY_EPOCH = '2026-07-24-testnet-caw-cascade-r2'

const EPOCH_KEY = 'caw:deploy-epoch'

// Storage keys that only exist if this browser has used a PRIOR deployment of the
// app. The deploy-epoch key was introduced in the 2026-07-24 redeploy, so a
// browser coming from an older build has NO epoch key but DOES have these — that
// combination is a pre-guard stale browser, not a first-ever visitor, and it must
// be wiped. A genuine first-ever visit has none of these.
const PRIOR_STATE_KEYS = ['caw-token-data', 'caw-pinned-profiles', 'wagmi']
const PRIOR_STATE_PREFIXES = ['caw:passkey-credential-id:', 'caw:pendingDeposit:']

/** True if this browser holds CAW state from a build that predates the epoch guard. */
function hasPriorDeploymentState(): boolean {
  try {
    for (const k of PRIOR_STATE_KEYS) {
      if (localStorage.getItem(k) !== null) return true
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key && PRIOR_STATE_PREFIXES.some(p => key.startsWith(p))) return true
    }
  } catch { /* storage unavailable */ }
  return false
}

/**
 * Run ONCE at app boot, before the app reads any cached state. If the stored
 * deploy epoch differs from DEPLOY_EPOCH, wipe all local state and reload.
 * Returns true if it triggered a reset (caller can short-circuit render).
 *
 * Synchronous storage clears run inline; the async wagmi/IndexedDB teardown is
 * best-effort and fire-and-forget before the reload. We set the new epoch FIRST
 * so a reload can't loop (the epoch survives the localStorage.clear because we
 * re-write it immediately after).
 */
export function enforceDeployEpoch(): boolean {
  let stored: string | null = null
  try { stored = localStorage.getItem(EPOCH_KEY) } catch { return false /* storage unavailable */ }

  if (stored === DEPLOY_EPOCH) return false

  // No epoch key. Two cases:
  //   - a genuine first-ever visit → no prior CAW state → just stamp, nothing to reset.
  //   - a browser from a build that PREDATES the epoch guard (this is the common case
  //     right after the guard first ships) → it has old caw-token-data / wagmi / passkey
  //     state keyed to the OLD contracts and MUST be wiped, exactly like an epoch change.
  if (stored === null && !hasPriorDeploymentState()) {
    try { localStorage.setItem(EPOCH_KEY, DEPLOY_EPOCH) } catch { /* ignore */ }
    return false
  }

  // Epoch changed (or a pre-guard stale browser) → wipe local state for the new contracts.
  console.warn(`[deployEpoch] contract redeploy detected (${stored ?? 'pre-guard'} → ${DEPLOY_EPOCH}) — resetting local state`)

  try { localStorage.clear() } catch { /* ignore */ }
  try { sessionStorage.clear() } catch { /* ignore */ }
  // Re-stamp the new epoch immediately so the post-reload boot doesn't loop.
  try { localStorage.setItem(EPOCH_KEY, DEPLOY_EPOCH) } catch { /* ignore */ }

  // Best-effort async teardown (IndexedDB + wagmi), then reload. We don't await
  // in a way that blocks — the reload happens regardless after a short beat.
  void (async () => {
    try {
      if (typeof indexedDB !== 'undefined' && (indexedDB as { databases?: () => Promise<Array<{ name?: string }>> }).databases) {
        const dbs = await (indexedDB as { databases: () => Promise<Array<{ name?: string }>> }).databases()
        await Promise.all(
          dbs.filter(db => db.name).map(db => new Promise<void>(resolve => {
            const req = indexedDB.deleteDatabase(db.name!)
            req.onsuccess = req.onerror = req.onblocked = () => resolve()
          })),
        )
      }
    } catch { /* older Safari lacks indexedDB.databases — fall through */ }
    // Clear cookies for this origin (best-effort; HttpOnly ones need the server).
    try {
      for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim()
        if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`
      }
    } catch { /* ignore */ }
  })()

  // Reload once so the app re-boots against clean storage + the new contracts.
  try { window.location.reload() } catch { /* ignore */ }
  return true
}
