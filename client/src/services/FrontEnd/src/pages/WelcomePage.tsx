import React, { useEffect, useMemo, useState } from 'react'
import { useParams, useNavigate, useLocation } from 'react-router-dom'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { apiFetch } from '~/api/client'
import PostMintOnboarding from '~/components/PostMintOnboarding'
import BugReportModal from '~/components/modals/BugReportModal'
import BugIcon from '~/components/icons/BugIcon'
import BoidsBg from '~/components/BoidsBg'
import { useTheme } from '~/hooks/useTheme'

const WelcomePage: React.FC = () => {
  const { isDark } = useTheme()
  const { username } = useParams<{ username: string }>()
  const navigate = useNavigate()
  const location = useLocation()
  const tokensByAddress = useTokenDataStore(s => s.tokensByAddress)
  const setActiveTokenId = useTokenDataStore(s => s.setActiveTokenId)

  // Check if user just minted+deposited (stake pending via LayerZero)
  // pendingDeposit is the wei amount as a string, or null
  const pendingDeposit = (location.state as any)?.pendingDeposit as string | null ?? null

  const [initialStep, setInitialStep] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showBugReport, setShowBugReport] = useState(false)
  const [loadingMessage, setLoadingMessage] = useState('Loading your profile...')

  // Find the token for this username. IMPORTANT: do NOT fall back to
  // activeToken?.tokenId — right after a fresh mint, activeToken is still the
  // previously-selected profile, and using it here causes /api/users/ensure
  // to be called with the WRONG tokenId on the first render (observed as
  // tokenId=2 or tokenId=11 in logs), producing a 404/500 cascade. Instead,
  // we wait for tokensByAddress to include the newly-minted token and only
  // resolve once we find a match by username.
  const tokenId = useMemo(() => {
    if (!username) return undefined
    const allTokens = Object.values(tokensByAddress).flat()
    const token = allTokens.find(
      t => t.username?.toLowerCase() === username.toLowerCase()
    )
    return token?.tokenId
  }, [tokensByAddress, username])

  // Ensure the active token is set to the user being onboarded
  useEffect(() => {
    if (tokenId && tokenId !== useTokenDataStore.getState().activeTokenId) {
      setActiveTokenId(tokenId)
    }
  }, [tokenId, setActiveTokenId])

  useEffect(() => {
    if (!username) { navigate('/home', { replace: true }); return }

    let cancelled = false
    const startTime = Date.now()
    const TOTAL_TIMEOUT = 60000 // 60 seconds total (more generous)

    const init = async () => {
      console.log(`[WelcomePage] Starting init for username=${username}, tokenId=${tokenId}`)

      try {
        // Ensure user record exists in DB (tokenId may be 0 for fresh mints — that's OK, ensure will handle it)
        if (tokenId) {
          try {
            const elapsed = Date.now() - startTime
            const remainingTime = TOTAL_TIMEOUT - elapsed
            console.log(`[WelcomePage] Calling /api/users/ensure with tokenId=${tokenId}, remainingTime=${remainingTime}ms`)

            if (remainingTime > 0) {
              setLoadingMessage('Connecting to blockchain...')
              const ensureStart = Date.now()
              await Promise.race([
                apiFetch('/api/users/ensure', {
                  method: 'POST',
                  body: JSON.stringify({ tokenId }),
                }),
                new Promise((_, reject) =>
                  setTimeout(() => reject(new Error('Timeout creating user record')), remainingTime)
                )
              ])
              const ensureDuration = Date.now() - ensureStart
              console.log(`[WelcomePage] /api/users/ensure completed in ${ensureDuration}ms`)

              // Pending deposit info is now owned entirely by the client-side
              // localStorage hint (written in New.tsx) and the server-side
              // TxQueue.pendingDepositTxHash path. No DB write needed here.
            } else {
              console.warn(`[WelcomePage] Skipping /api/users/ensure - no time remaining`)
            }
          } catch (err: any) {
            // Check if we've exceeded total timeout
            const totalElapsed = Date.now() - startTime
            console.error(`[WelcomePage] ensure failed after ${totalElapsed}ms:`, err.message)

            if (totalElapsed >= TOTAL_TIMEOUT) {
              if (!cancelled) {
                setError('Timeout waiting for user data. This may be due to RPC connection issues.')
                setLoading(false)
              }
              return
            }
            // Log but don't fail - we'll try to check onboarding status anyway
            console.warn('[WelcomePage] ensure failed but continuing:', err.message)
          }
        } else {
          console.warn('[WelcomePage] No tokenId available, skipping /api/users/ensure')
        }

        if (cancelled) return

        // Check total timeout before second call
        const elapsed = Date.now() - startTime
        const remainingTime = TOTAL_TIMEOUT - elapsed
        console.log(`[WelcomePage] Calling /api/users/onboarding/${username}, remainingTime=${remainingTime}ms`)

        if (remainingTime <= 0) {
          console.error('[WelcomePage] No time remaining for onboarding status check')
          if (!cancelled) {
            setError('Timeout waiting for user data. This may be due to RPC connection issues.')
            setLoading(false)
          }
          return
        }

        setLoadingMessage('Loading your profile...')
        const onboardingStart = Date.now()
        const res = await Promise.race([
          apiFetch<{ onboardingStep: number }>(`/api/users/onboarding/${username}`),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout fetching onboarding status')), remainingTime)
          )
        ]) as { onboardingStep: number }
        const onboardingDuration = Date.now() - onboardingStart
        console.log(`[WelcomePage] /api/users/onboarding completed in ${onboardingDuration}ms, step=${res.onboardingStep}`)

        if (cancelled) return

        if (res.onboardingStep === -1) {
          // User not found in DB — for /welcome this is expected for fresh mints
          console.log('[WelcomePage] User not found in DB (expected for fresh mint), starting onboarding at step 0')
          setInitialStep(0)
        } else if (res.onboardingStep >= 5) {
          console.log('[WelcomePage] Onboarding complete, redirecting to home')
          navigate('/home', { replace: true })
        } else {
          console.log(`[WelcomePage] Resuming onboarding at step ${res.onboardingStep}`)
          setInitialStep(res.onboardingStep)
        }

        const totalDuration = Date.now() - startTime
        console.log(`[WelcomePage] Init completed successfully in ${totalDuration}ms`)
        setLoading(false)
      } catch (err: any) {
        const totalDuration = Date.now() - startTime
        console.error(`[WelcomePage] Init failed after ${totalDuration}ms:`, err)

        if (!cancelled) {
          if (err.message && err.message.includes('Timeout')) {
            console.error('[WelcomePage] Timeout detected, showing error modal')
            setError('Timeout waiting for user data. This may be due to RPC connection issues.')
          } else {
            console.error('[WelcomePage] Non-timeout error, redirecting to home')
            // For other errors, navigate home
            navigate('/home', { replace: true })
            return
          }
          setLoading(false)
        }
      }
    }

    init()

    return () => {
      console.log(`[WelcomePage] Cleanup triggered for username=${username}`)
      cancelled = true
    }
  }, [username, tokenId, navigate])

  if (error) {
    return (
      <>
        <BoidsBg isDark={isDark} />
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className="max-w-md mx-auto px-6 text-center">
            <div className={`rounded-lg p-6 mb-4 ${isDark ? 'bg-red-900/20 border border-red-500/30' : 'bg-red-50 border border-red-300'}`}>
              <svg className="w-12 h-12 text-red-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <h2 className={`text-xl font-bold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>Connection Timeout</h2>
              <p className={`text-sm mb-4 ${isDark ? 'text-gray-300' : 'text-gray-700'}`}>{error}</p>
              <p className={`text-xs mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                This usually happens when the blockchain RPC connection is slow or unavailable.
                Your account was created successfully, but we're having trouble fetching your profile data.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => {
                    setError(null)
                    setLoading(true)
                    window.location.reload()
                  }}
                  className="px-4 py-2 bg-yellow-500 hover:bg-yellow-600 text-black font-semibold rounded-lg transition-colors"
                >
                  Retry
                </button>
                <button
                  onClick={() => navigate('/home')}
                  className={`px-4 py-2 font-semibold rounded-lg transition-colors ${isDark ? 'bg-gray-700 hover:bg-gray-600 text-white' : 'bg-gray-200 hover:bg-gray-300 text-black'}`}
                >
                  Go to Home
                </button>
              </div>
            </div>
          </div>
        </div>
        <div className="fixed bottom-5 left-5 md:right-5 md:left-auto z-[101]">
          <button
            onClick={() => setShowBugReport(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 bg-zinc-800 hover:bg-zinc-700 text-white/70"
          >
            <BugIcon />
          </button>
        </div>
        <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
      </>
    )
  }

  if (loading || initialStep === null) {
    return (
      <>
        <BoidsBg isDark={isDark} />
        <div className="fixed inset-0 z-[100] flex items-center justify-center">
          <div className={`text-center px-6 py-8 rounded-2xl backdrop-blur-sm ${isDark ? 'bg-black/40' : 'bg-white/40'}`}>
            <svg className="animate-spin h-10 w-10 text-yellow-500 mx-auto mb-4" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{loadingMessage}</p>
            <p className={`text-xs mt-2 ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>This may take up to a minute...</p>
          </div>
        </div>
        <div className="fixed bottom-5 left-5 md:right-5 md:left-auto z-[101]">
          <button
            onClick={() => setShowBugReport(true)}
            className="w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 bg-zinc-800 hover:bg-zinc-700 text-white/70"
          >
            <BugIcon />
          </button>
        </div>
        <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
      </>
    )
  }

  return (
    <PostMintOnboarding
      username={username!}
      tokenId={tokenId ?? 0}
      initialStep={initialStep}
      pendingDeposit={pendingDeposit}
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
