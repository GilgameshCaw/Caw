import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'

/**
 * Returns true if Quick Sign is enabled and there's a valid (non-expired) session key
 * for the active token's owner. The session key was delegated by the owner, so the
 * lookup is owner-keyed — independent of whichever wallet is currently connected.
 */
export function useHasActiveSession(): boolean {
  const enabled = useSessionKeyStore(s => s.enabled)
  const sessions = useSessionKeyStore(s => s.sessions)
  const activeToken = useActiveToken()

  // [POPB-DBG][qs-gate] Disambiguate WHY "Quick Sign not enabled": global enabled flag
  // off vs no active token (data not loaded) vs no session stored for this owner vs
  // expired. `reason` pinpoints which condition failed. Logs only on the false paths
  // to keep render noise down. Remove once QS-after-onboarding is reliable.
  if (!enabled) {
    console.log('[POPB-DBG][qs-gate] false: enabled flag is OFF')
    return false
  }

  // Owner-keyed ONLY — do not fall back to activeWallet here. For Population A,
  // activeWallet tracks the connected wagmi wallet, and a fallback would let a
  // profile with no delegated session inherit the connected wallet's session
  // under a different address (the exact cross-profile bug fixed in 10d15a91).
  // The Pop-B onboarding "owner briefly diverges" case is handled in actions.ts
  // (session resolution), gated on there being no connected wallet — see there.
  const ownerAddress = activeToken?.owner?.toLowerCase()
  if (!ownerAddress) {
    console.log('[POPB-DBG][qs-gate] false: no active token owner (token data not loaded?)', {
      activeTokenId: activeToken?.tokenId ?? 'none',
    })
    return false
  }

  const session = sessions[ownerAddress]
  if (!session) {
    console.log('[POPB-DBG][qs-gate] false: no session stored for owner', {
      ownerAddress,
      storedSessionOwners: Object.keys(sessions),
    })
    return false
  }

  const valid = session.expiry > Date.now() / 1000
  if (!valid) {
    console.log('[POPB-DBG][qs-gate] false: session EXPIRED', {
      ownerAddress, expiry: session.expiry, now: Math.floor(Date.now() / 1000),
    })
  }
  return valid
}
