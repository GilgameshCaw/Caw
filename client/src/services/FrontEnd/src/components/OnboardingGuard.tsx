import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useActiveToken } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'

/** Pages that should NOT be redirected away from */
const EXEMPT_PREFIXES = ['/welcome', '/usernames/new']

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

    apiFetch<{ onboardingStep: number }>(`/api/users/onboarding/${username}`)
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
