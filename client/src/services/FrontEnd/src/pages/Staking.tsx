// src/services/FrontEnd/src/components/CawStakingForm.tsx
import React, { useEffect, useState, useCallback, useMemo } from "react"
import { useSignAndSubmitAction } from '~/api/actions'
import { useSearchParams, useNavigate, useLocation } from "react-router-dom"
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
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore"
import { cawNameAbi, cawNameL2Abi, cawNameQuoterAbi } from "~/../../../abi/generated"
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_L2_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from "~/../../../abi/addresses"
import { maxUint256, parseUnits, formatUnits, erc20Abi } from "viem";
import MainLayout from '~/layouts/MainLayout'
import { sepolia, baseSepolia } from 'wagmi/chains'
import { chains } from '~/config/chains'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { HiOutlineTrendingUp, HiOutlineTrendingDown, HiOutlineInformationCircle, HiQuestionMarkCircle } from 'react-icons/hi'

type StakingTab = 'stake' | 'unstake' | 'info'

const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)

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
  const { isDark } = useTheme()
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

  // Get deposit quote from CawNameQuoter
  const { data: depositQuote } = useReadContract({
    abi: cawNameQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "depositQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [CLIENT_ID, tokenId ?? 0, parseUnits(amount || "0", 18), chains.l2.layerZero, false],
    query: {
      enabled: !!tokenId && !!amount && activeTab === 'stake'
    }
  })

  // Get withdraw quote from CawNameQuoter
  const { data: withdrawQuote } = useReadContract({
    address: CAW_NAME_QUOTER_ADDRESS,
    abi: cawNameQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "withdrawQuote",
    args: [CLIENT_ID, false],
    query: {
      enabled: !!tokenId && activeTab === 'unstake'
    }
  })

  // Update fees when quotes change
  useEffect(() => {
    if (depositQuote?.nativeFee != null) setDepositFee(BigInt(depositQuote.nativeFee))
  }, [depositQuote])

  useEffect(() => {
    if (withdrawQuote?.nativeFee != null) setWithdrawFee(BigInt(withdrawQuote.nativeFee))
  }, [withdrawQuote])

  // Fetch lastStakedAt timestamp from user profile
  useEffect(() => {
    const fetchLastStakedAt = async () => {
      if (!activeToken?.username) return

      try {
        const response = await fetch(`/api/users/${activeToken.username}`)
        const data = await response.json()

        if (data.lastStakedAt) {
          setLastStakedAt(new Date(data.lastStakedAt))
        }
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
      const response = await fetch(`/api/withdrawals/${tokenId}`)
      const data = await response.json()

      if (data.success && data.withdrawals) {
        console.log('[Staking] Fetched withdrawal requests:', data.withdrawals)
        // Store all withdrawals for LayerZero message check
        setAllWithdrawals(data.withdrawals)
        // Filter to show pending and recently completed (within last 10 seconds)
        const now = Date.now()
        const filtered = data.withdrawals.filter((w: WithdrawalRequest) => {
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

  const insufficientBalance = !balance || parseUnits(amount || "0", 18) > balance
  const needsApproval = !allowance || parseUnits(amount || "0", 18) > allowance

  // Use real data from activeToken if available
  const mockData = useMemo(() => {
    if (!activeToken) {
      return {
        stakedAmount: 0,
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

    return {
      stakedAmount,
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
    abi: cawNameAbi,
    functionName: "deposit",
    args: [CLIENT_ID, tokenId || 0, parseUnits((amount || "0").toString(), 18), chains.l2.layerZero, 0n],
    disabled: !tokenId || !amount || depositFee === 0n || !isTokenOwner,
    value: depositFee,
    onPending: () => {
      setIsStakePending(true)
    },
    onSuccess: async (hash) => {
      console.log('[Staking] Stake successful:', hash)
      setAmount("")
      const now = Date.now()
      setRecentStakeTime(now)
      // Persist to localStorage so it survives page refresh
      localStorage.setItem('lastStakeTime', now.toString())
      setIsStakePending(false)
      // Refetch on-chain data to reflect updated balances
      refetchTokenData?.()
      refetchBalance()

      // Also record stake timestamp in database for persistent LayerZero status check
      if (activeToken?.username) {
        try {
          await fetch(`/api/users/${activeToken.username}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lastStakedAt: new Date().toISOString() })
          })
        } catch (err) {
          console.error('[Staking] Failed to record stake timestamp:', err)
        }
      }
    },
    onError: (err) => {
      handleError(err, "stake")
      setIsStakePending(false)
    },
  })

  // Withdraw CAW from L1
  const withdraw = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
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

  // Handle stake button click
  const handleStake = useCallback(async () => {
    console.log('[Staking] handleStake called', { isConnected, amount, wrongChainForStake, needsApproval })

    // If not connected, open wallet connect modal
    if (!isConnected) {
      console.log('[Staking] Opening connect modal')
      openConnectModal?.()
      return
    }

    if (wrongChainForStake) {
      console.log('[Staking] Switching to L1 network')
      setIsSwitchingNetwork(true)
      try {
        await switchChain({ chainId: chains.l1.chainId })
      } catch (err) {
        console.error('[Staking] Network switch failed:', err)
        setIsSwitchingNetwork(false)
      }
      return
    }

    if (needsApproval) {
      console.log('[Staking] Approving CAW tokens')
      setIsApprovePending(true)
      await approve.call()
    } else {
      console.log('[Staking] Depositing CAW')
      setIsStakePending(true)
      await stake.call()
    }
  }, [isConnected, wrongChainForStake, needsApproval, approve, stake, amount, switchChain, openConnectModal])

  // Handle withdraw button click (for pending withdrawals)
  const handleWithdraw = useCallback(async () => {
    if (!activeToken) return
    console.log('[Staking] handleWithdraw called', { isConnected, isMainnet })

    // If not connected, open wallet connect modal
    if (!isConnected) {
      console.log('[Staking] Opening connect modal')
      openConnectModal?.()
      return
    }

    if (!isMainnet) {
      console.log('[Staking] Switching to L1 network')
      setIsSwitchingNetwork(true)
      try {
        await switchChain({ chainId: chains.l1.chainId })
      } catch (err) {
        console.error('[Staking] Network switch failed:', err)
        setIsSwitchingNetwork(false)
      }
      return
    }

    console.log('[Staking] Executing withdraw')
    await withdraw.call()
  }, [activeToken, isConnected, isMainnet, withdraw, switchChain, openConnectModal])

  // Handle unstake initialization (on L2)
  const handleUnstakeInit = useCallback(async () => {
    if (!activeToken) return
    console.log('[Staking] handleUnstakeInit called', { isConnected, amount, isMainnet })

    // If not connected, open wallet connect modal
    if (!isConnected) {
      console.log('[Staking] Opening connect modal')
      openConnectModal?.()
      return
    }

    if (isMainnet) {
      console.log('[Staking] Switching to L2 network')
      setIsSwitchingNetwork(true)
      try {
        await switchChain({ chainId: chains.l2.chainId })
      } catch (err) {
        console.error('[Staking] Network switch failed:', err)
        setIsSwitchingNetwork(false)
      }
      return
    }

    try {
      console.log('[Staking] Submitting withdraw action to L2')
      // Note: amounts in action struct are uint64, so we use whole CAW units (not wei)
      // The contract will handle the conversion to wei internally
      await signAndSubmit({
        senderId: activeToken.tokenId,
        actionType: 'withdraw',
        recipients: [activeToken.tokenId],
        amounts: [BigInt(Math.floor(parseFloat(amount)))],
      })
      setAmount("")

      // Refresh pending withdrawals after submission
      console.log('[Staking] Refreshing pending withdrawals')
      await fetchPendingWithdrawals()
    } catch (err) {
      console.error('[Staking] Withdraw init failed', err)
    }
  }, [activeToken, isConnected, amount, isMainnet, signAndSubmit, switchChain, fetchPendingWithdrawals, openConnectModal])

  const renderStakePanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          Stake CAW
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          Earn rewards from protocol activity
        </p>
      </div>

      {/* LayerZero Status Link - Show if stake was recent (within last 5 minutes) */}
      {(() => {
        const now = Date.now()
        const fiveMinutesAgo = now - (5 * 60 * 1000)
        const hasRecentStake = (recentStakeTime && recentStakeTime > fiveMinutesAgo) ||
                               (lastStakedAt && lastStakedAt.getTime() > fiveMinutesAgo)
        return hasRecentStake && address && (
          <div className={`p-3 rounded-lg border transition-all duration-300 ${
            isDark ? 'bg-blue-500/10 border-blue-500/30' : 'bg-blue-50 border-blue-200'
          }`}>
            <div className="flex items-start gap-2">
              <div className={`mt-0.5 text-sm ${isDark ? 'text-blue-300' : 'text-blue-600'}`}>ℹ️</div>
              <div className="flex-1">
                <p className={`text-xs leading-relaxed transition-colors duration-300 ${
                  isDark ? 'text-blue-200' : 'text-blue-800'
                }`}>
                  Waiting for your staked CAW to appear?
                  <br />
                  Cross-chain transfers might be processing in the background.
                  <br />
                  <br />
                  <a
                    href={`https://${chains.l2.chainId === baseSepolia.id ? 'testnet.' : ''}layerzeroscan.com/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`font-semibold hover:underline ${
                      isDark ? 'text-blue-300' : 'text-blue-600'
                    }`}
                  >
                    Check status here →
                  </a>
                </p>
              </div>
            </div>
          </div>
        )
      })()}

      {/* Amount to Stake */}
      <div className="space-y-2">
        <label className={`text-sm font-medium transition-colors duration-300 ${
          isDark ? 'text-gray-300' : 'text-gray-700'
        }`}>
          Amount to Stake
        </label>
        <div className="relative">
          <input
            type="number"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-full px-4 py-3 pr-20 rounded-full border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20 text-white' : 'border-gray-300 text-black'
            } focus:outline-none focus:ring-0`}
          />
          <div className="absolute right-4 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
            <button
              onClick={() => setAmount(mockData.availableBalance.toString())}
              className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300 cursor-pointer ${
              isDark ? 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30' : 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30'
            }`}>
              MAX
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
            Available: {mockData.availableBalance.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
          </button>
        </div>
      </div>

      {/* Stake Button */}
      <button
        onClick={handleStake}
        className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 ${
          !isConnected
            ? 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
            : (!tokenId || (!isTokenOwner && !wrongChainForStake) || (!wrongChainForStake && !needsApproval && (!amount || depositFee === 0n)))
            ? (isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed')
            : (isStakePending || isApprovePending)
            ? 'bg-yellow-600 text-black cursor-not-allowed'
            : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
        }`}
        disabled={isConnected && (!tokenId || (!isTokenOwner && !wrongChainForStake) || (!wrongChainForStake && ((!needsApproval && (!amount || depositFee === 0n || isStakePending)) || (needsApproval && isApprovePending))))}
      >
        {isSwitchingNetwork
          ? 'Switching...'
          : !isConnected
          ? 'Connect Wallet'
          : !isTokenOwner && activeToken && !wrongChainForStake
          ? 'Wrong Address'
          : isStakePending
          ? 'Staking...'
          : isApprovePending
          ? 'Approving...'
          : wrongChainForStake
          ? 'Switch Network'
          : needsApproval
          ? 'Approve'
          : insufficientBalance
          ? "Insufficient Balance"
          : "Stake CAW"}
      </button>

      <div className="text-center mt-4">
        <a
          href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
          target="_blank"
          rel="noopener noreferrer"
          className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors cursor-pointer"
        >
          Need more CAW? Click here.
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
          Unstake CAW
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          Withdraw your staked tokens
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
                Ready for Withdrawal
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
                ? 'Switching...'
                : !isConnected
                ? 'Connect Wallet'
                : !isTokenOwner && activeToken && !wrongChainForUnstake
                ? 'Wrong Address'
                : (withdraw.status === 'pending' || isWithdrawPending)
                ? 'Withdrawing...'
                : wrongChainForUnstake
                ? 'Switch Network'
                : 'Complete Withdrawal'}
            </button>
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
          <div className={`p-3 rounded-lg border transition-all duration-300 ${
            isDark ? 'bg-blue-500/10 border-blue-500/30' : 'bg-blue-50 border-blue-200'
          }`}>
            <div className="flex items-start gap-2">
              <div className={`mt-0.5 text-sm ${isDark ? 'text-blue-300' : 'text-blue-600'}`}>ℹ️</div>
              <div className="flex-1">
                <p className={`text-xs leading-relaxed transition-colors duration-300 ${
                  isDark ? 'text-blue-200' : 'text-blue-800'
                }`}>
                  Waiting for your unstaked CAW? Cross-chain transfers might be processing in the background.
                  <br />
                  <a
                    href={`https://${chains.l2.chainId === baseSepolia.id ? 'testnet.' : ''}layerzeroscan.com/address/${address}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`font-semibold hover:underline ${
                      isDark ? 'text-blue-300' : 'text-blue-600'
                    }`}
                  >
                    Check status here →
                  </a>
                </p>
              </div>
            </div>
          </div>
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
                    {isCompleted ? 'Completed' : 'Pending'}
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
          Amount to Unstake
        </label>
        <div className="relative">
          <input
            type="number"
            placeholder="0.0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={`w-full px-4 py-3 pr-20 rounded-full border transition-all duration-300 bg-black ${
              isDark ? 'border-white/20 text-white' : 'border-gray-300 text-black'
            } focus:outline-none focus:ring-0`}
          />
          <div className="absolute right-4 top-1/2 transform -translate-y-1/2 flex items-center gap-2">
            <button
              onClick={() => setAmount(mockData.stakedAmount.toString())}
              className={`px-3 py-1 text-xs font-semibold rounded-full transition-all duration-300 cursor-pointer ${
              isDark ? 'bg-yellow-500/20 text-yellow-500 hover:bg-yellow-500/30' : 'bg-yellow-500/20 text-yellow-600 hover:bg-yellow-500/30'
            }`}>
              MAX
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-2">
          <button
            onClick={() => setAmount(mockData.stakedAmount.toString())}
            className={`text-xs transition-colors duration-300 cursor-pointer hover:underline ${
              isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
            }`}
          >
            Staked: {mockData.stakedAmount.toLocaleString('en-US', { maximumFractionDigits: 2 })} CAW
          </button>
        </div>
      </div>

      {/* Unstake Button */}
      <button
        onClick={handleUnstakeInit}
        className={`w-full py-3 px-4 rounded-full font-semibold transition-all duration-300 cursor-pointer ${
          !isConnected || isMainnet
            ? 'bg-yellow-500 hover:bg-yellow-600 text-black'
            : (!isTokenOwner && !isMainnet) || (!amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.stakedAmount)
            ? (isDark ? 'bg-gray-700 text-gray-400' : 'bg-gray-300 text-gray-600')
            : 'bg-yellow-500 hover:bg-yellow-600 text-black'
        }`}
        disabled={isConnected && !isMainnet && ((!isTokenOwner) || (!amount || parseFloat(amount) <= 0 || parseFloat(amount) > mockData.stakedAmount))}
      >
        {isSwitchingNetwork
          ? 'Switching...'
          : !isConnected
          ? 'Connect Wallet'
          : !isTokenOwner && activeToken && !isMainnet
          ? 'Wrong Address'
          : isMainnet
          ? 'Switch Network'
          : !amount || parseFloat(amount) <= 0
          ? "Enter Amount"
          : parseFloat(amount || "0") > mockData.stakedAmount
          ? "Insufficient Staked"
          : "Unstake"}
      </button>
    </div>
  )

  const renderInfoPanel = () => (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-2 transition-colors duration-300 ${
          isDark ? 'text-white' : 'text-black'
        }`}>
          How Staking Works
        </h2>
        <p className={`text-sm transition-colors duration-300 ${
          isDark ? 'text-gray-400' : 'text-gray-600'
        }`}>
          Learn about CAW Protocol staking mechanics
        </p>
      </div>

      {/* Requirements */}
      <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
        isDark ? 'border-white/20' : 'border-gray-300'
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
              Requirements
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Staking CAW requires a minted username NFT, which will retain the staked amount and accrue rewards over time.
            </p>
          </div>
        </div>
      </div>

      {/* Reward Distribution */}
      <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
        isDark ? 'border-white/20' : 'border-gray-300'
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
              Reward Distribution
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              With every action (CAW, RECAW, LIKE, FOLLOW, etc...) on the CAW Protocol, a small CAW fee is collected and automatically distributed to all CAW stakers in proportion to their deposits.
            </p>
          </div>
        </div>
      </div>

      {/* Real-time Rewards */}
      <div className={`p-4 rounded-lg border transition-all duration-300 bg-black ${
        isDark ? 'border-white/20' : 'border-gray-300'
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
              Real-time Rewards
            </h3>
            <p className={`text-sm transition-colors duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Rewards accrue in real time and can be withdrawn at any moment. No lock-up periods or waiting times.
            </p>
          </div>
        </div>
      </div>
    </div>
  )

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4 bg-black">
        {/* Header */}
        <div className="mb-8">
          <h1 className={`text-3xl font-bold mb-6 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            CAW Staking
          </h1>
          <div className={`p-4 rounded-lg border transition-all duration-300 ${
            isDark ? 'bg-yellow-500/10 border-white/20' : 'bg-yellow-50 border-gray-300'
          }`}>
            <h3 className={`text-base font-semibold mb-3 transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-gray-900'
            }`}>
              Earn rewards from every action across the protocol:
            </h3>
            <ul className={`text-sm space-y-2 transition-colors duration-300 ${
              isDark ? 'text-gray-300' : 'text-gray-700'
            }`}>
              <li className="flex justify-between items-start">
                <span><span className={`font-semibold ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>Post a CAW:</span> 5,000 CAW</span>
                <span className={`text-xs ml-2 ${isDark ? 'text-yellow-500/70' : 'text-yellow-600'}`}>100% to stakers</span>
              </li>
              <li className="flex justify-between items-start">
                <span><span className={`font-semibold ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>Like a CAW:</span> 2,000 CAW</span>
                <span className={`text-xs ml-2 ${isDark ? 'text-yellow-500/70' : 'text-yellow-600'}`}>80% to poster, 20% to stakers</span>
              </li>
              <li className="flex justify-between items-start">
                <span><span className={`font-semibold ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>ReCAW:</span> 4,000 CAW</span>
                <span className={`text-xs ml-2 ${isDark ? 'text-yellow-500/70' : 'text-yellow-600'}`}>50% to poster, 50% to stakers</span>
              </li>
              <li className="flex justify-between items-start">
                <span><span className={`font-semibold ${isDark ? 'text-yellow-300' : 'text-yellow-700'}`}>Follow:</span> 30,000 CAW</span>
                <span className={`text-xs ml-2 ${isDark ? 'text-yellow-500/70' : 'text-yellow-600'}`}>80% to followed, 20% to stakers</span>
              </li>
            </ul>
          </div>
        </div>

        {/* Active Account */}
        <div className="mb-6">
          <div className={`inline-block px-4 py-2 rounded-full transition-all duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          }`}>
            <span className={`text-sm font-medium transition-colors duration-300 ${
              isDark ? 'text-white' : 'text-black'
            }`}>
              {activeToken ? (
                <>Active Account: @{mockData.username}</>
              ) : (
                'No Active Account'
              )}
            </span>
          </div>
        </div>

        {/* Portfolio Overview */}
        <div className="mb-8">
          <h3 className={`text-lg font-semibold mb-4 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Portfolio Overview
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 bg-black flex flex-col items-center justify-between ${
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
                Staked CAW
              </div>
            </div>

            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 bg-black flex flex-col items-center justify-between relative ${
              isDark ? 'border-white/20' : 'border-gray-300'
            }`} style={{ paddingTop: '10px' }}>
              {/* Question mark icon in top right */}
              <div className="absolute top-1.5 right-1.5 group">
                <HiQuestionMarkCircle className={`w-4 h-4 cursor-help ${isDark ? 'text-gray-400' : 'text-gray-500'}`} />
                <div className={`absolute bottom-full right-0 mb-2 px-3 py-2 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-50 ${
                  isDark ? 'bg-white text-black' : 'bg-gray-900 text-white'
                }`}>
                  You must unstake your CAW to withdraw it
                  <div className={`absolute top-full right-2 border-4 border-transparent ${
                    isDark ? 'border-t-white' : 'border-t-gray-900'
                  }`}></div>
                </div>
              </div>
              <div className={`text-3xl font-bold transition-colors duration-300 text-center flex-1 flex items-center ${
                isDark ? 'text-yellow-200' : 'text-yellow-800'
              }`}>
                {activeToken ? formatUnitsCompact(activeToken.withdrawable || 0n, 18) : '-'}
              </div>
              <div className={`text-sm transition-colors duration-300 text-center ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                Withdrawable
              </div>
            </div>

            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 bg-black flex flex-col items-center justify-between ${
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
                Wallet Balance
              </div>
            </div>

            <div className={`px-1 pb-1 rounded-lg border transition-all duration-300 bg-black flex flex-col items-center justify-between ${
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
                Actions
              </div>
            </div>
          </div>
        </div>

        {/* Custom Tabs - Container Style */}
        <div className="mb-6">
          <div className={`relative p-1 rounded-xl transition-all duration-300 ${
            isDark ? 'bg-white/10' : 'bg-gray-200'
          } max-w-md mx-auto`}>
            <div className="flex relative">
                                <button
                    onClick={() => navigate('/staking')}
                    className={`flex-1 py-2 px-2 sm:px-6 text-center font-medium text-lg transition-all duration-200 flex items-center justify-center space-x-2 relative z-10 cursor-pointer ${
                      activeTab === 'stake'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg shadow-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineTrendingUp className="w-5 h-5" />
                    <span>Stake</span>
                  </button>

                  <button
                    onClick={() => navigate('/staking/unstake')}
                    className={`flex-1 py-2 px-2 sm:px-6 text-center font-medium text-lg transition-all duration-200 flex items-center justify-center space-x-2 relative z-10 cursor-pointer ${
                      activeTab === 'unstake'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg shadow-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineTrendingDown className="w-5 h-5" />
                    <span>Unstake</span>
                  </button>

                  <button
                    onClick={() => navigate('/staking/info')}
                    className={`flex-1 py-2 px-2 sm:px-6 text-center font-medium text-lg transition-all duration-200 flex items-center justify-center space-x-2 relative z-10 cursor-pointer ${
                      activeTab === 'info'
                        ? `${isDark ? 'bg-white text-black' : 'bg-black text-white'} rounded-lg shadow-lg`
                        : `${isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'}`
                    }`}
                  >
                    <HiOutlineInformationCircle className="w-5 h-5" />
                    <span>Info</span>
                  </button>
            </div>
          </div>
        </div>

        {/* Tab Content */}
        <div className="mt-6">
          {activeTab === 'stake' && renderStakePanel()}
          {activeTab === 'unstake' && renderUnstakePanel()}
          {activeTab === 'info' && renderInfoPanel()}
        </div>
      </div>
    </MainLayout>
  )
}

export { Staking }
