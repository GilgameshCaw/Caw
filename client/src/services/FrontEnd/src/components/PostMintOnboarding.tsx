import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import Tooltip from '~/components/Tooltip'
import { useAccount, useConnections, useSwitchChain, useReadContract } from 'wagmi'
import { ConnectButton, useConnectModal } from '@rainbow-me/rainbowkit'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { formatWalletError } from '~/utils/errorMessage'
import { maxUint256, parseUnits, formatUnits, erc20Abi } from 'viem'
import { useActiveToken, useTokenDataStore, usePriceStore } from '~/store/tokenDataStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { useAuthStore } from '~/store/authStore'
import { useDmClient } from '~/hooks/useDm'
import { useDmIdentity } from '~/hooks/useDmIdentity'
import { useCreateSession, getDefaultSpendLimit, getDefaultTipCeiling, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { getTipTiers } from '~/api/actions'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useInsufficientStakeStore } from '~/store/insufficientStakeStore'
import useAllowance from '~/hooks/useAllowance'
import useContractCall from '~/hooks/useContractCall'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { chains } from '~/config/chains'
import { handleError } from '~/utils'
import { apiFetch, retryOnIndexing } from '~/api/client'

const persistOnboardingStep = (username: string, step: number) => {
  apiFetch(`/api/users/onboarding/${username}`, {
    method: 'PATCH',
    body: JSON.stringify({ step }),
  }).catch(() => {})
}
import BugReportModal from '~/components/modals/BugReportModal'
import BugIcon from '~/components/icons/BugIcon'
import LayerZeroStatus from '~/components/LayerZeroStatus'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import QuickSignOptions from '~/components/QuickSignOptions'
import QuickSignHowItWorks from '~/components/QuickSignHowItWorks'
import { useTheme } from '~/hooks/useTheme'
import { HiInformationCircle } from 'react-icons/hi'
import { FollowButton } from '~/components/FollowButton'
import cawLogo from '~/assets/images/caw-logo.png'
import { getUserAvatar } from '~/utils/defaultAvatar'
import Avatar from '~/components/Avatar'
import BoidsBg from '~/components/BoidsBg'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import UsernameSvg from '~/components/UsernameSvg'
import ProfileEditForm from '~/components/ProfileEditForm'
import {
  HiOutlineCube,
  HiOutlineLockClosed,
  HiLightningBolt,
  HiOutlineUserGroup,
  HiOutlineUser,
  HiCheck,
  HiArrowRight,
} from 'react-icons/hi'
import { CLIENT_ID } from '~/api/actions'

interface SuggestedUser {
  tokenId: number
  username: string
  displayName: string | null
  avatarUrl: string | null
  image: string | null
  defaultAvatarId: number | null
  followerCount: number
  likeCount: number
  isFollowing: boolean
  followPending: boolean
}

type StepId = 'verify' | 'stake' | 'dms' | 'quicksign' | 'setup' | 'profile' | 'follow'

interface StepDef {
  id: StepId
  label: string
  shortLabel?: string
  icon: React.ReactNode
  skipWarning: string
}

const STEPS: StepDef[] = [
  { id: 'stake',   label: 'Deposit', icon: <HiOutlineCube className="w-5 h-5" />,      skipWarning: 'Deposited CAW is needed to post, like, and follow.' },
  { id: 'setup',   label: 'Set Up',  icon: <HiLightningBolt className="w-5 h-5" />,    skipWarning: 'You can set these up later in settings.' },
  { id: 'profile', label: 'Profile', icon: <HiOutlineUser className="w-5 h-5" />,      skipWarning: 'You can set up your profile later.' },
  { id: 'follow',  label: 'Follow',  icon: <HiOutlineUserGroup className="w-5 h-5" />, skipWarning: '' },
]

function CawPriceTicker({ isDark }: { isDark: boolean }) {
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  const formatAmount = (n: number): string => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toFixed(0)
  }

  const tickerClass = `mt-4 text-xs ${isDark ? 'text-white/30' : 'text-black/40'}`

  if (!cawPrice || cawPrice <= 0) {
    return <div className={tickerClass}>CAW price loading...</div>
  }

  const cawPerPenny = 0.01 / cawPrice

  return (
    <div className={tickerClass}>
      $0.01 ≈ {formatAmount(cawPerPenny)} CAW
    </div>
  )
}

interface PostMintOnboardingProps {
  username: string
  tokenId: number
  initialStep?: number
  pendingDeposit?: string | null  // wei amount as string, or null if no deposit
  onComplete: () => void
}

