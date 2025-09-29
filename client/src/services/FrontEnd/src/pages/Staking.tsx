import React, { useEffect, useState, useCallback } from "react"
import { useSignAndSubmitAction } from '~/api/actions'
import { useSearchParams } from "react-router-dom"
import { CgExternal } from "react-icons/cg"
import { FormHeader } from "~/components/forms/FormHeader"
import { SubmitButton } from "~/components/buttons/SubmitButton"
import { Input } from "~/components/Input"
import { GasPriceLine } from "~/components/GasPriceLine"
import { TokenData } from "~/types";
import { handleError, convertToText } from "~/utils";
import useContractCall from "~/hooks/useContractCall";
import useAllowance from "~/hooks/useAllowance";
import { useAccount, useConnections, useReadContract, useSwitchChain } from "wagmi"
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore"
import { erc20Abi, cawNameAbi, cawNameL2Abi } from "~/../../../abi/generated"
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_L2_ADDRESS } from "~/../../../abi/addresses"
import { maxUint256, parseUnits } from "viem";
import MainLayout from '~/layouts/MainLayout'
import { sepolia, baseSepolia } from 'wagmi/chains'
import { chains } from '~/config/chains'
import MobileBottomNavbar from '~/components/MobileBottomNavbar'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { 
  HiOutlineArrowUp, 
  HiOutlineArrowDown, 
  HiOutlineInformationCircle,
  HiOutlineCreditCard,
  HiOutlineChartBar,
  HiOutlineClock,
  HiOutlineCube,
  HiOutlineDownload,
  HiOutlineCollection,
  HiOutlineLightningBolt,
  HiOutlineExclamationCircle,
  HiOutlineMinus,
  HiOutlineCash
} from 'react-icons/hi'

const CLIENT_ID = 1; // Define CLIENT_ID constant

type StakingTab = 'stake' | 'unstake' | 'info'

