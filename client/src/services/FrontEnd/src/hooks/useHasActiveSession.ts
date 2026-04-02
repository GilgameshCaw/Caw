import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActiveToken } from '~/store/tokenDataStore'

/**
 * Returns true if Quick Sign is enabled and there's a valid (non-expired) session key
 * for the active token's owner. This allows Quick Sign to work even when the connected
 * wallet differs from the token owner — the session key was delegated by the owner.
 */
export function useHasActiveSession(): boolean {
  const enabled = useSessionKeyStore(s => s.enabled)
  const sessions = useSessionKeyStore(s => s.sessions)
  const activeWallet = useSessionKeyStore(s => s.activeWallet)
  const activeToken = useActiveToken()

  if (!enabled) return false

  // Check token owner's session first, then fall back to connected wallet's session
  const ownerAddress = activeToken?.owner?.toLowerCase()
  const session = (ownerAddress && sessions[ownerAddress]) || (activeWallet && sessions[activeWallet]) || null

  if (!session) return false

  return session.expiry > Date.now() / 1000
}