const PostMintOnboarding: React.FC<PostMintOnboardingProps> = ({ username, tokenId, initialStep = 0, pendingDeposit = null, onComplete }) => {
  const { isDark } = useTheme()
  // Theme class helpers — reused across the many cards, text styles, and
  // sub-step indicators in this component. Keeping them here avoids threading
  // `isDark` through every JSX node inline.
  const tc = {
    outerBg: isDark ? 'bg-black' : 'bg-white',
    card: isDark
      ? 'bg-white/[0.04] border border-white/10'
      : 'bg-black/[0.03] border border-black/10',
    cardMuted: isDark ? 'bg-[#0D0D0D]/85' : 'bg-black/[0.03]',
    cardMutedHover: isDark ? 'hover:bg-[#1A1A1A]/85' : 'hover:bg-black/[0.06]',
    cardBorderMuted: isDark ? 'border-[#1A1A1A]' : 'border-black/10',
    cardActiveBg: isDark ? 'bg-[#171202]/85' : 'bg-yellow-500/10',
    cardDoneBg: isDark ? 'bg-[#08140A]/85' : 'bg-green-500/10',
    textPrimary: isDark ? 'text-white' : 'text-black',
    textMuted: isDark ? 'text-gray-400' : 'text-gray-600',
    textSubtle: isDark ? 'text-gray-500' : 'text-gray-500',
    textFaint: isDark ? 'text-white/30' : 'text-black/40',
    textVeryFaint: isDark ? 'text-white/40' : 'text-black/50',
    textSemiFaint: isDark ? 'text-gray-300' : 'text-gray-700',
    inputBg: isDark ? 'bg-black text-white border-white/20' : 'bg-white text-black border-black/20',
    skipButton: isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600',
    stepperInactive: isDark ? 'bg-[#1A1A1A]/85' : 'bg-black/10',
    stepperSkipped: isDark ? 'bg-[#171202]/85' : 'bg-yellow-500/20',
    presetInactive: isDark
      ? 'bg-white/10 text-white hover:bg-white/20'
      : 'bg-black/10 text-black hover:bg-black/20',
    userCardBorder: isDark ? 'border-white/10' : 'border-black/10',
    avatarBorder: isDark ? 'border-white/20' : 'border-black/20',
  }
  const depositPending = !!pendingDeposit
  const pendingDepositAmount = pendingDeposit ? BigInt(pendingDeposit) : 0n
  const [currentStep, setCurrentStep] = useState(initialStep)
  const [completedSteps, setCompletedSteps] = useState<Set<StepId>>(new Set())
  const [skippedSteps, setSkippedSteps] = useState<Set<StepId>>(new Set())
  const userNavigatedRef = useRef(false)
  const [showBugReport, setShowBugReport] = useState(false)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
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
  const ensureWallet = useEnsureWallet()
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
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: 'depositQuote',
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [CLIENT_ID, tokenId ?? 0, parseUnits(amount || '0', 18), chains.l2.layerZero, false],
    query: { enabled: !!tokenId && !!amount && currentStep === 0 }
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

  const dollarPresets = [10, 25, 50, 100]

  const getDollarPresets = (): { usd: number; caw: number; affordable: boolean }[] => {
    if (!cawPrice || cawPrice <= 0) return []
    return dollarPresets.map(usd => {
      const caw = Math.round(usd / cawPrice)
      return { usd, caw, affordable: caw <= availableBalance }
    })
  }

  const formatCawAmount = (value: number): string => {
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`
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
      setIsStakePending(true)
      await stake.call()
    },
  })

  const stake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: 'deposit',
    args: [CLIENT_ID, tokenId || 0, parseUnits((amount || '0').toString(), 18), chains.l2.layerZero, 0n],
    disabled: !tokenId || !amount || depositFee === 0n || !isTokenOwner,
    value: depositFee,
    onPending: () => { setIsStakePending(true) },
    onSuccess: async (hash) => {
      const depositWei = parseUnits(amount || '0', 18)
      setIsStakePending(false)
      setStakeTxSubmitted(true)
      setAmount('')
      refetchTokenData?.()
      refetchBalance()
      // Write (or accumulate into) the pending-deposit hint. Sums with any
      // existing fresh hint so multiple in-flight deposits combine into a
      // single "+X CAW pending" budget. See Staking.tsx for full rationale.
      if (tokenId && depositWei > 0n) {
        try {
          const now = Date.now()
          let combinedAmount = depositWei
          // Ground-truth baseline from L2 (see Staking.tsx comment).
          const { readOnChainStakeForHint } = await import('~/api/actions')
          const onChainBaseline = await readOnChainStakeForHint(tokenId)
          let baselineStakedAtHintTime = onChainBaseline.toString()
          const existing = localStorage.getItem(`caw:pendingDeposit:${tokenId}`)
          if (existing) {
            try {
              const parsed = JSON.parse(existing) as { amount: string; at: number; stakedAtHintTime?: string }
              const age = now - (parsed?.at ?? 0)
              if (parsed?.amount && age < 30 * 60 * 1000) {
                combinedAmount = BigInt(parsed.amount) + depositWei
                if (parsed.stakedAtHintTime) baselineStakedAtHintTime = parsed.stakedAtHintTime
              }
            } catch { /* bad parse — treat as no existing */ }
          }
          localStorage.setItem(
            `caw:pendingDeposit:${tokenId}`,
            JSON.stringify({
              amount: combinedAmount.toString(),
              txHash: hash,
              at: now,
              stakedAtHintTime: baselineStakedAtHintTime,
            })
          )
          window.dispatchEvent(new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId } }))
        } catch {}
      }
      // Also persist to the DB so ProfileChooser's backend-side "+X CAW pending"
      // badge renders on other devices/sessions. The user already exists here,
      // so unlike the fresh-mint path in WelcomePage this PATCH will succeed.
      if (activeToken?.username) {
        try {
          await apiFetch(`/api/users/${activeToken.username}`, {
            method: 'PATCH',
            body: JSON.stringify({
              lastStakedAt: new Date().toISOString(),
              pendingDepositAmount: depositWei.toString(),
            })
          })
        } catch {}
      }
    },
    onError: (err) => { handleError(err, 'stake'); setIsStakePending(false) },
  })

  const handleStake = useCallback(async () => {
    await ensureWallet({ chainId: chains.l1.chainId }, async () => {
      // After wallet connect, balance/allowance queries may still be loading.
      // Wait briefly for them to settle before calling the contract.
      for (let attempt = 0; attempt < 10; attempt++) {
        try {
          setStakedAmountBefore(activeToken?.stakedAmount ?? 0n)
          if (needsApproval) {
            setIsApprovePending(true)
            await approve.call()
          } else {
            setIsStakePending(true)
            await stake.call()
          }
          return
        } catch (err: any) {
          if (err?.message?.includes('disabled') && attempt < 9) {
            await new Promise(r => setTimeout(r, 500))
            continue
          }
          setIsApprovePending(false)
          setIsStakePending(false)
          throw err
        }
      }
    })
  }, [needsApproval, approve, stake, ensureWallet, activeToken?.stakedAmount])

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
  const { initializeClient: initDm, isLoading: dmEnabling } = useDmClient(tokenId, username)
  // Mirror the pattern used for createSessionRef below — initDm is a useCallback
  // that closes over walletClient. If the user clicked "Set Up Account" with
  // a locked wallet, the captured initDm sees walletClient=undefined and throws
  // "Wallet not connected" even after connect completes. Route calls through a
  // ref so the deferred action always hits the freshest closure.
  const initDmRef = useRef(initDm)
  useEffect(() => { initDmRef.current = initDm }, [initDm])
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
      markComplete('verify')
    } catch (err) {
      setDmError(formatWalletError(err))
    }
  }

  // ── Step 4: Quick Sign ──
  const createSession = useCreateSession()
  // Keep a ref to the latest createSession so actions deferred by ensureWallet
  // (run after connect/chain-switch) invoke the freshest closure — the one
  // that sees isConnected=true. The closure captured at click time would
  // early-return because isConnected was still false.
  const createSessionRef = useRef(createSession)
  useEffect(() => { createSessionRef.current = createSession }, [createSession])
  const setSessionEnabled = useSessionKeyStore(s => s.setEnabled)
  const setHasSeenPrompt = useSessionKeyStore(s => s.setHasSeenPrompt)
  const [qsLoading, setQsLoading] = useState(false)
  const [qsStatus, setQsStatus] = useState('')
  const [qsError, setQsError] = useState<string | null>(null)
  const [qsComplete, setQsComplete] = useState(false)
  const onboardingCawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const qsDefaultLimit = getDefaultSpendLimit()
  const [qsSpendLimit, setQsSpendLimit] = useState<bigint>(qsDefaultLimit)
  const [qsDuration, setQsDuration] = useState<number>(DEFAULT_SESSION_DURATION)
  const [qsTipCeiling, setQsTipCeiling] = useState<bigint>(() => getDefaultTipCeiling(getTipTiers().fast))
  const [qsWalletProtect, setQsWalletProtect] = useState(false)
  const [showQsInfo, setShowQsInfo] = useState(false)

  const handleEnableQuickSign = async () => {
    setQsLoading(true)
    setQsError(null)
    try {
      setSessionEnabled(true)
      await createSession((s) => setQsStatus(s), qsSpendLimit, qsDuration, qsWalletProtect, qsTipCeiling)
      setHasSeenPrompt(true)
      setQsComplete(true)
      markComplete('quicksign')
    } catch (err: any) {
      console.error('[QuickSign] Onboarding activation failed:', err)
      const msg = err?.message || ''
      const isUserRejection = msg.includes('rejected') || msg.includes('denied') || msg.includes('cancelled') || err?.code === 4001
      setQsError(isUserRejection ? 'Signature was cancelled.' : (msg.includes('Please') || msg.includes('try again') ? msg : 'Something went wrong. Please try again.'))
      setSessionEnabled(false)
    } finally {
      setQsLoading(false)
      setQsStatus('')
    }
  }

  // ── Combined Setup step (DMs + Quick Sign sequentially) ──
  const hasActiveSession = useHasActiveSession()
  const [setupBusy, setSetupBusy] = useState(false)
  const [setupSubStep, setSetupSubStep] = useState<'idle' | 'dms' | 'quicksign' | 'done'>('idle')
  const [setupError, setSetupError] = useState<string | null>(null)
  // User can opt out of DM setup here. Treat that as "DM step done" for the
  // combined-setup loop (skip the signature) without ever calling initDm.
  // The Sidebar still nudges them to enable later if they change their mind.
  const [dmSkipped, setDmSkipped] = useState(false)

  // Track which sub-steps already succeeded (persists across retries)
  const setupDmDone = dmComplete || !!dmAlreadyEnabled || dmSkipped
  const setupQsDone = qsComplete || hasActiveSession

  const handleCombinedSetup = async () => {
    await ensureWallet(null, async () => {
    setSetupBusy(true)
    setSetupError(null)

    // Step 1: DMs (if not already done)
    if (!setupDmDone) {
      setSetupSubStep('dms')
      try {
        await initDmRef.current()
        setDmComplete(true)
        markComplete('dms')
        markComplete('verify')
      } catch (err: any) {
        const msg = err?.message || 'DM setup failed'
        if (msg.includes('rejected') || msg.includes('cancelled') || err?.code === 4001) {
          setSetupError('DM signature was rejected. Tap below to try again.')
        } else {
          setSetupError(msg)
        }
        setSetupBusy(false)
        setSetupSubStep('idle')
        return
      }
    }

    // Step 2: Quick Sign (if not already done)
    if (!setupQsDone) {
      setSetupSubStep('quicksign')
      setQsError(null)
      try {
        setSessionEnabled(true)
        await createSessionRef.current((s) => setQsStatus(s), qsSpendLimit, qsDuration, qsWalletProtect, qsTipCeiling)
        setHasSeenPrompt(true)
        setQsComplete(true)
        markComplete('quicksign')
      } catch (err: any) {
        const msg = err?.shortMessage || err?.message || 'Quick Sign failed'
        if (msg.includes('rejected') || msg.includes('cancelled') || err?.code === 4001) {
          setSetupError('Quick Sign signature was rejected. Tap below to try again.')
        } else {
          setSetupError(msg)
        }
        setSessionEnabled(false)
        setSetupBusy(false)
        setSetupSubStep('idle')
        return
      } finally {
        setQsStatus('')
      }
    }

    setSetupSubStep('done')
    markComplete('setup')
    setSetupBusy(false)
    })
  }

  // ── Step 3: Profile ──
  const [profileFormData, setProfileFormData] = useState<{
    displayName?: string | null
    bio?: string | null
    location?: string | null
    website?: string | null
    avatarUrl?: string | null
    coverPhotoUrl?: string | null
  } | null>(null)
  const fetchingProfileRef = useRef(false)

  useEffect(() => {
    if (currentStep === 2 && !profileFormData && !fetchingProfileRef.current) {
      fetchingProfileRef.current = true
      apiFetch<any>(`/api/users/by-token/${tokenId}`)
        .then(user => setProfileFormData({
          displayName: user?.displayName ?? null,
          bio: user?.bio ?? null,
          location: user?.location ?? null,
          website: user?.website ?? null,
          avatarUrl: user?.avatarUrl ?? null,
          coverPhotoUrl: user?.coverPhotoUrl ?? null,
        }))
        .catch(() => setProfileFormData({}))
        .finally(() => { fetchingProfileRef.current = false })
    }
  }, [currentStep, tokenId])

  // ── Step 5: Follow users ──
  const [suggestedUsers, setSuggestedUsers] = useState<SuggestedUser[]>([])
  const [loadingUsers, setLoadingUsers] = useState(false)
  const fetchingUsersRef = useRef(false)

  useEffect(() => {
    if (currentStep === 3 && suggestedUsers.length === 0 && !fetchingUsersRef.current) {
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
  // (hasActiveSession is declared earlier, near the combined setup step)
  const authorizedTokenIds = useAuthStore(s => s.authorizedTokenIds)

  useEffect(() => {
    const dmDone = dmComplete || !!dmAlreadyEnabled
    const qsDone = qsComplete || hasActiveSession
    const checks: Record<StepId, boolean> = {
      verify:    isProfileAuthorized,
      stake:     depositPending || stakeConfirmed || !!(activeToken?.stakedAmount && activeToken.stakedAmount > 0n),
      dms:       dmDone,
      quicksign: qsDone,
      setup:     dmDone && qsDone,
      profile:   false, // no persistent side effect to check
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
  }, [isProfileAuthorized, activeToken?.stakedAmount, dmAlreadyEnabled, dmComplete, hasActiveSession, qsComplete, stakeConfirmed, currentStep, depositPending])

  // Auto-advance past steps that are already completed (but not when user explicitly clicked a step)
  const isStakeComplete = depositPending || stakeConfirmed || !!(activeToken?.stakedAmount && activeToken.stakedAmount > 0n)
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
      setup: isDmsComplete && isQsComplete,
      profile: false,
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
  }, [isProfileAuthorized, isStakeComplete, isDmsComplete, isQsComplete, currentStep, depositPending])

  // If wallet is authorized but this specific tokenId isn't in the session yet,
  // silently refresh the session to pick up the new tokenId (no signature needed)
  useEffect(() => {
    if (isWalletAuthorized) {
      if (tokenId && !authorizedTokenIds.includes(tokenId)) {
        const refreshSession = async () => {
          // Ensure user record exists in DB first. After Tier 1, /ensure
          // returns 202 (no RPC fallback) until the indexer writes the row;
          // retryOnIndexing waits per the server's hint.
          try {
            await retryOnIndexing(() => apiFetch('/api/users/ensure', {
              method: 'POST',
              body: JSON.stringify({ tokenId }),
            }))
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
    // Ensure user record exists in DB before verifying (new mint may not be
    // indexed yet). retryOnIndexing handles the 202 -> backoff -> retry loop.
    try {
      await retryOnIndexing(() => apiFetch('/api/users/ensure', {
        method: 'POST',
        body: JSON.stringify({ tokenId }),
      }))
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
              : skipped ? tc.stepperSkipped
              : active ? 'bg-yellow-500'
              : tc.stepperInactive
            }`} />
            <div className="flex items-center gap-1 whitespace-nowrap">
              <span className={`transition-colors duration-300 ${
                done && active ? 'text-green-400'
                : done ? 'text-green-400'
                : active ? 'text-yellow-500'
                : skipped ? 'text-yellow-500/50'
                : tc.textFaint
              }`}>
                {done ? <HiCheck className="w-4 h-4" /> : s.icon}
              </span>
              <span className={`text-sm font-medium transition-colors duration-300 ${
                done ? 'text-green-400'
                : active ? tc.textPrimary
                : skipped ? 'text-yellow-500/50'
                : tc.textFaint
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
    <div className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${tc.outerBg}`}>
      <BoidsBg isDark={isDark} />
      {/* Language picker — top-right, visible across every onboarding
          step. Pre-mint visitors will have already chosen on the splash;
          this lets first-time users who land here directly still pick. */}
      <div className="absolute top-3 right-3 z-[110] w-44 sm:w-56">
        <LanguageSwitcher />
      </div>
      {/* Wallet pill — top-left, mirrors the splash. The onboarding
          overlay is fixed inset-0 with no other chrome, so without this
          a user who connected the wrong wallet (or wants to switch) has
          no way out. */}
      <div className="absolute top-3 left-3 z-[110]">
        <ConnectButton accountStatus="avatar" chainStatus="none" showBalance={false} />
      </div>
      <div className="min-h-full flex flex-col pb-[50px] relative z-[2]">

        {/* Stepper — above columns on desktop, inline on mobile */}
        <div className="hidden min-[800px]:block w-full max-w-[840px] mx-auto px-6 pt-10 pb-2">
          {renderStepper()}
        </div>

        <div className={`flex-1 flex flex-col min-[800px]:flex-row min-[800px]:items-start min-[800px]:justify-center ${currentStep === 3 ? 'hidden' : ''}`}>

        {/* Left column — welcome + NFT */}
        <div className="flex items-center justify-center min-[800px]:sticky min-[800px]:top-16">
        <div className={`flex flex-col items-center px-6 py-4 w-full max-w-[400px] rounded-2xl backdrop-blur-sm mb-5 ${tc.card}`} style={{ paddingTop: 15 }}>
          <h1
            className="text-4xl min-[800px]:text-5xl mb-3"
            style={{
              fontFamily: 'Inter, sans-serif',
              fontWeight: 800,
              color: '#ebc046',
              letterSpacing: '3px',
              textShadow: isDark
                ? '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)'
                : '0 1px 2px rgba(255, 255, 255, 0.6), 0 0 4px rgba(255, 255, 255, 0.3)',
            }}
          >
          </h1>
          <p className={`text-center text-sm min-[800px]:text-base mt-3 mb-1 max-w-sm ${tc.textMuted}`}>
            <b className={`text-4xl ${tc.textPrimary}`}>Welcome
            </b>
            <br/>
          </p>
          <div className={`text-center text-sm min-[800px]:text-base max-w-sm mb-[10px] ${tc.textMuted}`}>
            <p className="text-lg">
              to the world's first permissionless<br/>social network
            </p>
          </div>
          <div className="w-48 h-48 min-[800px]:w-64 min-[800px]:h-64 shadow-xl rounded-2xl overflow-hidden border border-yellow-500/30">
            <UsernameSvg username={username} />
          </div>
          {activeToken?.stakedAmount != null && activeToken.stakedAmount > 0n && (
            <p className="text-yellow-500 text-sm mt-2 font-medium">
              {Number(formatUnits(activeToken.stakedAmount, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })} CAW staked
            </p>
          )}
          <br/>
          <p className={`text-center text-sm min-[800px]:text-base max-w-sm ${tc.textMuted}`}>
            <b className={`text-lg ${tc.textPrimary}`}>Your username is live</b>
          </p>
          <p className={`text-center text-xl min-[800px]:text-base mt-2 max-w-sm ${tc.textMuted}`}>
            You have successfully created a new profile.
          </p>
          <p className={`text-center text-sm min-[800px]:text-base mt-2 max-w-sm ${tc.textMuted}`}>
            Follow the steps to finish setting up your account.
          </p>
          <CawPriceTicker isDark={isDark} />
          {/* Show stepper inline on mobile only */}
          <div className="w-full min-[800px]:hidden mt-4">
            {renderStepper()}
          </div>
        </div>
        </div>

        {/* Right column — step content */}
        <div className="flex items-start justify-center px-6">
        <div className="w-full max-w-[400px]">

          <div className="space-y-6">

          {/* ── Step 1: Stake CAW ── */}
          {currentStep === 0 && (
            <div className={`space-y-6 max-w-md mx-auto rounded-2xl py-6 px-[15px] backdrop-blur-sm ${tc.card}`}>
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiOutlineCube className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className={`text-2xl font-bold ${tc.textPrimary}`}>Deposit CAW</h2>
                <p className={`text-sm ${tc.textMuted}`}>
                  Depositing CAW is required to interact on the network. Every action on the protocol
                  generates fees that are distributed to depositors — the more you deposit, the more you earn.
                </p>
              </div>

              <StakingRewardsInfo isDark={isDark} />

              {depositPending ? (
                <div className="text-center space-y-4">
                  <div className="space-y-3">
                    <div className="flex items-center justify-center gap-2 text-yellow-400">
                      <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span className="font-medium">
                        {pendingDepositAmount > 0n
                          ? <>{Number(formatUnits(pendingDepositAmount, 18)).toLocaleString('en-US', { maximumFractionDigits: 0 })} CAW deposit<br/>waiting for confirmation...</>
                          : <>Deposit submitted<br/>waiting for confirmation...</>}
                      </span>
                    </div>
                    {address && (
                      <LayerZeroStatus address={address} isDark={isDark} message="This deposit is being broadcasted cross-chain and may take a few minutes to complete." />
                    )}
                  </div>
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : isComplete ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-400">
                    <HiCheck className="w-5 h-5" />
                    <span className="font-medium">CAW deposited successfully!</span>
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
                      <span className="font-medium">CAW deposited successfully!</span>
                    </div>
                  ) : (
                    <div className="space-y-3">
                      <div className="flex items-center justify-center gap-2 text-yellow-400">
                        <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        <span className="font-medium">Deposit submitted — waiting for confirmation...</span>
                      </div>
                      {address && (
                        <LayerZeroStatus address={address} isDark={isDark} message="This deposit is being broadcasted cross-chain and may take a few minutes to complete." />
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
                    <label className={`text-sm font-medium ${tc.textSemiFaint}`}>Amount to Deposit</label>
                    {getDollarPresets().length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {getDollarPresets().map(preset => (
                          <button
                            key={preset.usd}
                            onClick={() => setAmount(preset.caw.toString())}
                            className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${
                              parseFloat(amount) === preset.caw
                                ? 'bg-yellow-500 text-black'
                                : tc.presetInactive
                            }`}
                          >
                            ${preset.usd}
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
                        className={`w-full px-4 py-3 pr-20 rounded-full border focus:outline-none focus:ring-0 ${tc.inputBg}`}
                      />
                      <button
                        onClick={() => setAmount(availableBalance.toString())}
                        className="absolute right-4 top-1/2 -translate-y-1/2 px-3 py-1 text-xs font-semibold rounded-full bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30 cursor-pointer"
                      >
                        MAX
                      </button>
                    </div>
                    <div className={`flex justify-between text-xs px-2 ${tc.textSubtle}`}>
                      <span>Available: {availableBalance.toLocaleString('en-US', { maximumFractionDigits: 0 })} CAW</span>
                      {amount && parseFloat(amount) > 0 && cawPrice > 0 && (
                        <span>~${(parseFloat(amount) * cawPrice).toFixed(2)}</span>
                      )}
                    </div>
                  </div>

                  {isConnected && amount && parseFloat(amount) > 0 && insufficientBalance && (
                    <p className="text-sm text-red-400 text-center">
                      Not enough CAW in your wallet.{' '}
                      <a href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452" target="_blank" rel="noopener noreferrer" className="underline hover:text-red-300">Buy more on Uniswap</a>
                    </p>
                  )}

                  <button
                    onClick={handleStake}
                    disabled={isStakePending || isApprovePending || (isConnected && (!amount || parseFloat(amount) === 0))}
                    className={`w-full py-3 rounded-full font-bold transition-all ${
                      isStakePending || isApprovePending
                        ? 'bg-yellow-600 text-black cursor-not-allowed'
                        : isConnected && (!amount || parseFloat(amount) === 0)
                          ? (isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-200 text-gray-400 cursor-not-allowed')
                          : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
                    }`}
                  >
                    {!isConnected ? 'Deposit'
                      : isApprovePending ? 'Approving...'
                      : isStakePending ? 'Depositing...'
                      : needsApproval ? 'Approve & Deposit'
                      : 'Deposit CAW'}
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
                    className={`w-full py-2 text-sm transition-colors cursor-pointer ${tc.skipButton}`}
                  >
                    Skip — {step.skipWarning}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 2: Combined Setup (DMs + Quick Sign) ── */}
          {currentStep === 1 && (
            <div className={`space-y-6 max-w-md mx-auto rounded-2xl py-6 px-[15px] backdrop-blur-sm ${tc.card}`}>
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiLightningBolt className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className={`text-2xl font-bold ${tc.textPrimary}`}>Set Up Your Account</h2>
                <p className={`text-sm ${tc.textMuted}`}>
                  {dmSkipped
                    ? 'One quick signature to enable frictionless posting.'
                    : 'Two quick signatures to enable encrypted messaging and frictionless posting.'}
                </p>
              </div>

              {/* Sub-step progress indicators */}
              <div className="space-y-3">
                <div className={`flex items-center gap-3 p-3 rounded-xl border ${
                  // Skipped reads as "configured, but inactive" — neutral border, not green.
                  dmSkipped
                    ? `${tc.cardBorderMuted} ${tc.cardMuted}`
                    : setupDmDone
                    ? `border-green-500/30 ${tc.cardDoneBg}`
                    : setupSubStep === 'dms'
                    ? `border-yellow-500/30 ${tc.cardActiveBg}`
                    : `${tc.cardBorderMuted} ${tc.cardMuted}`
                }`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 transition-opacity ${
                    setupDmDone && !dmSkipped ? 'bg-green-500' : tc.stepperInactive
                  } ${dmSkipped ? 'opacity-40' : ''}`}>
                    {dmSkipped
                      ? <HiOutlineLockClosed className={`w-4 h-4 ${isDark ? 'text-white/50' : 'text-black/50'}`} />
                      : setupDmDone
                      ? <HiCheck className="w-4 h-4 text-white" />
                      : setupSubStep === 'dms'
                      ? <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                      : <HiOutlineLockClosed className={`w-4 h-4 ${isDark ? 'text-white/50' : 'text-black/50'}`} />
                    }
                  </div>
                  <div className={`flex-1 transition-opacity ${dmSkipped ? 'opacity-40' : ''}`}>
                    <p className={`text-sm font-medium ${setupDmDone && !dmSkipped ? 'text-green-400' : tc.textPrimary}`}>
                      Encrypted DMs & Login
                    </p>
                    <p className={`text-xs ${tc.textSubtle}`}>End-to-end encrypted messaging</p>
                  </div>
                  {/* Skip toggle — only meaningful before DMs are actually enabled.
                      Click once to opt out (label flips amber); click again to undo. */}
                  {!dmComplete && !dmAlreadyEnabled && (
                    <button
                      type="button"
                      onClick={() => setDmSkipped(v => !v)}
                      className={`text-xs px-2 py-1 rounded-md transition-colors cursor-pointer flex-shrink-0 ${
                        dmSkipped
                          ? 'text-amber-500 hover:text-amber-400'
                          : `${tc.textSubtle} hover:${isDark ? 'text-white/80' : 'text-black/80'}`
                      }`}
                      aria-label={dmSkipped ? 'Undo skip — enable DMs' : 'Skip DM setup'}
                    >
                      {dmSkipped ? 'Skipping' : 'Skip'}
                    </button>
                  )}
                </div>

                <div className={`p-3 rounded-xl border ${
                  setupQsDone
                    ? `border-green-500/30 ${tc.cardDoneBg}`
                    : setupSubStep === 'quicksign'
                    ? `border-yellow-500/30 ${tc.cardActiveBg}`
                    : `${tc.cardBorderMuted} ${tc.cardMuted}`
                }`}>
                  <div className="flex items-center gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                      setupQsDone ? 'bg-green-500' : tc.stepperInactive
                    }`}>
                      {setupQsDone
                        ? <HiCheck className="w-4 h-4 text-white" />
                        : setupSubStep === 'quicksign'
                        ? <div className="w-4 h-4 border-2 border-yellow-500 border-t-transparent rounded-full animate-spin" />
                        : <HiLightningBolt className={`w-4 h-4 ${isDark ? 'text-white/50' : 'text-black/50'}`} />
                      }
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-1.5">
                        <p className={`text-sm font-medium ${setupQsDone ? 'text-green-400' : tc.textPrimary}`}>
                          Quick Sign
                        </p>
                        <button
                          type="button"
                          onClick={() => setShowQsInfo(v => !v)}
                          className={`transition-colors cursor-pointer ${isDark ? 'text-white/40 hover:text-white/70' : 'text-black/40 hover:text-black/70'}`}
                          aria-label="Learn about Quick Sign"
                        >
                          <HiInformationCircle className="w-4 h-4" />
                        </button>
                      </div>
                      <p className={`text-xs ${tc.textSubtle}`}>Post and interact without wallet popups</p>
                    </div>
                  </div>
                  {showQsInfo && (
                    <div className="mt-3">
                      <QuickSignHowItWorks isDark={isDark} />
                    </div>
                  )}
                  {!setupQsDone && (
                    <div className="mt-3">
                      <QuickSignOptions
                        spendLimit={qsSpendLimit}
                        onSpendLimitChange={setQsSpendLimit}
                        duration={qsDuration}
                        onDurationChange={setQsDuration}
                        tipCeiling={qsTipCeiling}
                        onTipCeilingChange={setQsTipCeiling}
                        walletProtect={qsWalletProtect}
                        onWalletProtectChange={setQsWalletProtect}
                        isDark={isDark}
                      />
                    </div>
                  )}
                </div>
              </div>

              {(setupDmDone && setupQsDone) ? (
                <div className="text-center space-y-4">
                  <div className="flex items-center justify-center gap-2 text-green-400">
                    <HiCheck className="w-5 h-5" />
                    <span className="font-medium">All set!</span>
                  </div>
                  <button
                    onClick={goNext}
                    className="w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all cursor-pointer"
                  >
                    Continue <HiArrowRight className="w-4 h-4 inline ml-1" />
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {setupError && (
                    <p className="text-red-400 text-sm text-center">{setupError}</p>
                  )}

                  {isConnected && !isTokenOwner && (
                    <p className="text-yellow-400 text-sm text-center">
                      Wrong wallet — please switch to {activeToken?.owner?.slice(0, 6)}...{activeToken?.owner?.slice(-4)}
                    </p>
                  )}

                  <button
                    onClick={handleCombinedSetup}
                    disabled={setupBusy || (isConnected && !isTokenOwner)}
                    className={`w-full py-3 bg-yellow-500 hover:bg-yellow-600 text-black font-bold rounded-full transition-all ${setupBusy || (isConnected && !isTokenOwner) ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
                  >
                    {setupBusy
                      ? setupSubStep === 'dms' ? 'Sign DM key...' : setupSubStep === 'quicksign' ? (qsStatus || 'Sign Quick Sign...') : 'Setting up...'
                      : setupDmDone ? 'Sign to Enable Quick Sign'
                      : setupQsDone ? 'Sign to Enable DMs'
                      : `Set Up Account (${setupDmDone || setupQsDone ? '1' : '2'} signature${setupDmDone || setupQsDone ? '' : 's'})`}
                  </button>
                  <button onClick={handleSkip} className={`w-full py-2 text-sm transition-colors cursor-pointer ${tc.skipButton}`}>
                    Skip — {step.skipWarning}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Step 3: Set Up Profile ── */}
          {currentStep === 2 && (
            <div className={`space-y-4 max-w-md mx-auto rounded-2xl py-6 px-[15px] backdrop-blur-sm ${tc.card}`}>
              <div className="text-center space-y-2">
                <h2 className={`text-2xl font-bold ${tc.textPrimary}`}>Set Up Your Profile</h2>
              </div>

              <ProfileEditForm
                activeToken={activeToken as any}
                profileData={profileFormData}
                isDark={isDark}
                saveLabel="Save"
                onSaved={() => goNext()}
                onSkip={handleSkip}
                skipLabel={`Skip — ${step.skipWarning}`}
                scrollFieldsMaxHeight="max-h-[50vh]"
                compactFields
                hideAvatarCaption
                skipAsLink
              />
            </div>
          )}

        </div>
        </div>
        </div>

        </div>

        {/* ── Step 5: Follow Users (full-width, no two-column) ── */}
        {currentStep === 3 && (() => {
          const stakedAmount = activeToken?.stakedAmount ?? 0n
          const effectiveStake = stakedAmount + (depositPending ? pendingDepositAmount : 0n)
          const MIN_STAKE_FOLLOW = 30000n * 10n**18n
          const hasEnoughStake = effectiveStake >= MIN_STAKE_FOLLOW || stakeConfirmed
          const stakePending = stakeTxSubmitted && !stakeConfirmed && effectiveStake < MIN_STAKE_FOLLOW
          const followDisabled = !hasEnoughStake

          return (
          <div className="flex-1 flex flex-col items-center px-6 pb-8">
            <div className={`w-full max-w-3xl space-y-6 rounded-2xl py-6 px-[15px] backdrop-blur-sm ${tc.card}`}>
              <div className="text-center space-y-3">
                <div className="w-16 h-16 rounded-full bg-yellow-500/20 flex items-center justify-center mx-auto">
                  <HiOutlineUserGroup className="w-8 h-8 text-yellow-500" />
                </div>
                <h2 className={`text-2xl font-bold ${tc.textPrimary}`}>Follow Some Users</h2>
                <p className={`text-sm ${tc.textMuted}`}>
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
                    <div key={i} className={`animate-pulse rounded-xl p-4 w-[calc(50%-6px)] sm:w-[calc(33.333%-8px)] md:w-[calc(25%-9px)] ${tc.cardMuted}`}>
                      <div className={`w-14 h-14 rounded-full mx-auto mb-3 ${isDark ? 'bg-gray-700' : 'bg-gray-300'}`} />
                      <div className={`h-4 rounded w-3/4 mx-auto mb-2 ${isDark ? 'bg-gray-700' : 'bg-gray-300'}`} />
                      <div className={`h-3 rounded w-1/2 mx-auto ${isDark ? 'bg-gray-800' : 'bg-gray-200'}`} />
                    </div>
                  ))}
                </div>
              ) : suggestedUsers.length > 0 ? (
                <div className="flex flex-wrap justify-center gap-3">
                  {suggestedUsers.slice(0, 8).map(user => (
                    <div
                      key={user.tokenId}
                      className={`rounded-xl p-4 border transition-colors w-[calc(50%-6px)] sm:w-[calc(33.333%-8px)] md:w-[calc(25%-9px)] ${tc.cardMuted} ${tc.cardMutedHover} ${tc.userCardBorder}`}
                    >
                      <a href={`/users/${user.username}`} onClick={(e) => { e.preventDefault(); onComplete?.(); window.location.href = `/users/${user.username}` }} className="block text-center cursor-pointer">
                        <div className={`w-14 h-14 rounded-full mx-auto mb-2 overflow-hidden border ${tc.avatarBorder}`}>
                          <Avatar
                            src={getUserAvatar(user)}
                            alt={user.username}
                            className="w-full h-full"
                            size="small"
                          />
                        </div>
                        <p className={`font-medium text-sm truncate ${tc.textPrimary}`}>
                          {user.displayName || user.username}
                        </p>
                        <p className={`text-xs truncate ${tc.textVeryFaint}`}>@{user.username}</p>
                        <p className={`text-xs mt-1 ${tc.textFaint}`}>
                          {formatCount(user.followerCount)} followers{user.likeCount > 0 ? ` · ${formatCount(user.likeCount)} likes` : ''}
                        </p>
                      </a>
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
                <p className={`text-center text-sm ${tc.textSubtle}`}>No suggested users yet.</p>
              )}

              <div className="max-w-sm mx-auto">
                {!hasEnoughStake && !stakePending && (
                  <div className="flex items-center justify-center gap-3 p-3 mb-3 rounded-lg bg-red-500/10 border border-red-500/30 w-fit mx-auto">
                    <p className="text-red-300 text-sm text-center">
                      You will <button onClick={() => { userNavigatedRef.current = true; setCurrentStep(0) }} className="underline cursor-pointer">need to stake</button> at least<br/>30K CAW to follow a user.
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
                    className={`w-full py-2 text-sm transition-colors cursor-pointer ${tc.skipButton}`}
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
          className={`w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 ${isDark ? 'bg-zinc-800 hover:bg-zinc-700 text-white/70' : 'bg-zinc-200 hover:bg-zinc-300 text-black/70'}`}
        >
          <BugIcon />
        </button>
      </Tooltip>
      </div>
      <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
    </div>
  )
}

export default PostMintOnboarding
