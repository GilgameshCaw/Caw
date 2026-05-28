// src/services/FrontEnd/src/components/CawStakingForm.tsx
import React, { useEffect, useState, useCallback, useMemo } from "react"
import { useSignAndSubmitAction, getValidatorTip } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { useSearchParams, useLocation } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import { CgExternal } from "react-icons/cg"
import { FormHeader } from "~/components/forms/FormHeader"
import { SubmitButton } from "~/components/buttons/SubmitButton"
import { Input } from "~/components/Input"
import { GasPriceLine } from "~/components/GasPriceLine"
import { TokenData } from "~/types";
import { handleError, convertToText, formatUnitsCompact } from "~/utils";
import useContractCall from "~/hooks/useContractCall";
import useAllowance from "~/hooks/useAllowance";
import { useAccount, useConnections, useReadContract, useSwitchChain, useChainId } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { useActiveToken, useTokenDataStore, usePriceStore } from "~/store/tokenDataStore"
import { cawProfileAbi, cawProfileL2Abi, cawProfileQuoterAbi, cawProfileMinterAbi } from "~/../../../abi/generated"
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_L2_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_NAMES_MINTER_ADDRESS, CAW_PAIR_ADDRESS } from "~/../../../abi/addresses"
import { maxUint256, parseUnits, parseEther, formatUnits, formatEther, erc20Abi } from "viem";
import { usePoolReserves, useMinCawOut, suggestedSlippageBps } from '~/hooks/useZapQuote'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineTrendingUp, HiOutlineTrendingDown, HiOutlineInformationCircle, HiQuestionMarkCircle } from 'react-icons/hi'
import Tooltip from '~/components/Tooltip'
import { UserAvatar } from '~/components/Avatar'
import QuickSignModal from '~/components/modals/QuickSignModal'
import LayerZeroStatus from '~/components/LayerZeroStatus'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useEnsureWallet } from '~/hooks/useEnsureWallet'
import { CLIENT_ID } from '~/api/actions'
import { useT } from '~/i18n/I18nProvider'
import NetworkFeesPanel from '~/components/NetworkFeesPanel'
import NetworkFeeModal from '~/components/NetworkFeeModal'
import { useNetworkFees } from '~/hooks/useNetworkFees'
import { HiInformationCircle } from 'react-icons/hi'

type StakingTab = 'stake' | 'unstake' | 'info'

interface WithdrawalRequest {
  id: number
  userId: number
  amount: string
  status: string
  cawonce: number
  createdAt: string
  updatedAt: string
  completedAt?: string
}

