import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import { useActiveToken } from '~/store/tokenDataStore'
import { apiFetch, retryOnIndexing } from '~/api/client'

/** Pages that should NOT be redirected away from */
const EXEMPT_PREFIXES = ['/welcome', '/usernames/new', '/help', '/faucet', '/admin']

/**
 * Checks if the active user has incomplete onboarding and redirects to /welcome/:username.
 * Renders nothing — purely a side-effect component.
 */
export default function OnboardingGuard() {
  const activeToken = useActiveToken()
  const location = useLocation()
  const navigate = useNavigate()
  const [checked, setChecked] = useState<string | null>(null)

  const username = activeToken?.username

  useEffect(() => {
    if (!username) return
    // Don't re-check for the same user
    if (checked === username) return
    // Don't check on exempt pages
    if (EXEMPT_PREFIXES.some(p => location.pathname.startsWith(p))) return

    // Wrap in retryOnIndexing: the backend returns 202 when the User row
    // hasn't been indexed yet (fresh mint, NftTransferWatcher still
    // catching up). Without the retry, we'd treat the 202 as a generic
    // error in .catch(), mark the username "checked", and never redirect
    // — user gets stranded on /home post-mint instead of seeing the
    // welcome flow. Symptom: intermittently missing welcome after zap.
    retryOnIndexing(() =>
      apiFetch<{ onboardingStep: number }>(`/api/users/onboarding/${username}`)
    )
      .then(res => {
        setChecked(username)
        if (res.onboardingStep >= 0 && res.onboardingStep < 5) {
          navigate(`/welcome/${username}`, { replace: true })
        }
      })
      .catch(() => {
        setChecked(username)
      })
  }, [username, location.pathname])

  return null
}
