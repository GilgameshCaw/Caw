import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Tooltip from '~/components/Tooltip'
import { useAccount, useConnections, useSwitchChain, useReadContract } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { maxUint256, parseUnits, formatUnits, erc20Abi } from 'viem'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { useAuthStore } from '~/store/authStore'
import { useDmClient } from '~/hooks/useDm'
import { useDmIdentity } from '~/hooks/useDmIdentity'
import { useCreateSession, DEFAULT_SPEND_LIMIT, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import useAllowance from '~/hooks/useAllowance'
import useContractCall from '~/hooks/useContractCall'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawNameAbi, cawNameQuoterAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import { handleError } from '~/utils'
import { apiFetch } from '~/api/client'

const persistOnboardingStep = (username: string, step: number) => {
  apiFetch(`/api/users/onboarding/${username}`, {
    method: 'PATCH',
    body: JSON.stringify({ step }),
  }).catch(() => {})
}
import BugReportModal from '~/components/modals/BugReportModal'
import LayerZeroStatus from '~/components/LayerZeroStatus'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import QuickSignOptions from '~/components/QuickSignOptions'
import { FollowButton } from '~/components/FollowButton'
import cawLogo from '~/assets/images/caw-logo.png'
import UsernameSvg from '~/components/UsernameSvg'
import {
  HiOutlineCube,
  HiOutlineLockClosed,
  HiLightningBolt,
  HiOutlineUserGroup,
  HiCheck,
  HiArrowRight,
} from 'react-icons/hi'

const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)

interface SuggestedUser {
  tokenId: number
  username: string
  displayName: string | null
  avatarUrl: string | null
  image: string | null
  followerCount: number
  likeCount: number
  isFollowing: boolean
  followPending: boolean
}

type StepId = 'verify' | 'stake' | 'dms' | 'quicksign' | 'follow'

interface StepDef {
  id: StepId
  label: string
  shortLabel?: string
  icon: React.ReactNode
  skipWarning: string
}

const STEPS: StepDef[] = [
  { id: 'verify',    label: 'Log In',       icon: <div className="w-6 h-6" style={{ backgroundColor: 'currentColor', maskImage: 'url(/icons/crow-2.svg)', maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskImage: 'url(/icons/crow-2.svg)', WebkitMaskSize: 'contain', WebkitMaskRepeat: 'no-repeat', WebkitMaskPosition: 'center' }} />, skipWarning: 'You\'ll likely need to do this later.' },
  { id: 'stake',     label: 'Stake',        icon: <HiOutlineCube className="w-5 h-5" />,                   skipWarning: 'Staked CAW is needed to post, like, and follow.' },
  { id: 'dms',       label: 'DMs',          icon: <HiOutlineLockClosed className="w-5 h-5" />,             skipWarning: 'Other users won\'t be able to message you.' },
  { id: 'quicksign', label: 'Quick Sign',     shortLabel: 'QS', icon: <HiLightningBolt className="w-5 h-5" />, skipWarning: 'You\'ll see a wallet popup for every action.' },
  { id: 'follow',    label: 'Follow',       icon: <HiOutlineUserGroup className="w-5 h-5" />,              skipWarning: '' },
]

interface PostMintOnboardingProps {
  username: string
  tokenId: number
  initialStep?: number
  onComplete: () => void
}

