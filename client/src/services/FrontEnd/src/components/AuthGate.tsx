import { Navigate } from 'react-router-dom'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'

/**
 * Wraps a route element and redirects to the captive splash page
 * if the user has no wallet connected and no username.
 *
 * Users who have connected a wallet but not yet minted get through
 * (so they can reach /usernames/new from the splash CTA).
 *
 * The gate waits for tokenDataStore hydration before deciding,
 * to avoid a flash redirect on page load.
 */
export default function AuthGate({ children }: { children: React.ReactNode }) {
  const activeToken = useActiveToken()
  const hasHydrated = useTokenDataStore(s => s.hasHydrated)

  // Wait for persisted state to load before gating
  if (!hasHydrated) return null

  // If user has no token at all (no wallet or no NFT minted), redirect
  if (!activeToken?.username) {
    return <Navigate to="/welcome" replace />
  }

  return <>{children}</>
}
