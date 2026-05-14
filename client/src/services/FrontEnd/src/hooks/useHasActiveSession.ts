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

  if (!enabled) return false

  const ownerAddress = activeToken?.owner?.toLowerCase()
  if (!ownerAddress) return false

  const session = sessions[ownerAddress]
  if (!session) return false

  return session.expiry > Date.now() / 1000
}