const PostMintOnboarding: React.FC<PostMintOnboardingProps> = ({ username, tokenId, initialStep = 0, onComplete }) => {
  const [currentStep, setCurrentStep] = useState(initialStep)
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(new Set())
  const [skippedSteps, setSkippedSteps] = useState<Set<StepId>>(new Set())
  const userNavigatedRef = useRef(false)
  const [showBugReport, setShowBugReport] = useState(false)
  const setOnStake = useInsufficientStakeStore(s => s.setOnStake)

  // Register onStake handler so the insufficient stake modal jumps to stake step
  useEffect(() => {
    setOnStake(() => setCurrentStep(1))
    return () => setOnStake(undefined)
  }, [setOnStake])

  // ── Step 1: Verify wallet ──
  const { verify, isVerifying, error: verifyError } = useVerifyWallet()
  const authorizedAddresses = useAuthStore(s => s.authorizedAddresses)

  // ── Step 2: Stake ──
  const activeToken = useActiveToken()
  const { address, isConnected } = useAccount()

  // For onboarding, check address-based auth since the new tokenId may not be in the DB yet
  const isWalletAuthorized = !!address && authorizedAddresses.includes(address.toLowerCase())
  // Check if user has an active auth session (persisted, doesn't require wallet connected)
  const isProfileAuthorized = useAuthStore(s => s.isTokenAuthorized(tokenId)) || isWalletAuthorized
  const connections = useConnections()
  const { switchChain } = useSwitchChain()
  const { openConnectModal } = useConnectModal()
  const [amount, setAmount] = useState<string>('')
  const [depositFee, setDepositFee] = useState<bigint>(0n)
  const [isStakePending, setIsStakePending] = useState(false)
  const [isApprovePending, setIsApprovePending] = useState(false)
  const [stakeTxSubmitted, setStakeTxSubmitted] = useState(false) // tx confirmed on L1
  const [stakeConfirmed, setStakeConfirmed] = useState(false)     // LZ delivered to L2
  const [stakedAmountBefore, setStakedAmountBefore] = useState<bigint | null>(null)
  const refetchTokenData = useTokenDataStore(s => s.refetchTokenData)

  const wrongChainForStake = connections[0]?.chainId !== chains.l1.chainId
  const isTokenOwner = activeToken?.owner?.toLowerCase() === address?.toLowerCase()
  const { allowance, refetch: refetchAllowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_ADDRESS)

  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    chainId: chains.l1.chainId,
    functionName: 'balanceOf',
    args: [address!],
    query: { enabled: !!tokenId && !!address }
  })

  const { data: depositQuote } = useReadContract({
    abi: cawNameQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: 'depositQuote',
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [CLIENT_ID, tokenId ?? 0, parseUnits(amount || '0', 18), chains.l2.layerZero, false],
    query: { enabled: !!tokenId && !!amount && currentStep === 1 }
  })

  useEffect(() => {
    if (depositQuote?.nativeFee != null) setDepositFee(BigInt(depositQuote.nativeFee))
  }, [depositQuote])

  const insufficientBalance = !balance || parseUnits(amount || '0', 18) > balance
  const needsApproval = !allowance || parseUnits(amount || '0', 18) > allowance

  const availableBalance = useMemo(() => {
    if (!balance) return 0
    return Number(formatUnits(balance, 18))
  }, [balance])

  const getPresetAmounts = (maxBalance: number): number[] => {
    const allPresets = [10_000, 100_000, 1_000_000, 10_000_000, 100_000_000, 1_000_000_000]
    return allPresets.filter(v => v <= maxBalance).slice(-4)
  }

  const formatPresetLabel = (value: number): string => {
    if (value >= 1_000_000_000) return `${value / 1_000_000_000}B`
    if (value >= 1_000_000) return `${value / 1_000_000}M`
    if (value >= 1_000) return `${value / 1_000}K`
    return value.toString()
  }

  const approve = useContractCall({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    functionName: 'approve',
    args: [CAW_NAMES_ADDRESS, maxUint256],
    disabled: !amount || insufficientBalance || !isTokenOwner,
    onError: (err) => { handleError(err, 'approve'); setIsApprovePending(false) },
    onPending: () => { setIsApprovePending(true) },
    onSuccess: async () => {
      setIsApprovePending(false)
      refetchAllowance()
      await new Promise(r => setTimeout(r, 500))
      setIsStakePending(true)
      await stake.call()
    },
  })

  const stake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: 'deposit',
    args: [CLIENT_ID, tokenId || 0, parseUnits((amount || '0').toString(), 18), chains.l2.layerZero, 0n],
    disabled: !tokenId || !amount || depositFee === 0n || !isTokenOwner,
    value: depositFee,
    onPending: () => { setIsStakePending(true) },
    onSuccess: async () => {
      setIsStakePending(false)
      setStakeTxSubmitted(true)
      setAmount('')
      refetchTokenData?.()
      refetchBalance()
      if (activeToken?.username) {
        try {
          await fetch(`/api/users/${activeToken.username}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lastStakedAt: new Date().toISOString() })
          })
        } catch {}
      }
    },
    onError: (err) => { handleError(err, 'stake'); setIsStakePending(false) },
  })

  const handleStake = useCallback(async () => {
    if (!isConnected) { openConnectModal?.(); return }
    if (wrongChainForStake) {
      try { await switchChain({ chainId: chains.l1.chainId }) } catch {}
      return
    }
    // Capture staked amount before tx so we can detect the L2 update
    setStakedAmountBefore(activeToken?.stakedAmount ?? 0n)
    if (needsApproval) {
      setIsApprovePending(true)
      await approve.call()
    } else {
      setIsStakePending(true)
      await stake.call()
    }
  }, [isConnected, wrongChainForStake, needsApproval, approve, stake, switchChain, openConnectModal])

  // Poll for L2 stake arrival after tx submitted
  useEffect(() => {
    if (!stakeTxSubmitted || stakeConfirmed || stakedAmountBefore === null) return

    const POLL_INTERVAL = 5_000
    const POLL_TIMEOUT = 5 * 60 * 1000 // 5 minutes
    const start = Date.now()

    const interval = setInterval(() => {
      refetchTokenData?.()
      const allTokens = Object.values(useTokenDataStore.getState().tokensByAddress).flat()
      const token = allTokens.find(t => t.tokenId === tokenId)
      if (token && token.stakedAmount > stakedAmountBefore) {
        setStakeConfirmed(true)
        markComplete('stake')
        clearInterval(interval)
      } else if (Date.now() - start > POLL_TIMEOUT) {
        setStakeConfirmed(true)
        markComplete('stake')
        clearInterval(interval)
      }
    }, POLL_INTERVAL)

    return () => clearInterval(interval)
  }, [stakeTxSubmitted, stakeConfirmed, stakedAmountBefore, tokenId, refetchTokenData])

  // ── Step 3: Enable DMs ──
  const { initializeClient: initDm, isLoading: dmEnabling } = useDmClient(tokenId)
  const { hasIdentity: dmAlreadyEnabled } = useDmIdentity(tokenId)
  const [dmComplete, setDmComplete] = useState(false)
  const [dmError, setDmError] = useState<string | null>(null)

  // Auto-detect if DMs are already enabled (update local state for UI)
  useEffect(() => {
    if (dmAlreadyEnabled) setDmComplete(true)
  }, [dmAlreadyEnabled])

  const handleEnableDms = async () => {
    setDmError(null)
    try {
      await initDm()
      setDmComplete(true)
      markComplete('dms')
    } catch (err) {
      setDmError(err instanceof Error ? err.message : 'Failed to enable DMs')
    }
  }

  // ── Step 4: Quick Sign ──
  const createSession = useCreateSession()
  const setSessionEnabled = useSessionKeyStore(s => s.setEnabled)
  const setHasSeenPrompt = useSessionKeyStore(s => s.setHasSeenPrompt)
  const [qsLoading, setQsLoading] = useState(false)
  const [qsStatus, setQsStatus] = useState('')
  const [qsError, setQsError] = useState<string | null>(null)
  const [qsComplete, setQsComplete] = useState(false)
  const [qsSpendLimit, setQsSpendLimit] = useState<bigint>(DEFAULT_SPEND_LIMIT)
  const [qsDuration, setQsDuration] = useState<number>(DEFAULT_SESSION_DURATION)

  const handleEnableQuickSign = async () => {
    setQsLoading(true)
    setQsError(null)
    try {
      setSessionEnabled(true)
      await createSession((s) => setQsStatus(s), qsSpendLimit, qsDuration)
      setHasSeenPrompt(true)
      setQsComplete(true)
      markComplete('quicksign')
    } catch (err: any) {
      setQsError(err?.shortMessage || err?.message || 'Failed to activate')
      setSessionEnabled(false)
    } finally {
      setQsLoading(false)
      setQsStatus('')
    }
  }

  // ── Step 5: Follow users ──
  const [suggestedUsers, setSuggestedUsers] = useState<SuggestedUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const fetchingUsersRef = useRef(false)

  useEffect(() => {
    if (currentStep === 4 && suggestedUsers.length === 0 && !fetchingUsersRef.current) {
      fetchingUsersRef.current = true
      setLoadingUsers(true)
      apiFetch<{ users: SuggestedUser[] }>('/api/users/top-followed?limit=10')
        .then(res => {
          setSuggestedUsers(res.users.filter(u => u.tokenId !== tokenId))
        })
        .catch(() => {})
        .finally(() => { setLoadingUsers(false); fetchingUsersRef.current = false })
    }
  }, [currentStep])

  // ── Helpers ──
  const markComplete = (step: StepId) => {
    setCompletedSteps(prev => new Set(prev).add(step))
    setSkippedSteps(prev => {
      const next = new Set(prev)
      next.delete(step)
      return next
    })
  }

  const handleSkip = () => {
    const stepId = STEPS[currentStep].id
    setSkippedSteps(prev => new Set(prev).add(stepId))
    goNext()
  }

  const goNext = () => {
    // Find the next step that isn't already completed
    for (let i = currentStep + 1; i < STEPS.length; i++) {
      if (!completedSteps.has(STEPS[i].id)) {
        setCurrentStep(i)
        persistOnboardingStep(username, i)
        return
      }
    }
    // All remaining steps are done — finish
    persistOnboardingStep(username, 5)
    onComplete()
  }

  // ── Side-effect detection for stepper states ──
  // Check actual state for each step and mark completed or skipped accordingly.
  // This runs on mount and whenever the underlying state changes.
  const hasActiveSession = useHasActiveSession()
  const authorizedTokenIds = useAuthStore(s => s.authorizedTokenIds)

  useEffect(() => {
    const checks: Record<StepId, boolean> = {
      verify:    isProfileAuthorized,
      stake:     stakeConfirmed || !!(activeToken?.stakedAmount && activeToken.stakedAmount > 0n),
      dms:       dmComplete || !!dmAlreadyEnabled,
      quicksign: qsComplete || hasActiveSession,
      follow:    false, // no persistent side effect to check
    }

    const completed = new Set<StepId>()
    const skipped = new Set<StepId>()

    for (let i = 0; i < STEPS.length; i++) {
      const stepId = STEPS[i].id
      if (checks[stepId]) {
        completed.add(stepId)
      } else if (i < currentStep) {
        // User is past this step but it's not actually done
        skipped.add(stepId)
      }
    }

    setCompletedSteps(completed)
    setSkippedSteps(skipped)
  }, [isProfileAuthorized, activeToken?.stakedAmount, dmAlreadyEnabled, dmComplete, hasActiveSession, qsComplete, stakeConfirmed, currentStep])

  // Auto-advance past steps that are already completed (but not when user explicitly clicked a step)
  const isStakeComplete = stakeConfirmed || !!(activeToken?.stakedAmount && activeToken.stakedAmount > 0n)
  const isDmsComplete = dmComplete || !!dmAlreadyEnabled
  const isQsComplete = qsComplete || hasActiveSession
  useEffect(() => {
    if (userNavigatedRef.current) {
      userNavigatedRef.current = false
      return
    }
    const checks: Record<StepId, boolean> = {
      verify: isProfileAuthorized,
      stake: isStakeComplete,
      dms: isDmsComplete,
      quicksign: isQsComplete,
      follow: false,
    }
    const currentStepId = STEPS[currentStep]?.id
    if (currentStepId && checks[currentStepId]) {
      // Current step is already done — find the next incomplete step
      for (let i = currentStep + 1; i < STEPS.length; i++) {
        if (!checks[STEPS[i].id]) {
          setCurrentStep(i)
          persistOnboardingStep(username, i)
          return
        }
      }
      // All steps complete
      persistOnboardingStep(username, 5)
      onComplete()
    }
  }, [isProfileAuthorized, isStakeComplete, isDmsComplete, isQsComplete, currentStep])

  // If wallet is authorized but this specific tokenId isn't in the session yet,
  // silently refresh the session to pick up the new tokenId (no signature needed)
  useEffect(() => {
    if (isWalletAuthorized) {
      if (tokenId && !authorizedTokenIds.includes(tokenId)) {
        const refreshSession = async () => {
          // Ensure user record exists in DB first
          try {
            await apiFetch('/api/users/ensure', {
              method: 'POST',
              body: JSON.stringify({ tokenId }),
            })
          } catch {}
          // Refresh session to pick up new tokenId
          try {
            const res = await apiFetch<{
              authorizedTokenIds: number[]
              authorizedAddresses: string[]
            }>('/api/auth/refresh', { method: 'POST' })
            useAuthStore.getState().addAuthorization(res.authorizedTokenIds, res.authorizedAddresses)
          } catch {}
        }
        refreshSession()
      }
    }
  }, [isWalletAuthorized, tokenId])

  const handleVerify = async () => {
    // Ensure user record exists in DB before verifying (new mint may not be indexed yet)
    try {
      await apiFetch('/api/users/ensure', {
        method: 'POST',
        body: JSON.stringify({ tokenId }),
      })
    } catch {}

    await verify()
    setTimeout(() => {
      if (useAuthStore.getState().authorizedAddresses.includes(address?.toLowerCase() || '')) {
        markComplete('verify')
        goNext()
      }
    }, 500)
  }

  const step = STEPS[currentStep]
  const isComplete = completedSteps.has(step.id)

  const formatCount = (count: number) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
    return count.toString()
  }

  // ── Render ──

  const renderStepper = () => (
    <div className="flex items-center justify-center gap-2 mb-6">
      {STEPS.map((s, i) => {
        const done = completedSteps.has(s.id)
        const skipped = skippedSteps.has(s.id)
        const active = i === currentStep
        const canNavigate = i !== currentStep
        return (
          <button
            key={s.id}
            onClick={() => { if (canNavigate) { userNavigatedRef.current = true; setCurrentStep(i) } }}
            className={`flex-1 min-w-[80px] min-[800px]:min-w-0 flex flex-col items-center gap-2 transition-opacity duration-300 ${
              done && !active ? 'opacity-70' : 'opacity-100'
            } ${canNavigate ? 'cursor-pointer hover:opacity-100' : 'cursor-default'}`}
          >
            <div className={`w-full h-2 rounded-full transition-all duration-300 ${
              done ? 'bg-green-500'
              : skipped ? 'bg-yellow-500/40'
              : active ? 'bg-yellow-500'
              : 'bg-white/10'
            }`} />
            <div className="flex items-center gap-1 whitespace-nowrap">
              <span className={`transition-colors duration-300 ${
                done && active ? 'text-green-400'
                : done ? 'text-green-400'
                : active ? 'text-yellow-500'
                : skipped ? 'text-yellow-500/50'
                : 'text-white/30'
              }`}>
                {done ? <HiCheck className="w-4 h-4" /> : s.icon}
              </span>
              <span className={`text-sm font-medium transition-colors duration-300 ${
                done ? 'text-green-400'
                : active ? 'text-white'
                : skipped ? 'text-yellow-500/50'
                : 'text-white/30'
              }`}>
                {s.shortLabel ? (
                  <>
                    <span className="min-[800px]:hidden">{s.shortLabel}</span>
                    <span className="hidden min-[800px]:inline">{s.label}</span>
                  </>
                ) : s.label}
              </span>
            </div>
          </button>
        )
      })}
    </div>
  )

  return (
    <div className="fixed inset-0 z-[100] bg-black overflow-y-auto">
      <div className="min-h-full flex flex-col pb-[50px]">

        {/* Stepper — above columns on desktop, inline on mobile */}
        <div className="hidden min-[800px]:block w-full max-w-[840px] mx-auto px-6 pt-10 pb-2">
          {renderStepper()}
        </div>

        <div className={`flex-1 flex flex-col min-[800px]:flex-row min-[800px]:items-start min-[800px]:justify-center ${currentStep === 4 ? 'hidden' : ''}`}>

        {/* Left column — welcome + NFT */}
        <div className="flex items-center justify-center min-[800px]:sticky min-[800px]:top-16 min-[800px]:border-r min-[800px]:border-white/10">
        <div className="flex flex-col items-center px-6 py-4 w-full max-w-[400px]" style={{ paddingTop: 15 }}>
          <h1
            className="text-4xl min-[800px]:text-5xl mb-3"
            style={{
              fontFamily: 'Fraunces',
              color: '#ebc046',
              letterSpacing: '5px',
              textShadow: '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)',
            }}
          >
          </h1>
          <p className="text-gray-400 text-center text-sm min-[800px]:text-base mt-3 mb-1 max-w-sm">
            <b className="text-4xl text-white">Welcome
            </b>
            <br/>
          </p>
          <p className="text-gray-400 text-center text-sm min-[800px]:text-base max-w-sm">
            <p className="text-lg ">
              to the world's first permissionless<br/>social network
            </p>
            <br/>
          </p>
          <div className="w-48 h-48 min-[800px]:w-64 min-[800px]:h-64 ">
            <UsernameSvg username={username} />
          </div>
          {activeToken?.stakedAmount != null && activeToken.stakedAmount > 0n && (
            <p className="text-yellow-500 text-sm mt-2 font-medium">
              {Number(formatUnits(activeToken.stakedAmount, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })} CAW staked
            </p>
          )}
          <br/>
          <p className="text-gray-400 text-center text-xl min-[800px]:text-base mb-6 max-w-sm">
            You have successfully minted a new profile.
          </p>
          <p className="text-gray-400 text-center text-sm min-[800px]:text-base mt-3 max-w-sm">
            <b className="text-lg text-white">Your username is live</b><br/>follow the steps to finish setting up your account.
          </p>
          {/* Show stepper inline on mobile only */}
          <div className="w-full min-[800px]:hidden mt-4">
            {renderStepper()}
          </div>
        </div>
        </div>

        {/* Right column — step content */}
        <div className="flex items-start justify-center px-6 py-2 min-[800px]:py-8">
        <div className="w-full max-w-[400px]">

          <div className="space-y-6">

          {/* ── Step 1: Log In ── */}
          {currentStep === 0 && (
            <div className="space-y-6">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <div className="w-9 h-9" style={{ backgroundColor: '#eab308', maskImage: 'url(/icons/crow-2.svg)', maskSize: 'contain', maskRepeat: 'no-repeat', maskPosition: 'center', WebkitMaskImage: 'url(/icons/crow-2.svg)', WebkitMaskSize: 'contain', WebkitMaskRepeat: 'no-repeat', WebkitMaskPosition: 'center' }} />
                </div>
                <h2 className="text-2xl font-bold text-white">Log In to Your Profile</h2>
                <p className="text-gray-400 text-sm">
                  Sign a free message to verify you own this wallet.
                  This logs you into your new CAW profile so you can start using it right away.
                </p>
              </div>

              {isComplete ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-400">
                    <HiCheck className="w-5 h-5" />
                    <span className="font-medium">Logged in!</span>
                  </div>
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  {verifyError && (
                    <p className="text-red-400 text-sm text-center">{verifyError}</p>
                  )}
                  <button
                    onClick={() => !isConnected ? openConnectModal?.() : handleVerify()}
                    disabled={isVerifying}
                    className={`w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all ${isVerifying ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {!isConnected ? 'Connect Wallet' : isVerifying ? 'Signing...' : 'Sign to Log In'}
                  </button>
                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Stake CAW ── */}
          {currentStep === 1 && (
            <div className="space-y-6">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiOutlineCube className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className="text-2xl font-bold text-white">Stake CAW</h2>
                <p className="text-gray-400 text-sm">
                  Staking is required to interact on CAW. Every action on the protocol
                  generates fees that are distributed to stakers — the more you stake, the more you earn.
                </p>
              </div>

              <StakingRewardsInfo alwaysDark />

              {isComplete ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-400">
                    <HiCheck className="w-5 h-5" />
                    <span className="font-medium">CAW staked successfully!</span>
                  </div>
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : stakeTxSubmitted ? (
                <div className="text-center space-y-4">
                  {stakeConfirmed ? (
                    <div className="flex items-center justify-center gap-2 text-green-400">
                      <HiCheck className="w-5 h-5" />
                      <span className="font-medium">CAW staked successfully!</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-center gap-2 text-yellow-400">
                        <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span className="font-medium">Stake submitted — waiting for confirmation...</span>
                      </div>
                      {address && (
                        <LayerZeroStatus address={address} alwaysDark message="Your stake is being transferred cross-chain." />
                      )}
                    </div>
                  )}
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-gray-300">Amount to Stake</label>
                    {getPresetAmounts(availableBalance).length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {getPresetAmounts(availableBalance).map(preset => (
                          <button
                            key={preset}
                            onClick={() => setAmount(preset.toString())}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                              parseFloat(amount) === preset
                                ? 'bg-yellow-500 text-black'
                                : 'bg-white/10 text-white hover:bg-white/20'
                            }`}
                          >
                            {formatPresetLabel(preset)}
                          </button>
                        ))}
                      </div>
                    )}
                    <div className="relative">
                      <input
                        type="number"
                        placeholder="0.0"
                        value={amount}
                        onChange={(e) => setAmount(e.target.value)}
                        className="w-full px-4 py-3 pr-20 rounded-full border border-white/20 text-white bg-black focus:outline-none focus:ring-0"
                      />
                      <button
                        onClick={() => setAmount(availableBalance.toString())}
                        className="absolute right-4 top-1/2 -translate-y-1/2 px-3 py-1 text-xs font-semibold rounded-full bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 cursor-pointer"
                      >
                        MAX
                      </button>
                    </div>
                    <p className="text-xs text-gray-500 px-2">
                      Available: {availableBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
                    </p>
                  </div>

                  <button
                    onClick={handleStake}
                    disabled={
                      !isConnected ? false
                      : wrongChainForStake ? false
                      : !tokenId || (!isTokenOwner) || !amount || parseFloat(amount) === 0 || depositFee === 0n || isStakePending || isApprovePending
                    }
                    className={`w-full py-3 rounded-full font-bold transition-all ${
                      !isConnected || wrongChainForStake
                        ? 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
                        : isStakePending || isApprovePending
                          ? 'bg-yellow-600 text-black cursor-not-allowed'
                          : !amount || parseFloat(amount) === 0 || depositFee === 0n
                            ? 'bg-gray-700 text-gray-400 cursor-not-allowed'
                            : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
                    }`}
                  >
                    {!isConnected ? 'Connect Wallet'
                      : isApprovePending ? 'Approving...'
                      : isStakePending ? 'Staking...'
                      : wrongChainForStake ? 'Switch to L1 Network'
                      : needsApproval ? 'Approve & Stake'
                      : insufficientBalance ? 'Insufficient Balance'
                      : 'Stake CAW'}
                  </button>

                  <div className="text-center">
                    <a
                      href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors"
                    >
                      Need more CAW? Buy on Uniswap
                    </a>
                  </div>

                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Enable DMs ── */}
          {currentStep === 2 && (
            <div className="space-y-6">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiOutlineLockClosed className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className="text-2xl font-bold text-white">Enable Direct Messages</h2>
                <p className="text-gray-400 text-sm">
                  Sign once to generate your encryption keys.
                  All messages are end-to-end encrypted — only you and the recipient can read them.
                </p>
              </div>

              {(dmComplete || isComplete) ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-400">
                    <HiCheck className="w-5 h-5" />
                    <span className="font-medium">DMs enabled!</span>
                  </div>
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : !isConnected ? (
                <div className="space-y-3">
                  <button
                    onClick={() => openConnectModal?.()}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Connect Wallet
                  </button>
                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              ) : !isWalletAuthorized ? (
                <div className="space-y-3">
                  <div className="rounded-xl border border-yellow-700/50 bg-yellow-900/20 p-3 text-sm text-gray-300 text-center">
                    You need to log in before enabling DMs.
                  </div>
                  {verifyError && (
                    <p className="text-red-400 text-sm text-center">{verifyError}</p>
                  )}
                  <button
                    onClick={async () => {
                      try {
                        await apiFetch('/api/users/ensure', {
                          method: 'POST',
                          body: JSON.stringify({ tokenId }),
                        })
                      } catch {}
                      await verify()
                      setTimeout(() => {
                        if (useAuthStore.getState().authorizedAddresses.includes(address?.toLowerCase() || '')) {
                          markComplete('verify')
                        }
                      }, 500)
                    }}
                    disabled={isVerifying}
                    className={`w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all ${isVerifying ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {isVerifying ? 'Signing...' : 'Sign to Log In'}
                  </button>
                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              ) : (() => {
                const wrongDmWallet = address && activeToken?.address && address.toLowerCase() !== activeToken.address.toLowerCase()
                return (
                <div className="space-y-3">
                  {dmError && (
                    <p className="text-red-400 text-sm text-center">{dmError}</p>
                  )}
                  {wrongDmWallet ? (
                    <>
                      <button
                        disabled
                        className="w-full py-3 bg-white/10 text-gray-400 font-bold rounded-full cursor-not-allowed"
                      >
                        Wrong Wallet
                      </button>
                      <p className="text-red-400 text-sm text-center">Please switch to the correct wallet</p>
                    </>
                  ) : (
                    <button
                      onClick={handleEnableDms}
                      disabled={dmEnabling}
                      className={`w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all ${dmEnabling ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                    >
                      {dmEnabling ? 'Enabling...' : 'Sign to Enable DMs'}
                    </button>
                  )}
                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
                )
              })(
              )}
            </div>
          )}

          {/* ── Step 4: Quick Sign ── */}
          {currentStep === 3 && (
            <div className="space-y-2">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiLightningBolt className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className="text-2xl font-bold text-white">Enable Quick Sign</h2>
                <p className="text-gray-400 text-sm mb-6">
                  Creates a temporary key in your browser so you can post, like, and follow
                  without a wallet popup every time.
                </p>
                <p className="text-gray-400 text-md mt-4">
                  <strong className="text-gray-300">It cannot withdraw tokens or transfer your name</strong>.
                </p>
              </div>

              {(qsComplete || isComplete) ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-400">
                    <HiCheck className="w-5 h-5" />
                    <span className="font-medium">Quick Sign enabled!</span>
                  </div>
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : !isConnected ? (
                <div className="space-y-3">
                  <button
                    onClick={() => openConnectModal?.()}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Connect Wallet
                  </button>
                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  <QuickSignOptions
                    spendLimit={qsSpendLimit}
                    onSpendLimitChange={setQsSpendLimit}
                    duration={qsDuration}
                    onDurationChange={setQsDuration}
                  />

                  {qsError && (
                    <p className="text-red-400 text-sm text-center">{qsError}</p>
                  )}
                  <button
                    onClick={handleEnableQuickSign}
                    disabled={qsLoading}
                    className={`w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all ${qsLoading ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {qsLoading ? (qsStatus || 'Activating...') : 'Enable Quick Sign'}
                  </button>
                  <button
                    onClick={handleSkip}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              )}
            </div>
          )}

        </div>
        </div>
        </div>

        </div>

        {/* ── Step 5: Follow Users (full-width, no two-column) ── */}
        {currentStep === 4 && (() => {
          const stakedAmount = activeToken?.stakedAmount ?? 0n
          const MIN_STAKE_FOLLOW = 30000n * 10n**18n
          const hasEnoughStake = stakedAmount >= MIN_STAKE_FOLLOW
          const stakePending = stakeTxSubmitted && !stakeConfirmed && !hasEnoughStake
          const followDisabled = !hasEnoughStake

          return (
          <div className="flex-1 flex flex-col items-center px-6 py-8">
            <div className="w-full max-w-3xl space-y-6">
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiOutlineUserGroup className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className="text-2xl font-bold text-white">Follow Some Users</h2>
                <p className="text-gray-400 text-sm">
                  Follow some of the most active users to fill your feed.
                </p>
              </div>

              {/* Stake pending warning */}
              {stakePending && (
                <div className="flex items-center justify-center gap-3 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
                  <svg className="w-5 h-5 text-yellow-500 animate-spin flex-shrink-0" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  <p className="text-yellow-200 text-sm">
                    Your stake is still pending. Following requires 30K CAW — please wait a moment.
                  </p>
                </div>
              )}
              {/* Mobile stepper */}
              <div className="w-full min-[800px]:hidden">
                {renderStepper()}
              </div>

              {loadingUsers ? (
                <div className="flex flex-wrap justify-center gap-3">
                  {[...Array(8)].map((_, i) => (
                    <div key={i} className="animate-pulse rounded-xl p-4 bg-white/5 w-[calc(50%-6px)] sm:w-[calc(33.333%-8px)] md:w-[calc(25%-9px)]">
                      <div className="w-14 h-14 rounded-full bg-gray-700 mx-auto mb-3" />
                      <div className="h-4 bg-gray-700 rounded w-3/4 mx-auto mb-2" />
                      <div className="h-3 bg-gray-800 rounded w-1/2 mx-auto" />
                    </div>
                  ))}
                </div>
              ) : suggestedUsers.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-3">
                  {suggestedUsers.slice(0, 12).map(user => (
                    <div
                      key={user.tokenId}
                      className="rounded-xl p-4 bg-white/5 hover:bg-white/10 transition-colors w-[calc(50%-6px)] sm:w-[calc(33.333%-8px)] md:w-[calc(25%-9px)]"
                    >
                      <div className="text-center">
                        <div className="w-14 h-14 rounded-full mx-auto mb-2 overflow-hidden">
                          {(user.avatarUrl || user.image) ? (
                            <img
                              src={user.avatarUrl || user.image || ''}
                              alt={user.username}
                              className="w-full h-full object-cover"
                            />
                          ) : (
                            <img
                              src={cawLogo}
                              alt={user.username}
                              className="w-full h-full object-contain p-2"
                            />
                          )}
                        </div>
                        <p className="font-medium text-white text-sm truncate">
                          {user.displayName || user.username}
                        </p>
                        <p className="text-white/40 text-xs truncate">@{user.username}</p>
                        <p className="text-white/30 text-xs mt-1">
                          {formatCount(user.followerCount)} followers{user.likeCount > 0 ? ` · ${formatCount(user.likeCount)} likes` : ''}
                        </p>
                      </div>
                      <div className="mt-3 flex justify-center">
                        <FollowButton
                          targetUserId={user.tokenId}
                          initialIsFollowing={user.isFollowing}
                          initialIsPending={user.followPending}
                          size="small"
                          disabled={followDisabled}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center text-sm">No suggested users yet.</p>
              )}

              <div className="max-w-sm mx-auto">
                {!hasEnoughStake && !stakePending && (
                  <div className="flex items-center justify-center gap-3 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/30 w-fit mx-auto">
                    <p className="text-red-300 text-sm">
                      You will <button onClick={() => setCurrentStep(1)} className="underline text-yellow-500 hover:text-yellow-400 cursor-pointer">need to stake</button> at least 30K CAW to follow a user.
                    </p>
                  </div>
                )}
                <button
                  onClick={onComplete}
                  className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                >
                  Go to your feed <HiArrowRight className="w-4 h-4 inline ml-1" />
                </button>
                {suggestedUsers.length > 0 && (
                  <button
                    onClick={onComplete}
                    className="w-full py-2 text-white/40 hover:text-white/60 text-sm transition-colors cursor-pointer"
                  >
                    Skip for now
                  </button>
                )}
              </div>
            </div>
          </div>
          )
        })()}

      </div>

      {/* Floating feedback button */}
      <div className="fixed bottom-5 left-5 md:right-5 md:left-auto z-[101]">
      <Tooltip text="Feedback" position="top" forceDark>
        <button
          onClick={() => setShowBugReport(true)}
          className="w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 bg-zinc-800 hover:bg-zinc-700 text-white/70"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect width="8" height="14" x="8" y="6" rx="4" />
            <path d="M19 10C19 10 20 10 21 12" />
            <path d="M5 10C5 10 4 10 3 12" />
            <path d="M19 14C19 14 20 14 21 12" />
            <path d="M5 14C5 14 4 14 3 12" />
            <path d="M12 6V2" />
            <path d="M9 18L7 20" />
            <path d="M15 18L17 20" />
            <path d="M12 14V10" />
            <path d="M17 17H20" />
            <path d="M7 17H4" />
            <path d="M17 10H20" />
            <path d="M7 10H4" />
            <path d="M17 17H20" />
          </svg>
        </button>
      </Tooltip>
      </div>
      <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
    </div>
  )
}

export default PostMintOnboarding
