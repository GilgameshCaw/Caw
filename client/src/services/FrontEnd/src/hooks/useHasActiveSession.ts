import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'

/**
 * Returns true if Quick Sign is enabled and there's a valid (non-expired) session key
 * for the active token's owner. The session key was delegated by the owner, so the
 * lookup is owner-keyed — independent of whichever wallet is currently connected.
 */
export function useHasActiveSession(): boolean {
  const sessions = useSessionKeyStore(s => s.sessions)
  const activeToken = useActiveToken()

  // NOTE: intentionally does NOT gate on the shared global `enabled` boolean.
  // Sessions are per-owner, but `enabled` is a single browser-wide flag that any
  // account's revoke/clear flips off (clearSession/clearSessionForAddress set
  // enabled:false). That produced a split-brain: /settings/session-keys showed an
  // account as enabled (it keys on the stored session existing) while the chooser
  // + action-signing here read the stale global flag as OFF and demanded wallet
  // signing / "Activate Quick Sign". A stored, non-expired session for the active
  // owner reliably means the user wants Quick Sign for THIS account — revoke
  // DELETES the key (useRevokeSession → clearSession), so a lingering session is
  // never a "disabled" state. Key on per-owner session presence + validity only.

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