const Staking = () => {
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const activeToken = useActiveToken()
  const activeTab = (searchParams.get('action') as StakingTab) || 'stake'
  const tokenId = activeToken?.tokenId

  const tabs: StakingTab[] = ['stake', 'unstake', 'info']

  // Mock data for portfolio overview
  const portfolioStats = {
    stakedCAW: 500.0,
    withdrawable: 25.0,
    walletBalance: 1000,
    actions: 42
  }

  return (
    <MainLayout>
      <div className="min-h-screen bg-black text-white">
        <div className="max-w-4xl mx-auto px-3 sm:px-4 py-4 sm:py-6 pb-20 md:pb-6">
          {/* Header Section */}
          <div className="mb-4 sm:mb-6">
            <h1 className="text-xl sm:text-2xl font-bold text-white mb-1">CAW Staking</h1>
            <p className="text-gray-400 text-xs sm:text-sm">Earn rewards from every action across the protocol</p>
            
            {/* Active Account */}
            <div className="mt-3 sm:mt-4">
              {activeToken ? (
                <div className="inline-flex items-center px-2 sm:px-3 py-1 sm:py-1.5 rounded-lg border border-white/20">
                  <span className="text-white text-xs sm:text-sm font-medium">Active Account: @{activeToken.username}</span>
                </div>
              ) : (
                <div className="text-gray-400 text-xs sm:text-sm">
                  No active account. You must first <Link className='underline text-yellow-400' to={`/mint`}>create a profile</Link>
                </div>
              )}
            </div>
          </div>

          {/* Portfolio Overview */}
          <div className="mb-4 sm:mb-6">
            <h2 className="text-base sm:text-lg font-semibold text-white mb-3 sm:mb-4">Portfolio Overview</h2>
            <div className="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-4 gap-2 sm:gap-4">
              {/* Staked CAW Card */}
              <div className="rounded-lg sm:rounded-xl p-3 sm:p-6 border border-white/20">
                <div className="text-gray-400 text-xs sm:text-sm mb-1 sm:mb-2">Staked CAW</div>
                <div className="text-lg sm:text-2xl font-bold text-white">{portfolioStats.stakedCAW}</div>
              </div>

              {/* Withdrawable Card */}
              <div className="rounded-lg sm:rounded-xl p-3 sm:p-6 border border-white/20">
                <div className="text-gray-400 text-xs sm:text-sm mb-1 sm:mb-2">Withdrawable</div>
                <div className="text-lg sm:text-2xl font-bold text-yellow-400">{portfolioStats.withdrawable}</div>
              </div>

              {/* Wallet Balance Card */}
              <div className="rounded-lg sm:rounded-xl p-3 sm:p-6 border border-white/20">
                <div className="text-gray-400 text-xs sm:text-sm mb-1 sm:mb-2">Wallet Balance</div>
                <div className="text-lg sm:text-2xl font-bold text-white">{portfolioStats.walletBalance}</div>
              </div>

              {/* Actions Card */}
              <div className="rounded-lg sm:rounded-xl p-3 sm:p-6 border border-white/20">
                <div className="text-gray-400 text-xs sm:text-sm mb-1 sm:mb-2">Actions</div>
                <div className="text-lg sm:text-2xl font-bold text-white">{portfolioStats.actions}</div>
              </div>
            </div>
          </div>

          {/* Action Tabs */}
          <div className="mb-6 sm:mb-8">
            <div className="flex space-x-1 sm:space-x-2 p-1 rounded-lg sm:rounded-xl border border-white/20">
              {tabs.map(tab => (
                <button
                  key={tab}
                  onClick={() => setSearchParams({action: tab})}
                  className={`flex-1 flex items-center justify-center gap-1 sm:gap-2 py-2 sm:py-3 px-2 sm:px-4 rounded-md sm:rounded-lg font-medium transition-all duration-200 ${
                    activeTab === tab
                      ? 'bg-yellow-400 text-black'
                      : 'text-gray-400 hover:text-white'
                  }`}
                >
                  {tab === 'stake' && <HiOutlineArrowUp className="w-3 h-3 sm:w-5 sm:h-5" />}
                  {tab === 'unstake' && <HiOutlineArrowDown className="w-3 h-3 sm:w-5 sm:h-5" />}
                  {tab === 'info' && <HiOutlineInformationCircle className="w-3 h-3 sm:w-5 sm:h-5" />}
                  <span className="text-xs sm:text-sm">{tab === 'stake' ? 'Stake' : tab === 'unstake' ? 'Unstake' : 'Info'}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Tab Content */}
          <div className="rounded-lg sm:rounded-xl p-4 sm:p-8 border border-white/20">
            {activeTab === "stake" && <StakePanel tokenId={tokenId} />}
            {activeTab === "unstake" && <UnstakePanel token={activeToken} />}
            {activeTab === "info" && <InfoPanel />}
          </div>
        </div>
      </div>
    </MainLayout>
  )
}

/** Deposit panel */
function StakePanel({ tokenId }: { tokenId?: number }) {
  const { switchChain } = useSwitchChain();
  const handleSwitchChain = () => switchChain({ chainId: chains.l1.chainId });
  const { allowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_ADDRESS);
  const [ amount, setAmount ] = useState<string>("")
  const [ depositFee, setDepositFee ] = useState<bigint>(0n)
  const { address } = useAccount();

  const connections = useConnections();
  const wrongChain = connections[0]?.chainId != chains.l1.chainId;

  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address:      CAW_ADDRESS,
    abi:          erc20Abi,
    chainId: chains.l1.chainId,
    functionName: "balanceOf",
    args:         [ address! ],
    query: {
      enabled:      !!tokenId && !!address
    }
  })

  // quote on‐chain L2 deposit fee
  const { data: quote, error, failureReason, fetchStatus } = useReadContract({
    abi: cawNameAbi,
    chainId: chains.l1.chainId,
    functionName: "depositQuote",
    address: CAW_NAMES_ADDRESS,
    args: [ CLIENT_ID, tokenId ?? 0, parseUnits(amount || "0", 18), chains.l2.layerZero, false ],
    query: {
      enabled: !!tokenId && !!amount
    }
  })

  useEffect(() => {
    if (quote?.nativeFee != null) setDepositFee(BigInt(quote.nativeFee))
  }, [quote])

  const insufficientBalance = !balance || BigInt(amount) > balance;
  const needsApproval = !allowance || BigInt(amount) > allowance;

  const approve = useContractCall({
    address: CAW_ADDRESS,
    abi: erc20Abi,
    functionName: "approve",
    args: [CAW_NAMES_ADDRESS, maxUint256],
    disabled: !amount || insufficientBalance,
    onError: (err) => handleError(err, "stake"),
    onPending: () => { },
    onSuccess: () => { },
  });

  const stake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: "deposit",
    args: [ CLIENT_ID, tokenId || 0, parseUnits((amount || 0).toString(), 18), chains.l2.layerZero, 0n ],
    disabled:      !tokenId || !amount || depositFee == 0n,
    value: depositFee,
    onPending: () => { },
    onSuccess: (hash) => {
    },
    onError: (err) => handleError(err, "stake"),
  });

  const handleSubmit = useCallback(async () => {
    if (wrongChain) {
      handleSwitchChain()
    } else if (needsApproval) {
      await approve.call();
    } else {
      await stake.call();
    }
  }, [wrongChain, needsApproval, approve, stake]);

  const handleMaxClick = () => {
    if (balance) {
      setAmount(convertToText(balance, 18))
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base sm:text-lg font-bold text-white mb-1">Stake CAW</h3>
        <p className="text-gray-400 text-xs sm:text-sm">Earn rewards from protocol activity</p>
      </div>

      {/* Available Balance */}
      <div className="space-y-1 sm:space-y-2">
        <label className="flex items-center gap-1.5 sm:gap-2 text-white font-medium text-sm sm:text-base">
          <HiOutlineCollection className="w-4 h-4 sm:w-5 sm:h-5" />
          <span>Available Balance</span>
        </label>
        <div className="relative">
          <input
            type="text"
            value={balance ? convertToText(balance, 18) : "0"}
            readOnly
            className="w-full bg-transparent text-white px-3 sm:px-4 py-2 sm:py-3 rounded-lg border border-white/20 focus:border-white/40 focus:outline-none pr-12 sm:pr-16 text-sm sm:text-base"
          />
          <button
            onClick={handleMaxClick}
            className="absolute right-2 sm:right-3 top-1/2 transform -translate-y-1/2 text-yellow-400 hover:text-yellow-300 font-medium text-xs sm:text-sm"
          >
            Max
          </button>
        </div>
      </div>

      {/* Amount to Stake */}
      <div className="space-y-1 sm:space-y-2">
        <label className="flex items-center gap-1.5 sm:gap-2 text-white font-medium text-sm sm:text-base">
          <HiOutlineArrowUp className="w-4 h-4 sm:w-5 sm:h-5" />
          <span>Amount to Stake</span>
        </label>
        <div className="relative">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full bg-transparent text-white px-3 sm:px-4 py-2 sm:py-3 rounded-lg border border-white/20 focus:border-white/40 focus:outline-none pr-12 sm:pr-16 text-sm sm:text-base [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="absolute right-2 sm:right-3 top-1/2 transform -translate-y-1/2 text-gray-400 font-medium text-xs sm:text-sm">
            CAW
          </span>
        </div>
      </div>

      {/* Stake Button */}
      <button
        onClick={handleSubmit}
        disabled={!tokenId || (!needsApproval && (!amount || depositFee == 0n))}
        className={`w-full font-bold py-3 sm:py-4 px-4 sm:px-6 rounded-lg transition-colors duration-200 text-sm sm:text-base ${
          needsApproval || wrongChain
            ? 'bg-yellow-400 hover:bg-yellow-500 text-black'
            : 'bg-yellow-400 hover:bg-yellow-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-black'
        }`}
      >
        {wrongChain ? "Switch Network" : (needsApproval ? "Approve" : "Stake CAW")}
      </button>
    </div>
  )
}

/** Withdraw panel */
function UnstakePanel({ token }: { token?: TokenData }) {
  const { switchChain } = useSwitchChain();
  const handleSwitchChain = (network: string) => switchChain({ chainId: chains[network as keyof typeof chains].chainId });
  const signAndSubmit = useSignAndSubmitAction()
  const [ amount, setAmount ] = useState<string>("")
  const [ nativeFee, setFee ] = useState<bigint>(0n)
  const withdrawable = token?.withdrawable || 0;
  const { isConnected } = useAccount()

  const connections = useConnections();
  const isMainnet = connections[0]?.chainId == chains.l1.chainId;

  // quote withdraw fee on L2
  const { data: quote } = useReadContract({
    address:      CAW_NAMES_ADDRESS,
    abi:          cawNameAbi,
    functionName: "withdrawQuote",
    args:         [CLIENT_ID, false],
    query: {
      enabled: !!token
    }
  })

  const unstake = useContractCall({
    address: CAW_NAMES_ADDRESS,
    abi: cawNameAbi,
    functionName: "withdraw",
    args: [ CLIENT_ID, Number((token?.tokenId ?? 0n)), 0n ],
    disabled: !token?.tokenId || nativeFee == 0n,
    value: nativeFee,
    onPending: () => { },
    onSuccess: (hash) => {
    },
    onError: (err) => handleError(err, "stake"),
  });

  const handleWithdraw = async (event: React.FormEvent) => {
    if (!token) return
    event.preventDefault()
    try {
      if (!isMainnet) {
        handleSwitchChain("l1")
      } else {
        unstake.call();
      }
    } catch (err) {
      console.error('withdraw failed', err)
    }
  }

  const handleWithdrawInit = async (event: React.FormEvent) => {
    if (!token) return
    event.preventDefault()
    try {
      if (isMainnet) {
        handleSwitchChain("l2")
      } else {
        await signAndSubmit({
          senderId:        token.tokenId,
          actionType:      'withdraw',
          recipients: [token.tokenId],
          amounts: [BigInt(amount) * 10n**18n],
        })
      }
    } catch (err) {
      console.error('withdraw failed', err)
    }
  }

  useEffect(() => {
    if (quote?.nativeFee != null) setFee(BigInt(quote.nativeFee))
  }, [quote])

  const handleMaxClick = () => {
    if (token?.stakedAmount) {
      setAmount(convertToText(token.stakedAmount, 18))
    }
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base sm:text-lg font-bold text-white mb-1">Unstake CAW</h3>
        <p className="text-gray-400 text-xs sm:text-sm">Withdraw your staked CAW tokens</p>
      </div>

      {/* Pending Withdraw */}
      {token && token.withdrawable > 0n && (
        <div className="bg-yellow-400/10 border border-yellow-400/20 rounded-lg p-3 sm:p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-1.5 sm:gap-2">
                <HiOutlineExclamationCircle className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400" />
                <p className="text-yellow-400 font-medium text-sm sm:text-base">Pending Withdraw</p>
              </div>
              <p className="text-white text-base sm:text-lg font-bold">{convertToText(withdrawable, 18)} CAW</p>
            </div>
            {isConnected && (
              <button
                onClick={handleWithdraw}
                className="bg-yellow-400 hover:bg-yellow-500 text-black font-bold py-1.5 sm:py-2 px-3 sm:px-4 rounded-lg transition-colors duration-200 text-xs sm:text-sm"
              >
                {!isMainnet ? "Switch Network" : "Withdraw"}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Staked Amount */}
      <div className="space-y-1 sm:space-y-2">
        <label className="flex items-center gap-1.5 sm:gap-2 text-white font-medium text-sm sm:text-base">
          <HiOutlineCube className="w-4 h-4 sm:w-5 sm:h-5" />
          <span>Staked Amount</span>
        </label>
        <div className="relative">
          <input
            type="text"
            value={token?.stakedAmount ? convertToText(token.stakedAmount, 18) : "0"}
            readOnly
            className="w-full bg-transparent text-white px-3 sm:px-4 py-2 sm:py-3 rounded-lg border border-white/20 focus:border-white/40 focus:outline-none pr-12 sm:pr-16 text-sm sm:text-base"
          />
          <button
            onClick={handleMaxClick}
            className="absolute right-2 sm:right-3 top-1/2 transform -translate-y-1/2 text-yellow-400 hover:text-yellow-300 font-medium text-xs sm:text-sm"
          >
            Max
          </button>
        </div>
      </div>

      {/* Amount to Unstake */}
      <div className="space-y-1 sm:space-y-2">
        <label className="flex items-center gap-1.5 sm:gap-2 text-white font-medium text-sm sm:text-base">
          <HiOutlineMinus className="w-4 h-4 sm:w-5 sm:h-5" />
          <span>Amount to Unstake</span>
        </label>
        <div className="relative">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0"
            className="w-full bg-transparent text-white px-3 sm:px-4 py-2 sm:py-3 rounded-lg border border-white/20 focus:border-white/40 focus:outline-none pr-12 sm:pr-16 text-sm sm:text-base [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="absolute right-2 sm:right-3 top-1/2 transform -translate-y-1/2 text-gray-400 font-medium text-xs sm:text-sm">
            CAW
          </span>
        </div>
      </div>

      {/* Unstake Button */}
      <button
        onClick={handleWithdrawInit}
        disabled={!token?.tokenId || !amount}
        className={`w-full font-bold py-3 sm:py-4 px-4 sm:px-6 rounded-lg transition-colors duration-200 text-sm sm:text-base ${
          isMainnet
            ? 'bg-yellow-400 hover:bg-yellow-500 text-black'
            : 'bg-yellow-400 hover:bg-yellow-500 disabled:bg-gray-600 disabled:cursor-not-allowed text-black'
        }`}
      >
        {isMainnet ? "Switch Network" : "Initialize Withdrawal"}
      </button>
    </div>
  )
}

/** Info panel */
function InfoPanel() {
  return (
    <div className="space-y-4 sm:space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-base sm:text-lg font-bold text-white mb-1">Staking Information</h3>
        <p className="text-gray-400 text-xs sm:text-sm">Learn how CAW staking works</p>
      </div>

      {/* Info Cards */}
      <div className="space-y-3 sm:space-y-4">
        <div className="rounded-lg p-3 sm:p-4 border border-white/20">
          <div className="flex items-start gap-2 sm:gap-3">
            <div className="p-1.5 sm:p-2 rounded-lg border border-yellow-400/30">
              <HiOutlineCreditCard className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400" />
            </div>
            <div>
              <h4 className="text-white font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Username NFT Required</h4>
              <p className="text-gray-300 text-xs sm:text-sm">
                Staking CAW requires a minted username NFT, which will retain the staked amount and accrue rewards.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg p-3 sm:p-4 border border-white/20">
          <div className="flex items-start gap-2 sm:gap-3">
            <div className="p-1.5 sm:p-2 rounded-lg border border-yellow-400/30">
              <HiOutlineChartBar className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400" />
            </div>
            <div>
              <h4 className="text-white font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Automatic Rewards</h4>
              <p className="text-gray-300 text-xs sm:text-sm">
                With every action (CAW, RECAW, LIKE, FOLLOW, etc.) on the CAW Protocol, a small CAW fee is collected and automatically distributed to all CAW stakers in proportion to their deposits.
              </p>
            </div>
          </div>
        </div>

        <div className="rounded-lg p-3 sm:p-4 border border-white/20">
          <div className="flex items-start gap-2 sm:gap-3">
            <div className="p-1.5 sm:p-2 rounded-lg border border-yellow-400/30">
              <HiOutlineClock className="w-4 h-4 sm:w-5 sm:h-5 text-yellow-400" />
            </div>
            <div>
              <h4 className="text-white font-semibold mb-1 sm:mb-2 text-sm sm:text-base">Real-time Rewards</h4>
              <p className="text-gray-300 text-xs sm:text-sm">
                Rewards accrue in real time and can be withdrawn at any moment. No lock-up periods required.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Additional Info */}
      <div className="rounded-lg p-3 sm:p-4 border border-yellow-400/30">
        <h4 className="text-yellow-400 font-semibold mb-1 sm:mb-2 text-sm sm:text-base">💡 Pro Tip</h4>
        <p className="text-gray-300 text-xs sm:text-sm">
          The more CAW you stake, the higher your share of the protocol fees. Stake early to maximize your rewards!
        </p>
      </div>

      {/* Mobile Bottom Navbar */}
      <MobileBottomNavbar 
        activeTab="staking"
        onTabChange={(tab) => {}}
        isVisible={true}
      />
    </div>
  )
}

export { Staking }