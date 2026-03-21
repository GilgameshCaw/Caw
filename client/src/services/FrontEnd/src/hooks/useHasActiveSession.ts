import { useSessionKeyStore } from '~/store/sessionKeyStore'

/**
 * Returns true if Quick Sign is enabled and there's a valid (non-expired) session key.
 * Address-based: covers all tokens owned by the delegating wallet.
 */
export function useHasActiveSession(): boolean {
  const enabled = useSessionKeyStore(s => s.enabled)
  const session = useSessionKeyStore(s => s.session)

  if (!enabled || !session) {
    console.log(`[QuickSign] No active session. enabled=${enabled}, session=${!!session}`)
    return false
  }

  const active = session.expiry > Date.now() / 1000
  const limit = session.spendLimit || 'undefined'
  const spent = session.spent || '0'
  console.log(`[QuickSign] Session active=${active}, spendLimit=${limit}, spent=${spent}, expiry=${new Date(session.expiry * 1000).toISOString()}`)

  return active
}