const Staking = () => {
  const t = useT()
  const { isDark } = useTheme()
  const ensureWallet = useEnsureWallet()
  const navigate = useNavigate()
  const location = useLocation()

  // Determine active tab from URL
  const getActiveTabFromPath = (): StakingTab => {
    if (location.pathname === '/staking/unstake') return 'unstake'
    if (location.pathname === '/staking/info') return 'info'
    return 'stake'
  }

  const [activeTab, setActiveTab] = useState<StakingTab>(getActiveTabFromPath())
  const [amount, setAmount] = useState<string>("")
  const [depositFee, setDepositFee] = useState<bigint>(0n)
  const [withdrawFee, setWithdrawFee] = useState<bigint>(0n)
  const [showFeeModal, setShowFeeModal] = useState(false)
  const networkFees = useNetworkFees(CLIENT_ID)
  // Pay-with-ETH (ZAP) — contract swaps ETH→CAW via Uniswap V2 then deposits.
  const [paymentMode, setPaymentMode] = useState<'caw' | 'eth'>('caw')
  const [ethAmount, setEthAmount] = useState<string>("")
  const [slippageBps, setSlippageBps] = useState<number>(200)
  const [slippageAutoSet, setSlippageAutoSet] = useState(false)
  const [pendingWithdrawals, setPendingWithdrawals] = useState<WithdrawalRequest[]>([])
  const [allWithdrawals, setAllWithdrawals] = useState<WithdrawalRequest[]>([])
  const [loadingWithdrawals, setLoadingWithdrawals] = useState(false)
  const [isSwitchingNetwork, setIsSwitchingNetwork] = useState(false)
  const [isWithdrawPending, setIsWithdrawPending] = useState(false)
  const [recentStakeTime, setRecentStakeTime] = useState<number | null>(() => {
    // Check localStorage on mount for persisted stake time
    const stored = localStorage.getItem('lastStakeTime')
    if (stored) {
      const time = parseInt(stored, 10)
      const fiveMinutesAgo = Date.now() - (5 * 60 * 1000)
      if (time > fiveMinutesAgo) {
        return time
      }
      // Clean up old value
      localStorage.removeItem('lastStakeTime')
    }
    return null
  })
  const [isStakePending, setIsStakePending] = useState(false)
  const [isApprovePending, setIsApprovePending] = useState(false)
  const [lastStakedAt, setLastStakedAt] = useState<Date | null>(null)
  const [activeProfile, setActiveProfile] = useState<any>(null)
  const [showQuickSignModal, setShowQuickSignModal] = useState(false)
  const hasSeenPrompt = useSessionKeyStore(s => s.hasSeenPrompt)
  const sessionEnabled = useSessionKeyStore(s => s.enabled)
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const { switchChain } = useSwitchChain()
  const { openConnectModal } = useConnectModal()
  const connections = useConnections()
  const signAndSubmit = useSignAndSubmitAction()

  const wrongChainForStake = connections[0]?.chainId !== chains.l1.chainId
  const wrongChainForUnstake = connections[0]?.chainId !== chains.l1.chainId
  const isMainnet = connections[0]?.chainId === chains.l1.chainId

  // Check if connected wallet owns the active token
  const isTokenOwner = activeToken?.owner?.toLowerCase() === address?.toLowerCase()

  console.log('[Staking] Current chainId:', chainId, 'Expected L1 chainId:', chains.l1.chainId)
  console.log('[Staking] Token owner check:', {
    tokenOwner: activeToken?.owner,
    connectedAddress: address,
    isTokenOwner
  })

  // Get allowance for staking
  const { allowance, refetch: refetchAllowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_ADDRESS)
  const refetchTokenData = useTokenDataStore(s => s.refetchTokenData)

  // Get wallet balance
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    chainId: chains.l1.chainId,
    functionName: "balanceOf",
    args: [address!],
    query: {
      enabled: !!tokenId && !!address
    }
  })

  // Get deposit quote from CawProfileQuoter
  const { data: depositQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "depositQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [CLIENT_ID, tokenId ?? 0, parseUnits(amount || "0", 18), chains.l2.layerZero, false],
    query: {
      enabled: !!tokenId && !!amount && activeTab === 'stake' && paymentMode === 'caw'
    }
  })

  // ZAP deposit quote — same on-chain LZ + storage fees as the CAW path.
  const { data: depositZapQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "depositZapQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [CLIENT_ID, tokenId ?? 0, chains.l2.layerZero, false],
    query: {
      enabled: !!tokenId && activeTab === 'stake' && paymentMode === 'eth'
    }
  })

  // ETH input + slippage math
  const ethAmountWei = useMemo(() => {
    if (paymentMode !== 'eth' || !ethAmount) return 0n
    try { return parseEther(ethAmount) } catch { return 0n }
  }, [paymentMode, ethAmount])
  const reserves = usePoolReserves(CAW_PAIR_ADDRESS as `0x${string}`, chains.l1.chainId)
  useEffect(() => {
    if (slippageAutoSet || ethAmountWei === 0n || !reserves.loaded) return
    setSlippageBps(suggestedSlippageBps(ethAmountWei, reserves.wethReserve))
    setSlippageAutoSet(true)
  }, [slippageAutoSet, ethAmountWei, reserves.loaded, reserves.wethReserve])
  const zapQuote = useMinCawOut(ethAmountWei, reserves, slippageBps)

  // Get withdraw quote from CawProfileQuoter
  const { data: withdrawQuote } = useReadContract({
    address: CAW_NAME_QUOTER_ADDRESS,
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "withdrawQuote",
    args: [CLIENT_ID, false],
    query: {
      enabled: !!tokenId && activeTab === 'unstake'
    }
  })

  // Update fees when quotes change. depositFee tracks the *current-mode* native
  // fee — CAW-mode uses depositQuote, ETH-mode uses depositZapQuote.
  useEffect(() => {
    if (paymentMode === 'caw' && depositQuote?.nativeFee != null) setDepositFee(BigInt(depositQuote.nativeFee))
  }, [paymentMode, depositQuote])
  useEffect(() => {
    if (paymentMode === 'eth' && depositZapQuote?.nativeFee != null) setDepositFee(BigInt(depositZapQuote.nativeFee))
  }, [paymentMode, depositZapQuote])

  useEffect(() => {
    if (withdrawQuote?.nativeFee != null) setWithdrawFee(BigInt(withdrawQuote.nativeFee))
  }, [withdrawQuote])

  // Fetch lastStakedAt timestamp from user profile
  useEffect(() => {
    const fetchLastStakedAt = async () => {
      if (!activeToken?.username) return

      try {
        const data = await apiFetch(`/api/users/${activeToken.username}`)

        if (data.lastStakedAt) {
          setLastStakedAt(new Date(data.lastStakedAt))
        }
        setActiveProfile(data)
      } catch (err) {
        console.error('[Staking] Failed to fetch lastStakedAt:', err)
      }
    }

    fetchLastStakedAt()
  }, [activeToken?.username])

  // Fetch all withdrawals (pending and recently completed)
  const fetchPendingWithdrawals = useCallback(async () => {
    if (!tokenId) return

    setLoadingWithdrawals(true)
    try {
      console.log('[Staking] Fetching withdrawal requests for user', tokenId)
      const data = await apiFetch(`/api/withdrawals/${tokenId}`)

      if (data.success && data.withdrawals) {
        console.log('[Staking] Fetched withdrawal requests:', data.withdrawals)
        // Store all withdrawals for LayerZero message check
        setAllWithdrawals(data.withdrawals)
        // Filter to show pending and recently completed (within last 10 seconds)
        const now = Date.now()
        const filtered = data.withdrawals.filter((w: WithdrawalRequest & { txQueueStatus?: string | null }) => {
          // Treat a failed underlying TxQueue as an immediately-failed withdrawal,
          // even if WithdrawalRequest.status lags behind. Prevents "stuck pending"
          // rows from showing up after the action was rejected (e.g. insufficient
          // CAW balance when the validator tip pushes the request over the stake).
          if (w.txQueueStatus === 'failed') return false
          if (w.status === 'pending') return true
          if (w.status === 'completed' && w.completedAt) {
            const completedTime = new Date(w.completedAt).getTime()
            return (now - completedTime) < 10000 // Show completed for 10 seconds
          }
          return false
        })
        setPendingWithdrawals(filtered)
      } else {
        console.error('[Staking] Failed to fetch withdrawals:', data)
        setPendingWithdrawals([])
      }
    } catch (err) {
      console.error('[Staking] Error fetching withdrawal requests:', err)
      setPendingWithdrawals([])
    } finally {
      setLoadingWithdrawals(false)
    }
  }, [tokenId])

  // Fetch pending withdrawals on mount and when tokenId changes
  useEffect(() => {
    fetchPendingWithdrawals()
  }, [fetchPendingWithdrawals])

  // Poll for withdrawal updates when on unstake tab
  useEffect(() => {
    if (activeTab !== 'unstake') return

    const interval = setInterval(() => {
      fetchPendingWithdrawals()
    }, 5000) // Poll every 5 seconds

    return () => clearInterval(interval)
  }, [activeTab, fetchPendingWithdrawals])

  // Clear switching state when chain changes
  useEffect(() => {
    if (isSwitchingNetwork) {
      console.log('[Staking] Chain changed, clearing switching state')
      setIsSwitchingNetwork(false)
    }
  }, [chainId])

  // Update active tab when URL changes
  useEffect(() => {
    setActiveTab(getActiveTabFromPath())
  }, [location.pathname])

  // Poll for updated balances after a recent stake (cross-chain via LayerZero takes time)
  useEffect(() => {
    if (!recentStakeTime) return

    const fiveMinutesMs = 5 * 60 * 1000
    const elapsed = Date.now() - recentStakeTime
    if (elapsed >= fiveMinutesMs) return

    const interval = setInterval(() => {
      const now = Date.now()
      if (now - recentStakeTime >= fiveMinutesMs) {
        // Stop polling after 5 minutes
        setRecentStakeTime(null)
        localStorage.removeItem('lastStakeTime')
        clearInterval(interval)
        return
      }
      refetchTokenData?.()
      refetchBalance()
    }, 10_000) // Poll every 10 seconds

    return () => clearInterval(interval)
  }, [recentStakeTime, refetchTokenData, refetchBalance])

  // Poll L1 token data after a recent completed withdrawal: the L2 side is done
  // but the LayerZero message hasn't landed on L1 yet, so `withdrawable` stays 0
  // until we refetch. Without this the "Complete Withdrawal" button never appears
  // until the user reloads the page.
  const hasRecentCompletedWithdrawal = (() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000
    return allWithdrawals.some((w: WithdrawalRequest) =>
      w.status === 'completed' && w.updatedAt && new Date(w.updatedAt).getTime() > oneHourAgo
    )
  })()
  useEffect(() => {
    if (!hasRecentCompletedWithdrawal) return
    const interval = setInterval(() => {
      refetchTokenData?.()
    }, 15_000)
    return () => clearInterval(interval)
  }, [hasRecentCompletedWithdrawal, refetchTokenData])

  // Only consider balance "insufficient" when we actually know it. Pre-connect
  // (or pre-load) `balance` is undefined — surfacing that as "Insufficient
  // Balance" on the button makes the staking page look broken before the user
  // has even connected. Treat unknown as not-insufficient so the button shows
  // the normal label and clicking enters the connect flow.
  const insufficientBalance = balance !== undefined && parseUnits(amount || "0", 18) > balance
  const needsApproval = !allowance || parseUnits(amount || "0", 18) > allowance

  // Dollar-based preset buttons, converted to CAW at current price
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const DOLLAR_PRESETS = [10, 25, 50, 100]
  const dollarToCaw = (dollars: number) => cawPrice > 0 ? Math.round(dollars / cawPrice) : 0

  // Legacy helpers kept for compatibility
  const getPresetAmounts = (_maxBalance: number): number[] => DOLLAR_PRESETS.map(dollarToCaw).filter(v => v > 0)
  const formatPresetLabel = (value: number): string => {
    const dollarIdx = DOLLAR_PRESETS.findIndex(d => dollarToCaw(d) === value)
    if (dollarIdx >= 0) return `$${DOLLAR_PRESETS[dollarIdx]}`
    if (value >= 1_000_000_000_000) return `${value / 1_000_000_000_000}T`
    if (value >= 1_000_000_000) return `${value / 1_000_000_000}B`
    if (value >= 1_000_000) return `${value / 1_000_000}M`
    if (value >= 1_000) return `${value / 1_000}K`
    return value.toString()
  }

  // Use real data from activeToken if available
  const mockData = useMemo(() => {
    if (!activeToken) {
      return {
        stakedAmount: 0,
        maxWithdrawAmount: 0,
        withdrawable: 0,
        walletBalance: 0,
        actions: 0,
        availableBalance: 0,
        username: 'Not Connected',
        tokenId: 0
      }
    }

    console.log('Active token data:', {
      stakedAmount: activeToken.stakedAmount,
      withdrawable: activeToken.withdrawable,
      ownerBalance: activeToken.ownerBalance,
      cawonce: activeToken.cawonce
    })

    // Convert bigint to number using formatUnits directly
    const stakedAmount = activeToken.stakedAmount ? Number(formatUnits(activeToken.stakedAmount, 18)) : 0
    const withdrawable = activeToken.withdrawable ? Number(formatUnits(activeToken.withdrawable, 18)) : 0
    const walletBalance = activeToken.ownerBalance ? Number(formatUnits(activeToken.ownerBalance, 18)) : 0

    // The validator tip (whole CAW) is added to the withdraw action amount on-chain,
    // so the maximum withdrawable in one unstake request is stakedAmount - tip, floored.
    const validatorTipCaw = Number(getValidatorTip())
    const maxWithdrawAmount = Math.max(0, Math.floor(stakedAmount - validatorTipCaw))

    return {
      stakedAmount,
      maxWithdrawAmount,
      withdrawable,
      walletBalance,
      actions: activeToken.cawonce || 0, // Using cawonce as action count
      availableBalance: walletBalance,
      username: activeToken.username,
      tokenId: activeToken.tokenId
    }
  }, [activeToken])

  // Approve CAW tokens for staking
  const approve = useContractCall({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CAW_NAMES_ADDRESS, maxUint256],
    disabled: !amount || insufficientBalance || !isTokenOwner,
    onError: (err) => {
      handleError(err, "approve")
      setIsApprovePending(false)
    },
    onPending: () => {
      setIsApprovePending(true)
    },
    onSuccess: async () => {
      console.log('[Staking] Approval successful, automatically triggering stake')
      setIsApprovePending(false)
      refetchAllowance()
      // Wait a brief moment for the approval to be confirmed
      await new Promise(resolve => setTimeout(resolve, 500))
      // Automatically call stake after approval
      setIsStakePending(true)
      await stake.call()
    },
  })

  // Deposit/Stake CAW
  const stake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: "deposit",
    args: [CLIENT_ID, tokenId || 0, parseUnits((amount || "0").toString(), 18), chains.l2.layerZero, 0n],
    disabled: !tokenId || !amount || depositFee === 0n || !isTokenOwner,
    value: depositFee,
    onPending: () => {
      setIsStakePending(true)
    },
    onSuccess: async (hash) => {
      console.log('[Staking] Stake successful:', hash)
      const depositWei = parseUnits(amount || '0', 18)
      setAmount("")
      const now = Date.now()
      setRecentStakeTime(now)
      // Persist to localStorage so it survives page refresh
      localStorage.setItem('lastStakeTime', now.toString())
      // Write (or accumulate into) the pending-deposit hint with the L1 tx
      // hash so actions.ts forwards it to /api/actions and the validator
      // holds follow/like actions until the L1→L2 LayerZero message lands.
      // If a prior pending deposit hint already exists for this token,
      // ADD this deposit's amount to it — two in-flight deposits should
      // show as a single combined "+X CAW pending" budget until the first
      // one lands. We keep the latest txHash so waiting actions at least
      // have a valid proof to forward (any landed deposit unlocks the hold).
      if (tokenId && depositWei > 0n) {
        try {
          let combinedAmount = depositWei
          // Read the baseline directly from L2 on-chain (cawBalanceOf), not
          // from the wagmi store. The store can be stale and would produce
          // a baseline that doesn't match reality — the clearing rule in
          // ProfileChooser would then fire incorrectly once wagmi caught up.
          // Ground truth from L2 ensures "hint cleared" means "a new deposit
          // of ~hintWei actually landed, measured from real state."
          const { readOnChainStakeForHint } = await import('~/api/actions')
          const onChainBaseline = await readOnChainStakeForHint(tokenId)
          let baselineStakedAtHintTime = onChainBaseline.toString()
          const existing = localStorage.getItem(`caw:pendingDeposit:${tokenId}`)
          if (existing) {
            try {
              const parsed = JSON.parse(existing) as { amount: string; at: number; stakedAtHintTime?: string }
              const age = now - (parsed?.at ?? 0)
              // Only accumulate if the existing hint is still fresh (<30 min);
              // otherwise treat it as stale and replace.
              if (parsed?.amount && age < 30 * 60 * 1000) {
                combinedAmount = BigInt(parsed.amount) + depositWei
                // Preserve the original stake baseline across accumulations —
                // ProfileChooser compares the *current* stake against this
                // baseline to detect when the deposit lands, and it shouldn't
                // reset just because the user did a second deposit mid-wait.
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
          // Notify same-tab listeners (ProfileChooser) so the badge updates
          // immediately without waiting for the 15s poll tick.
          window.dispatchEvent(new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId } }))
        } catch {}
      }
      setIsStakePending(false)
      // Refetch on-chain data to reflect updated balances
      refetchTokenData?.()
      refetchBalance()

      // Also record stake timestamp in database for persistent LayerZero status check
      if (activeToken?.username) {
        try {
          await apiFetch(`/api/users/${activeToken.username}`, {
            method: 'PATCH',
            body: JSON.stringify({
              lastStakedAt: new Date().toISOString(),
              pendingDepositAmount: parseUnits(amount || '0', 18).toString(),
            })
          })
        } catch (err) {
          console.error('[Staking] Failed to record stake timestamp:', err)
        }
      }

      // Prompt user to enable Quick Sign after staking
      if (!hasSeenPrompt && !sessionEnabled) {
        setShowQuickSignModal(true)
      }
    },
    onError: (err) => {
      handleError(err, "stake")
      setIsStakePending(false)
    },
  })

  // ZAP deposit (pay-with-ETH). msg.value = ethAmount (swap input) + LZ/storage
  // fees. The contract swaps ETH→CAW via Uniswap V2, then calls depositFor on
  // CawProfile with the swap output. Slippage is enforced by minCawOut.
  const depositZap = useContractCall({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    functionName: "depositZap",
    args: [CLIENT_ID, tokenId || 0, ethAmountWei, zapQuote.minCawOut, chains.l2.layerZero, 0n],
    disabled: paymentMode !== 'eth' || !tokenId || ethAmountWei === 0n || !zapQuote.loaded || depositFee === 0n || !isTokenOwner,
    value: ethAmountWei + depositFee,
    onPending: () => setIsStakePending(true),
    onSuccess: async (hash) => {
      console.log('[Staking] depositZap success:', hash)
      setEthAmount("")
      const now = Date.now()
      setRecentStakeTime(now)
      localStorage.setItem('lastStakeTime', now.toString())
      setIsStakePending(false)
      refetchTokenData?.()
      refetchBalance()
      if (!hasSeenPrompt && !sessionEnabled) setShowQuickSignModal(true)
    },
    onError: (err) => {
      handleError(err, "depositZap")
      setIsStakePending(false)
    },
  })

  // Withdraw CAW from L1
  const withdraw = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawProfileAbi,
    functionName: "withdraw",
    args: [CLIENT_ID, Number(tokenId ?? 0), 0n],
    disabled: !tokenId || withdrawFee === 0n,
    value: withdrawFee,
    onPending: () => {
      setIsWithdrawPending(true)
    },
    onSuccess: (hash) => {
      console.log('[Staking] Withdraw successful:', hash)
      setIsWithdrawPending(false)
      // Refetch on-chain data to reflect updated balances
      refetchTokenData?.()
      refetchBalance()
    },
    onError: (err) => {
      setIsWithdrawPending(false)
      handleError(err, "withdraw")
    },
  })

  // Handle stake button click. ensureWallet may open the connect modal +
  // resolve only once the wallet is ready; the await below bridges that.
  // We always clear pending state in finally so a thrown error (e.g. user
  // rejected, or useContractCall bailed on a stale `disabled` ref) doesn't
  // leave the button stuck on "Approving…".
  const handleStake = useCallback(async () => {
    console.log('[Staking] handleStake called', { isConnected, amount, wrongChainForStake, needsApproval, paymentMode })
    try {
      await ensureWallet({ chainId: chains.l1.chainId }, async () => {
        if (paymentMode === 'eth') {
          // No CAW approval needed — the swap output goes Minter → CawProfile
          // directly. Just fire the ZAP.
          console.log('[Staking] Calling depositZap (ETH mode)')
          setIsStakePending(true)
          try { await depositZap.call() } finally { setIsStakePending(false) }
          return
        }
        // Re-fetch allowance now that the wallet is connected and the user's
        // address is known. Pre-connect, useAllowance returns 0n (no owner
        // address), which makes the React-state `needsApproval` true. If the
        // user already has a prior approval, we don't want to ask them to
        // approve again — check the FRESH on-chain value instead.
        const { data: freshAllowance } = await refetchAllowance()
        const wantedAmount = parseUnits((amount || "0").toString(), 18)
        const needsApprovalFresh = !freshAllowance || freshAllowance < wantedAmount

        if (needsApprovalFresh) {
          console.log('[Staking] Approving CAW tokens')
          setIsApprovePending(true)
          try { await approve.call() } finally { setIsApprovePending(false) }
        } else {
          console.log('[Staking] Skipping approve (existing allowance covers amount); depositing')
          setIsStakePending(true)
          try { await stake.call() } finally { setIsStakePending(false) }
        }
      })
    } catch (err) {
      // ensureWallet itself can throw (user closed connect modal, switch-chain
      // rejected). Surface in the existing error handler.
      handleError(err as any, needsApproval ? 'approve' : 'stake')
      setIsApprovePending(false)
      setIsStakePending(false)
    }
  }, [isConnected, wrongChainForStake, needsApproval, approve, stake, depositZap, amount, ensureWallet, refetchAllowance, paymentMode])

  // Handle withdraw button click (for pending withdrawals)
  const handleWithdraw = useCallback(async () => {
    if (!activeToken) return
    console.log('[Staking] handleWithdraw called', { isConnected, isMainnet })
    await ensureWallet({ chainId: chains.l1.chainId }, async () => {
      console.log('[Staking] Executing withdraw')
      await withdraw.call()
    })
  }, [activeToken, isConnected, isMainnet, withdraw, ensureWallet])

  // Handle unstake initialization (on L2)
  const handleUnstakeInit = useCallback(async () => {
    if (!activeToken) return
    console.log('[Staking] handleUnstakeInit called', { isConnected, amount, isMainnet })
    await ensureWallet({ chainId: chains.l2.chainId }, async () => {
      try {
        console.log('[Staking] Submitting withdraw action to L2')
        await signAndSubmit({
          senderId: activeToken.tokenId,
          actionType: 'withdraw',
          recipients: [activeToken.tokenId],
          amounts: [BigInt(Math.floor(parseFloat(amount)))],
        })
        setAmount("")
        console.log('[Staking] Refreshing pending withdrawals')
        await fetchPendingWithdrawals()
      } catch (err) {
        console.error('[Staking] Withdraw init failed', err)
      }
    })
  }, [activeToken, isConnected, amount, isMainnet, signAndSubmit, fetchPendingWithdrawals, ensureWallet])

  const renderStakePanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          {t('staking.deposit.title')}
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          {t('staking.deposit.subtitle')}
        </p>
      </div>

      {/* LayerZero Status Link - Show if stake was recent (within last 5 minutes) */}
      {(() => {
        const now = Date.now()
        const fiveMinutesAgo = now - (5 * 60 * 1000)
        const hasRecentStake = (recentStakeTime && recentStakeTime > fiveMinutesAgo) ||
                               (lastStakedAt && lastStakedAt.getTime() > fiveMinutesAgo)
        return hasRecentStake && address && (
          <LayerZeroStatus address={address} isDark={isDark} />
        )
      })()}

      {/* Payment-mode toggle: pay with CAW (default) or pay with ETH (ZAP).
          ETH-mode swaps via Uniswap V2 in the same tx and forwards CAW to
          depositFor; slippage is enforced by minCawOut. */}
      <div className={`flex items-center gap-2 rounded-full p-1 ${
        isDark ? 'bg-white/[0.04] border border-white/10' : 'bg-black/[0.03] border border-gray-200'
      }`}>
        <button
          type="button"
          onClick={() => setPaymentMode('caw')}
          className={`flex-1 py-2 text-sm font-medium rounded-full transition-colors cursor-pointer ${
            paymentMode === 'caw' ? 'bg-yellow-500 text-black' : (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900')
          }`}
        >
          Pay with CAW
        </button>
        <button
          type="button"
          onClick={() => setPaymentMode('eth')}
          className={`flex-1 py-2 text-sm font-medium rounded-full transition-colors cursor-pointer ${
            paymentMode === 'eth' ? 'bg-yellow-500 text-black' : (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900')
          }`}
        >
          Pay with ETH
        </button>
      </div>
      {paymentMode === 'eth' && (
        <div className="text-right -mt-1">
          <a
            href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-yellow-500/70 hover:text-yellow-500 transition-colors"
          >
            Or use Uniswap directly &rarr;
          </a>
        </div>
      )}

      {/* ETH input + slippage slider (visible only in ETH mode) */}
      {paymentMode === 'eth' && (
        <div className={`border rounded-xl p-4 space-y-3 ${
          isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
        }`}>
          <div className="text-sm font-medium">ETH to deposit</div>
          <div className="relative">
            <input
              type="text"
              inputMode="decimal"
              value={ethAmount}
              onChange={e => setEthAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.05"
              className={`w-full px-4 py-2.5 rounded-full focus:outline-none text-sm ${
                isDark
                  ? 'bg-black border border-white/20 text-white placeholder-white/30 focus:border-white/30'
                  : 'bg-white border border-gray-300 text-black placeholder-gray-400 focus:border-gray-400'
              }`}
            />
            <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm">ETH</span>
          </div>
          {ethAmountWei > 0n && reserves.loaded && (
            <div className={`text-xs space-y-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              <div>
                Expected: <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {Number(zapQuote.expectedCawOut / 10n**18n).toLocaleString('en-US')} CAW
                </span>
              </div>
              <div>
                Minimum (after {(slippageBps / 100).toFixed(2)}% slippage):&nbsp;
                <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {Number(zapQuote.minCawOut / 10n**18n).toLocaleString('en-US')} CAW
                </span>
              </div>
            </div>
          )}
          <div className="space-y-1">
            <div className="flex justify-between items-center text-xs">
              <span className={isDark ? 'text-gray-400' : 'text-gray-600'}>Slippage tolerance</span>
              <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{(slippageBps / 100).toFixed(2)}%</span>
            </div>
            <input
              type="range"
              min={50}
              max={1000}
              step={50}
              value={slippageBps}
              onChange={e => { setSlippageBps(parseInt(e.target.value, 10)); setSlippageAutoSet(true) }}
              className="w-full"
            />
          </div>
        </div>
      )}

      {/* Amount to Stake (CAW mode only) */}
      {paymentMode === 'caw' && (
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          {t('staking.amount.deposit')}
        </label>
        {getPresetAmounts(mockData.availableBalance).length > 0 && (
          <div className="flex flex-wrap gap-2 my-3">
            {getPresetAmounts(mockData.availableBalance).map(preset => (
              <button
                key={preset}
                onClick={() => setAmount(preset.toString())}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${
                  parseFloat(amount) === preset
                    ? 'bg-yellow-500 text-black'
                    : isDark
                      ? 'bg-white/10 text-white hover:bg-white/20'
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
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
            className={`w-full px-4 py-3 pr-20 rounded-full border transition-all duration-300 ${
              isDark ? 'bg-black border-white/20 text-white' : 'bg-gray-100 border-gray-300 text-black'
            } focus:outline-none focus:ring-0`}
          />
          <div className="absolute right-4 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
            <button
              onClick={() => setAmount(mockData.availableBalance.toString())}
              className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300 cursor-pointer ${
              isDark ? 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30' : 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30'
            }`}>
              {t('staking.max')}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-2">
          <button
            onClick={() => setAmount(mockData.availableBalance.toString())}
            className={`text-xs transition-colors duration-300 cursor-pointer hover:underline ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
            }`}
          >
            {t('staking.available', { amount: mockData.availableBalance.toLocaleString('en-US', { maximumFractionDigits: 2 }) })}
          </button>
        </div>
      </div>
      )}

      {/* Rolled-up Network fee row: deposit current + (i) opens the
          per-action / withdraw / LZ breakdown matching the same modal
          used during username creation. */}
      <div className={`flex items-center justify-between rounded-lg border px-3 py-2 ${
        isDark ? 'bg-[#171202]/40 border-white/15 text-gray-300' : 'bg-yellow-50 border-gray-200 text-gray-700'
      }`}>
        <span className="text-sm">Network fees</span>
        <button
          type="button"
          aria-label="Network fee details"
          onClick={() => setShowFeeModal(true)}
          className="flex items-center gap-1 cursor-pointer text-gray-400 hover:text-yellow-500 transition-colors"
        >
          <span className="text-sm font-mono">
            {ethPrice > 0 && depositFee > 0n
              ? `~$${(Number(formatEther(depositFee)) * ethPrice).toFixed(4)}`
              : 'See breakdown'}
          </span>
          <HiInformationCircle className="w-4 h-4" />
        </button>
      </div>
      <NetworkFeeModal
        isOpen={showFeeModal}
        onClose={() => setShowFeeModal(false)}
        networkId={CLIENT_ID}
        ethPrice={ethPrice}
        lzFeeWei={depositQuote?.nativeFee ?? 0n}
        applicableStorageFeesWei={networkFees.depositFee ?? 0n}
      />

      {/* Stake Button */}
      <button
        onClick={handleStake}
        className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 ${
          !isConnected
            ? 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
            : (!tokenId || (!isTokenOwner && !wrongChainForStake) || (!wrongChainForStake && (
                paymentMode === 'eth'
                  ? (ethAmountWei === 0n || depositFee === 0n)
                  : (!amount || depositFee === 0n))))
            ? (isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed')
            : (isStakePending || isApprovePending)
            ? 'bg-yellow-600 text-black cursor-not-allowed'
            : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
        }`}
        disabled={isConnected && (!tokenId || (!isTokenOwner && !wrongChainForStake) || (!wrongChainForStake && (
          paymentMode === 'eth'
            ? (ethAmountWei === 0n || depositFee === 0n || isStakePending || isApprovePending)
            : (!amount || depositFee === 0n || isStakePending || isApprovePending))))}
      >
        {isSwitchingNetwork
          ? t('staking.button.switching')
          : !isTokenOwner && activeToken && isConnected && !wrongChainForStake
          ? t('staking.button.wrong_address')
          : isApprovePending
          ? t('staking.button.approving')
          : isStakePending
          ? t('staking.button.depositing')
          : (paymentMode === 'caw' && insufficientBalance)
          ? t('staking.button.insufficient_balance')
          : paymentMode === 'eth'
          ? "Deposit (ETH)"
          : t('staking.button.deposit')}
      </button>

      {stake.gasCostEth != null && (() => {
        const totalEth = stake.gasCostEth + Number(formatEther(depositFee))
        return (
          <div className="text-sm text-gray-500 text-center mt-2">
            est. gas+fees: {totalEth.toFixed(4)} ETH{ethPrice > 0 && ` (~$${(totalEth * ethPrice).toFixed(2)})`}
            <span className="block text-xs mt-0.5 opacity-60">
              {t('staking.fees.half')}
            </span>
          </div>
        )
      })()}

      <div className="text-center mt-4">
        <a
          href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors cursor-pointer"
        >
          {t('staking.need_more')}
        </a>
      </div>
    </div>
  )

  const renderUnstakePanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          {t('staking.withdraw.title')}
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          {t('staking.withdraw.subtitle')}
        </p>
      </div>

      {/* Ready for Withdrawal Section */}
      {mockData.withdrawable > 0 && (
        <div className={`p-4 rounded-lg border transition-all duration-300 ${
          isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-200'
        }`}>
          <div className="flex items-center justify-between gap-4">
            {/* Left side: Info */}
            <div className="flex-1">
              <div className={`text-sm font-semibold transition-colors duration-300 ${
                isDark ? 'text-green-200' : 'text-green-800'
              }`}>
                {t('staking.ready_withdrawal')}
              </div>
              <div className={`text-2xl font-bold transition-colors duration-300 mt-1 ${
                isDark ? 'text-green-200' : 'text-green-800'
              }`}>
                {mockData.withdrawable.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
              </div>
            </div>

            {/* Right side: Button */}
            <button
              onClick={handleWithdraw}
              className={`py-2 px-6 rounded-full text-sm font-semibold transition-all duration-300 cursor-pointer whitespace-nowrap ${
                !isConnected
                  ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
                  : (!isTokenOwner && activeToken && !wrongChainForUnstake)
                  ? (isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-300 text-gray-600')
                  : (withdraw.status === 'pending' || isWithdrawPending)
                  ? 'bg-yellow-600 text-black'
                  : 'bg-yellow-500 hover:bg-yellow-600 text-black'
              }`}
              disabled={isConnected && ((!isTokenOwner && activeToken && !wrongChainForUnstake) || withdraw.status === 'pending' || isWithdrawPending)}
            >
              {isSwitchingNetwork
                ? t('staking.button.switching')
                : !isTokenOwner && activeToken && isConnected && !wrongChainForUnstake
                ? t('staking.button.wrong_address')
                : (withdraw.status === 'pending' || isWithdrawPending)
                ? t('staking.button.withdrawing')
                : t('staking.button.complete_withdrawal')}
            </button>
            {withdraw.gasCostEth != null && (() => {
              const totalEth = withdraw.gasCostEth + Number(formatEther(withdrawFee))
              return (
                <div className="text-sm text-gray-500 text-center mt-2">
                  est. gas+fees: {totalEth.toFixed(4)} ETH{ethPrice > 0 && ` (~$${(totalEth * ethPrice).toFixed(2)})`}
                  <span className="block text-xs mt-0.5 opacity-60">
                    {t('staking.fees.half')}
                  </span>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* LayerZero Status Link - Show if there are completed withdrawals updated within the last hour */}
      {(() => {
        const now = Date.now()
        const oneHourAgo = now - (60 * 60 * 1000)
        const hasRecentCompletedWithdrawals = allWithdrawals.some((w: WithdrawalRequest) =>
          w.status === 'completed' &&
          w.updatedAt &&
          new Date(w.updatedAt).getTime() > oneHourAgo
        )
        return hasRecentCompletedWithdrawals && address && (
          <LayerZeroStatus address={address} message={t('staking.waiting_unstake')} isDark={isDark} />
        )
      })()}

      {/* Withdrawal Requests (Pending and Recently Completed) */}
      {pendingWithdrawals.length > 0 && (
        <div className="space-y-2">
          {pendingWithdrawals.map((withdrawal) => {
            const isCompleted = withdrawal.status === 'completed'
            return (
              <div key={withdrawal.id} className={`p-4 rounded-lg border transition-all duration-300 ${
                isCompleted
                  ? isDark ? 'bg-green-500/10 border-green-500/30' : 'bg-green-50 border-green-200'
                  : isDark ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'
              }`}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className={`w-2 h-2 rounded-full ${
                      isCompleted ? 'bg-green-500' : 'bg-yellow-500 animate-pulse'
                    }`}></div>
                    <span className={`text-sm transition-colors duration-300 ${
                      isCompleted
                        ? isDark ? 'text-green-200' : 'text-green-800'
                        : isDark ? 'text-yellow-200' : 'text-yellow-800'
                    }`}>
                      <span className="font-semibold">{Number(withdrawal.amount).toLocaleString()} CAW</span>
                    </span>
                  </div>
                  <span className={`text-xs px-2 py-1 rounded-full font-semibold ${
                    isCompleted
                      ? isDark ? 'bg-green-500/20 text-green-200' : 'bg-green-200 text-green-800'
                      : isDark ? 'bg-yellow-500/20 text-yellow-200' : 'bg-yellow-200 text-yellow-800'
                  }`}>
                    {isCompleted ? t('staking.status.completed') : t('staking.status.pending')}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Amount to Unstake */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          {t('staking.amount.unstake')}
        </label>
        {getPresetAmounts(mockData.stakedAmount).length > 0 && (
          <div className="flex flex-wrap gap-2 my-3">
            {getPresetAmounts(mockData.stakedAmount).map(preset => (
              <button
                key={preset}
                onClick={() => setAmount(preset.toString())}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all duration-200 cursor-pointer ${
                  parseFloat(amount) === preset
                    ? 'bg-yellow-500 text-black'
                    : isDark
                      ? 'bg-white/10 text-white hover:bg-white/20'
                      : 'bg-gray-100 text-gray-900 hover:bg-gray-200'
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
            className={`w-full px-4 py-3 pr-20 rounded-full border transition-all duration-300 ${
              isDark ? 'bg-black border-white/20 text-white' : 'bg-gray-100 border-gray-300 text-black'
            } focus:outline-none focus:ring-0`}
          />
          <div className="absolute right-4 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
            <button
              onClick={() => setAmount(mockData.maxWithdrawAmount.toString())}
              className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300 cursor-pointer ${
              isDark ? 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30' : 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30'
            }`}>
              {t('staking.max')}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-2">
          <button
            onClick={() => setAmount(mockData.maxWithdrawAmount.toString())}
            className={`text-xs transition-colors duration-300 cursor-pointer hover:underline ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
            }`}
          >
            {t('staking.staked', { amount: mockData.stakedAmount.toLocaleString('en-US', { maximumFractionDigits: 2 }) })}
          </button>
        </div>
      </div>

      <NetworkFeesPanel
        networkId={CLIENT_ID}
        show={['withdraw']}
        omitZeroRows
      />

      {/* Unstake Button */}
      <button
        onClick={handleUnstakeInit}
        className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 cursor-pointer ${
          !isConnected || isMainnet
            ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
            : (!isTokenOwner && !isMainnet) || (!amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.maxWithdrawAmount)
            ? (isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-300 text-gray-600')
            : 'bg-yellow-500 hover:bg-yellow-600 text-black'
        }`}
        disabled={isConnected && !isMainnet && ((!isTokenOwner) || (!amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.maxWithdrawAmount))}
      >
        {isSwitchingNetwork
          ? t('staking.button.switching')
          : !isTokenOwner && activeToken && isConnected && !isMainnet
          ? t('staking.button.wrong_address')
          : !amount || parseFloat(amount) <= 0
          ? t('staking.button.enter_amount')
          : parseFloat(amount || "0") > mockData.maxWithdrawAmount
          ? t('staking.button.insufficient_staked')
          : t('staking.button.unstake')}
      </button>
    </div>
  )

  const renderInfoPanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          {t('staking.info.title')}
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          {t('staking.info.subtitle')}
        </p>
      </div>

      {/* Requirements */}
      <div className={`p-4 rounded-lg border transition-all duration-300 ${
        isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
      }`}>
        <div className="flex items-start space-x-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <HiOutlineInformationCircle className={`w-4 h-4 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`} />
          </div>
          <div>
            <h3 className={`font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {t('staking.info.requirements.title')}
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {t('staking.info.requirements.body')}
            </p>
          </div>
        </div>
      </div>

      {/* Reward Distribution */}
      <div className={`p-4 rounded-lg border transition-all duration-300 ${
        isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
      }`}>
        <div className="flex items-start space-x-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <HiOutlineInformationCircle className={`w-4 h-4 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`} />
          </div>
          <div>
            <h3 className={`font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {t('staking.info.distribution.title')}
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {t('staking.info.distribution.body')}
            </p>
          </div>
        </div>
      </div>

      {/* Real-time Rewards */}
      <div className={`p-4 rounded-lg border transition-all duration-300 ${
        isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
      }`}>
        <div className="flex items-start space-x-3">
          <div className={`w-6 h-6 rounded-full flex items-center justify-center transition-colors duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <HiOutlineInformationCircle className={`w-4 h-4 transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`} />
          </div>
          <div>
            <h3 className={`font-semibold mb-2 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {t('staking.info.realtime.title')}
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {t('staking.info.realtime.body')}
            </p>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <>
      <div className={`max-w-2xl mx-auto px-6 py-4 ${isDark ? 'bg-black' : 'bg-white'}`}>
        {/* Header */}
        <div className="mb-8">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {t('staking.title')}
          </h1>
          <div className={`flex items-center gap-2 mt-2 mb-6 text-sm ${
            isDark ? 'text-gray-400' : 'text-gray-500'
          }`}>
            <HiOutlineInformationCircle className="w-4 h-4 flex-shrink-0" />
            <span>{t('staking.subtitle')}</span>
          </div>
          <StakingRewardsInfo isDark={isDark} />
        </div>

        {/* Active Account */}
        <div className="mb-6">
          {activeToken ? (
            <button
              onClick={() => navigate(`/users/${mockData.username}`)}
              className={`inline-flex items-center gap-2 pl-1 pr-4 py-1 rounded-full transition-all duration-300 cursor-pointer hover:opacity-80 ${
                isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-gray-200 hover:bg-gray-300'
              }`}
            >
              <div className="w-7 h-7 rounded-full overflow-hidden flex-shrink-0">
                <UserAvatar
                  user={activeProfile || { username: mockData.username, tokenId: mockData.tokenId }}
                  alt={mockData.username}
                  className="w-full h-full"
                  size="small"
                />
              </div>
              <span className={`text-sm font-medium transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {t('staking.active_account', { username: mockData.username })}
              </span>
            </button>
          ) : (
            <div className={`inline-block px-4 py-2 rounded-full transition-all duration-300 ${
              isDark ? 'bg-white/10' : 'bg-gray-200'
            }`}>
              <span className={`text-sm font-medium transition-colors duration-300 ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {t('staking.no_active_account')}
              </span>
            </div>
          )}
        </div>

        {/* Portfolio Overview */}
        <div className="mb-8 md:mb-12">
          <div className="mb-4 flex items-center justify-between">
            <h3 className={`text-lg font-semibold transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {t('staking.portfolio.title')}
            </h3>

            {/* Desktop-only Activity link — aligns with section title */}
            <button
              type="button"
              onClick={() => navigate('/staking/activity')}
              className="hidden md:inline-flex items-center px-3 py-1.5 bg-yellow-500 text-black font-semibold text-xs rounded-full hover:bg-yellow-400 transition-colors cursor-pointer"
            >
              {t('staking.view_activity')}
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${isDark ? 'bg-black' : 'bg-white'} ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`} style={{ paddingTop: '10px' }}>
              <div className={`text-3xl font-bold transition-colors duration-300 text-center flex-1 flex items-center ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {activeToken ? formatUnitsCompact(activeToken.stakedAmount || 0n, 18) : '-'}
              </div>
              <div className={`text-sm transition-colors duration-300 text-center ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {t('staking.portfolio.staked')}
              </div>
            </div>

            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${isDark ? 'bg-black' : 'bg-white'} relative ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`} style={{ paddingTop: '10px' }}>
              {/* Question mark icon in top right */}
              <div className="absolute top-1.5 right-1.5">
                <Tooltip text={t('staking.withdrawable_tooltip')} position="top">
                  <HiQuestionMarkCircle className={`w-4 h-4 cursor-help ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
                </Tooltip>
              </div>
              <div className={`text-3xl font-bold transition-colors duration-300 text-center flex-1 flex items-center ${
                isDark ? 'text-yellow-200' : 'text-yellow-800'
              }`}>
                {activeToken ? formatUnitsCompact(activeToken.withdrawable || 0n, 18) : '-'}
              </div>
              <div className={`text-sm transition-colors duration-300 text-center ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {t('staking.portfolio.withdrawable')}
              </div>
            </div>

            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${isDark ? 'bg-black' : 'bg-white'} ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`} style={{ paddingTop: '10px' }}>
              <div className={`text-3xl font-bold transition-colors duration-300 text-center flex-1 flex items-center ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {activeToken ? formatUnitsCompact(activeToken.ownerBalance || 0n, 18) : '-'}
              </div>
              <div className={`text-sm transition-colors duration-300 text-center ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {t('staking.portfolio.wallet')}
              </div>
            </div>

            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 flex flex-col items-center justify-between ${isDark ? 'bg-black' : 'bg-white'} ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`} style={{ paddingTop: '10px' }}>
              <div className={`text-3xl font-bold transition-colors duration-300 text-center flex-1 flex items-center ${
                isDark ? 'text-white' : 'text-black'
              }`}>
                {activeToken ? mockData.actions.toLocaleString() : '-'}
              </div>
              <div className={`text-sm transition-colors duration-300 text-center ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                {t('staking.portfolio.actions')}
              </div>
            </div>
          </div>
          {/* Activity link — opens day-by-day flow page. */}
          <div className="mt-3 flex justify-end md:hidden">
            <button
              type="button"
              onClick={() => navigate('/staking/activity')}
              className={`text-xs font-medium transition-colors cursor-pointer ${
                isDark ? 'text-yellow-500/80 hover:text-yellow-400' : 'text-yellow-700 hover:text-yellow-800'
              }`}
            >
              {t('staking.view_activity')}
            </button>
          </div>
        </div>

        {/* Custom Tabs - Container Style.
            min-w-0 + truncate are needed for languages whose labels
            overflow the equal-width tabs (Spanish "Información" vs
            English "Info"). Without min-w-0 the flex children refuse
            to shrink below their content width and the icon spills
            out of the rounded container. Slight text-size step down on
            mobile keeps three tabs comfortable on a 320px viewport. */}
        <div className="mb-6">
          <div className={`relative p-1 rounded-xl transition-all duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <div className="flex relative">
                                <button
                    onClick={() => navigate('/staking')}
                    className={`flex-1 min-w-0 py-2 px-2 sm:px-6 text-center font-medium text-base sm:text-lg transition-all duration-200 flex items-center justify-center gap-1 sm:gap-2 relative z-10 cursor-pointer ${
                      activeTab === 'stake'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineTrendingUp className="w-5 h-5 shrink-0" />
                    <span className="truncate">{t('staking.tab.deposit')}</span>
                  </button>

                  <button
                    onClick={() => navigate('/staking/unstake')}
                    className={`flex-1 min-w-0 py-2 px-2 sm:px-6 text-center font-medium text-base sm:text-lg transition-all duration-200 flex items-center justify-center gap-1 sm:gap-2 relative z-10 cursor-pointer ${
                      activeTab === 'unstake'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineTrendingDown className="w-5 h-5 shrink-0" />
                    <span className="truncate">{t('staking.tab.withdraw')}</span>
                  </button>

                  <button
                    onClick={() => navigate('/staking/info')}
                    className={`flex-1 min-w-0 py-2 px-2 sm:px-6 text-center font-medium text-base sm:text-lg transition-all duration-200 flex items-center justify-center gap-1 sm:gap-2 relative z-10 cursor-pointer ${
                      activeTab === 'info'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineInformationCircle className="w-5 h-5 shrink-0" />
                    <span className="truncate">{t('staking.tab.info')}</span>
                  </button>
            </div>
          </div>
        </div>

        {/* Tab Content */}
        <div className="mt-6 pb-[calc(var(--bottom-nav-h,0px)+16px)]">
          {activeTab === 'stake' && renderStakePanel()}
          {activeTab === 'unstake' && renderUnstakePanel()}
          {activeTab === 'info' && renderInfoPanel()}
        </div>
      </div>
      <QuickSignModal
        isOpen={showQuickSignModal}
        onClose={() => setShowQuickSignModal(false)}
      />
    </>
  )
}

export { Staking }
