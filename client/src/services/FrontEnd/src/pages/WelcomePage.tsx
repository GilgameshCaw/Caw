import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import PostMintOnboarding from '~/components/PostMintOnboarding'

const WelcomePage: React.FC = () => {
  const { username } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const activeToken = useActiveToken()
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)

  const [initialStep, setInitialStep] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)

  // Find the token for this username
  const tokenId = useMemo(() => {
    const allTokens = Object.values(tokensByAddress).flat()
    const token = allTokens.find(
      t => t.username?.toLowerCase() === username?.toLowerCase()
    )
    return token?.tokenId ?? activeToken?.tokenId
  }, [tokensByAddress, username, activeToken?.tokenId])

  useEffect(() => {
    if (!username) { navigate('/home', { replace: true }); return }

    let cancelled = false

    const init = async () => {
      // Ensure user record exists in DB (tokenId may be 0 for fresh mints — that's OK, ensure will handle it)
      if (tokenId) {
        try {
          await apiFetch('/api/users/ensure', {
            method: 'POST',
            body: JSON.stringify({ tokenId }),
          })
        } catch {}
      }

      if (cancelled) return

      try {
        const res = await apiFetch<{ onboardingStep: number }>(`/api/users/onboarding/${username}`)
        if (cancelled) return
        if (res.onboardingStep === -1) {
          // User not found in DB — for /welcome this is expected for fresh mints
          setInitialStep(0)
        } else if (res.onboardingStep >= 5) {
          navigate('/home', { replace: true })
        } else {
          setInitialStep(res.onboardingStep)
        }
      } catch {
        if (!cancelled) navigate('/home', { replace: true })
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    init()

    return () => { cancelled = true }
  }, [username])

  if (loading || initialStep === null) {
    return (
      <div className="fixed inset-0 z-[100] bg-black flex items-center justify-center">
        <svg className="animate-spin h-10 w-10 text-yellow-500" fill="none" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
        </svg>
      </div>
    )
  }

  return (
    <PostMintOnboarding
      username={username!}
      tokenId={tokenId ?? 0}
      initialStep={initialStep}
      onComplete={() => {
        // Mark onboarding complete
        apiFetch(`/api/users/onboarding/${username}`, {
          method: 'PATCH',
          body: JSON.stringify({ step: 5 }),
        }).catch(() => {})
        navigate('/home', { replace: true })
      }}
    />
  )
}

export default WelcomePage
