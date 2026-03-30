// src/pages/NewProfile.tsx
import { SubmitButton } from "~/components/buttons/SubmitButton"
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useReadContract, useAccount, useConnections, useSwitchChain } from 'wagmi'
import useAllowance from "~/hooks/useAllowance";
import { maxUint256, parseUnits, erc20Abi } from "viem";
import MainLayout from '~/layouts/MainLayout'
import useContractCall, { UseContractCallReturn } from '~/hooks/useContractCall'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_MINTER_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawNameAbi, cawNameMinterAbi, cawNameQuoterAbi } from '~/../../../abi/generated'
import { useActiveToken, useTokenDataStore } from "~/store/tokenDataStore";
import { chains } from '~/config/chains'
import UsernameSvg from '~/components/UsernameSvg'
import { formatNumber, formatNumberCompact, convertToNumber } from "~/utils";
import { formatUnits } from "viem";
import BadgedIcon from '~/assets/images/badged.svg'
import { useNavigate } from 'react-router-dom'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import { HiInformationCircle } from 'react-icons/hi'

const CLIENT_ID = Number(import.meta.env.VITE_CLIENT_ID)

// cost schedule (raw CAW)
const COST_SCHEDULE: Record<number, bigint> = {
  1: 1000_000_000_000n,
  2:   240_000_000_000n,
  3:    60_000_000_000n,
  4:     6_000_000_000n,
  5:       200_000_000n,
  6:        20_000_000n,
  7:        10_000_000n,
}
const DEFAULT_COST = 1_000_000n  // 8+ chars

export const NewProfile: React.FC = () => {
  const { switchChain } = useSwitchChain();
  const [isSwitchingChain, setIsSwitchingChain] = useState(false);
  const handleSwitchChain = async () => {
    setIsSwitchingChain(true);
    try {
      await switchChain({ chainId: chains.l1.chainId });
    } catch (error) {
      console.error('Failed to switch chain:', error);
    } finally {
      setIsSwitchingChain(false);
    }
  };
  const navigate = useNavigate();
  const activeToken = useActiveToken();
  const { isConnected, address }      = useAccount()
  const [username, setUsername] = useState('')
  const [showPricingModal, setShowPricingModal] = useState(false)
  const [mintSuccess, setMintSuccess] = useState(false)
  const [mintedTokenId, setMintedTokenId] = useState<number | null>(null)
  const [hasResetForm, setHasResetForm] = useState(false)
  const [isApprovePending, setIsApprovePending] = useState(false)
  const [depositEnabled, setDepositEnabled] = useState(false)
  const [depositAmount, setDepositAmount] = useState('10000000')
  const useAddress = address || activeToken?.owner;
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);

  // Typewriter animation for captive users
  const isCaptive = !activeToken?.username
  const [typewriterStopped, setTypewriterStopped] = useState(false)
  const typewriterRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!isCaptive || typewriterStopped) return

    const words = ['choose', 'your', 'username']
    let wordIdx = 0
    let charIdx = 0
    let deleting = false
    let pausing = false

    const tick = () => {
      if (!isCaptive || typewriterStopped) return

      const word = words[wordIdx]

      if (pausing) {
        pausing = false
        deleting = true
        typewriterRef.current = setTimeout(tick, 60)
        return
      }

      if (!deleting) {
        charIdx++
        setUsername(word.slice(0, charIdx))
        if (charIdx >= word.length) {
          // Finished typing — pause then delete
          pausing = true
          typewriterRef.current = setTimeout(tick, wordIdx === words.length - 1 ? 1000 : 600)
          return
        }
        typewriterRef.current = setTimeout(tick, 100 + Math.random() * 60)
      } else {
        charIdx--
        setUsername(word.slice(0, charIdx))
        if (charIdx <= 0) {
          deleting = false
          const nextIdx = (wordIdx + 1) % words.length
          wordIdx = nextIdx
          // Extra pause after deleting "username" before looping
          typewriterRef.current = setTimeout(tick, nextIdx === 0 ? 1100 : 300)
          return
        }
        typewriterRef.current = setTimeout(tick, 55)
      }
    }

    typewriterRef.current = setTimeout(tick, 500)
    return () => { if (typewriterRef.current) clearTimeout(typewriterRef.current) }
  }, [isCaptive, typewriterStopped])

  const stopTypewriter = () => {
    if (!typewriterStopped) {
      setTypewriterStopped(true)
      if (typewriterRef.current) clearTimeout(typewriterRef.current)
      setUsername('')
    }
  }

  const depositAmountWei = useMemo(() => {
    if (!depositEnabled || !depositAmount) return 0n
    try { return parseUnits(depositAmount, 18) } catch { return 0n }
  }, [depositEnabled, depositAmount])


  // is valid username?
  const isValid = /^[a-z0-9]{1,}$/i.test(username)

  // cost in raw CAW (bigint)
  const cost = useMemo(() => {
    const len = username.length
    if (len === 0) return 0n
    return (COST_SCHEDULE[len as keyof typeof COST_SCHEDULE] ?? DEFAULT_COST) *10n**18n
  }, [username])

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address:      CAW_NAMES_MINTER_ADDRESS,
    abi:          cawNameMinterAbi,
    chainId: chains.l1.chainId,
    functionName: "idByUsername",
    args:         [username],
    query: { enabled: username.length > 0 }
  })

  const usernameTaken = !checkingUsername && !!existingId;


  const { data: balance, isLoading: balanceLoading } = useReadContract({
    address:      CAW_ADDRESS,
    abi:          erc20Abi,
    chainId: chains.l1.chainId,
    functionName: "balanceOf",
    args:         [ useAddress! ],
    query: { enabled: !!useAddress }
  })
console.log("BALANCE:", balance)

  // quote on‐chain LZ fee from CawNameQuoter — switches between mint and mintAndDeposit
  const { data: mintOnlyQuote } = useReadContract({
    abi: cawNameQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, false ],
    query: { enabled: !depositEnabled }
  })
  const { data: mintAndDepositQuote, error: mintAndDepositQuoteError, isLoading: mintAndDepositQuoteLoading } = useReadContract({
    abi: cawNameQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintAndDepositQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, depositAmountWei, chains.l2.layerZero, false ],
    query: { enabled: depositEnabled && depositAmountWei > 0n }
  })
  console.log('[New] mintAndDepositQuote:', { data: mintAndDepositQuote, error: mintAndDepositQuoteError?.message, loading: mintAndDepositQuoteLoading, enabled: depositEnabled && depositAmountWei > 0n, depositAmountWei: depositAmountWei.toString(), CLIENT_ID, layerZero: chains.l2.layerZero })
  const quote = depositEnabled ? mintAndDepositQuote : mintOnlyQuote

  const lzTokenAmount = 0n;
  const totalCawNeeded = cost + depositAmountWei;
  const insufficientBalance = !balance || totalCawNeeded > balance;

  const connections = useConnections();
  const wrongChain = connections[0]?.chainId != chains.l1.chainId;

  // Reset switching state when chain changes to correct one
  React.useEffect(() => {
    if (!wrongChain && isSwitchingChain) {
      setIsSwitchingChain(false);
    }
  }, [wrongChain, isSwitchingChain]);

  // Navigate to onboarding page once mint succeeds
  useEffect(() => {
    if (mintSuccess && mintedTokenId && username) {
      // Pass state indicating if we deposited (stake is pending via LayerZero)
      navigate(`/welcome/${username}`, {
        replace: true,
        state: { depositPending: depositEnabled && depositAmountWei > 0n }
      })
    }
  }, [mintSuccess, mintedTokenId, username, depositEnabled, depositAmountWei])

  const { allowance: minterAllowance, refetch: refetchMinterAllowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_MINTER_ADDRESS, useAddress);
  const { allowance: cawNameAllowance, refetch: refetchCawNameAllowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_ADDRESS, useAddress);
  const refetchTokenData = useTokenDataStore(s => s.refetchTokenData)

  // Minter needs allowance for burn cost; CawName needs allowance for deposit
  const needsMinterApproval = !minterAllowance || minterAllowance == 0n || cost > minterAllowance;
  const needsCawNameApproval = depositEnabled && depositAmountWei > 0n && (!cawNameAllowance || cawNameAllowance == 0n || depositAmountWei > cawNameAllowance);
  const needsApproval = needsMinterApproval || needsCawNameApproval;

  // Approve minter for burn
  const { call: approveMinter } = useContractCall({
    abi: erc20Abi,
    address: CAW_ADDRESS,
    functionName: "approve",
    args: [CAW_NAMES_MINTER_ADDRESS, maxUint256],
    disabled: wrongChain || !needsMinterApproval,
    onPending: () => setIsApprovePending(true),
    onSuccess: () => { setIsApprovePending(false); refetchMinterAllowance() },
    onError: () => setIsApprovePending(false),
  });

  // Approve CawName for deposit (only needed when depositing)
  const { call: approveCawName } = useContractCall({
    abi: erc20Abi,
    address: CAW_ADDRESS,
    functionName: "approve",
    args: [CAW_NAMES_ADDRESS, maxUint256],
    disabled: wrongChain || !needsCawNameApproval,
    onPending: () => setIsApprovePending(true),
    onSuccess: () => { setIsApprovePending(false); refetchCawNameAllowance() },
    onError: () => setIsApprovePending(false),
  });

  // hook into mint function (mint-only)
  const { call: mintOnly, status: mintOnlyStatus, gasCostEth: mintOnlyGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mint',
    abi:      cawNameMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, lzTokenAmount],
    disabled:     depositEnabled || !address || !isValid || needsApproval,
    onPending:    hash => {
      console.log('tx pending', hash)
      setHasResetForm(false)
    },
    onSuccess:    async (hash) => {
      console.log('minted!', hash)

      // Refetch token data from chain, then check for the new token
      await refetchTokenData?.()

      const checkForNewToken = () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())

        if (newToken) {
          setMintedTokenId(newToken.tokenId)
          setActiveTokenId(newToken.tokenId)
          setMintSuccess(true)
        } else {
          // Token data may not be processed yet, refetch and check again
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }

      // Give a moment for the refetch to process
      setTimeout(checkForNewToken, 1000)
    },
    onError:      err  => console.error(err),
  })

  // hook into mintAndDeposit function
  const { call: mintAndDeposit, status: mintAndDepositStatus, gasCostEth: mintAndDepositGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mintAndDeposit',
    abi:      cawNameMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, depositAmountWei, chains.l2.layerZero, lzTokenAmount],
    disabled:     !depositEnabled || !address || !isValid || needsApproval || depositAmountWei === 0n,
    onPending:    hash => {
      console.log('mintAndDeposit tx pending', hash)
      setHasResetForm(false)
    },
    onSuccess:    async (hash) => {
      console.log('minted and deposited!', hash)
      await refetchTokenData?.()
      const checkForNewToken = () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          setMintedTokenId(newToken.tokenId)
          setActiveTokenId(newToken.tokenId)
          setMintSuccess(true)
        } else {
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }
      setTimeout(checkForNewToken, 1000)
    },
    onError:      err  => console.error(err),
  })

  // Unified status — pick from whichever path is active
  const mintStatus = depositEnabled ? mintAndDepositStatus : mintOnlyStatus
  const gasCostEth = depositEnabled ? mintAndDepositGas : mintOnlyGas
  const mint = depositEnabled ? mintAndDeposit : mintOnly

  const waiting = isApprovePending || Boolean(mintStatus.match(/pending/))

  console.log('[New] mint disabled conditions:', {
    depositEnabled,
    quote: !!quote,
    address: !!address,
    isValid,
    needsApproval,
    needsMinterApproval,
    needsCawNameApproval,
    depositAmountWei: depositAmountWei.toString(),
    minterAllowance: minterAllowance?.toString(),
    cawNameAllowance: cawNameAllowance?.toString(),
    cost: cost?.toString(),
  })

  const handleSubmit = useCallback(async () => {
    console.log('[New] handleSubmit called', { wrongChain, needsMinterApproval, needsCawNameApproval })
    if (wrongChain) {
      handleSwitchChain()
    } else if (needsMinterApproval) {
      console.log('[New] approving minter...')
      await approveMinter();
    } else if (needsCawNameApproval) {
      console.log('[New] approving cawName...')
      await approveCawName();
    } else {
      console.log('[New] calling mint...', {
        depositEnabled,
        hasQuote: !!quote,
        hasAddress: !!address,
        isValid,
        needsApproval,
        depositAmountWei: depositAmountWei.toString(),
      })
      await mint();
    }
  }, [wrongChain, needsMinterApproval, needsCawNameApproval, approveMinter, approveCawName, mint, handleSwitchChain]);

  let submitText;
  if (isSwitchingChain) {
    submitText = (
      <div className="flex items-center justify-center space-x-2">
        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
        </svg>
        <span>Switching...</span>
      </div>
    )
  } else if (wrongChain)
    submitText = "Switch Network"
  else if (waiting) {
    if (mintStatus === 'pending') {
      submitText = (
        <div className="flex items-center justify-center space-x-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>Minting...</span>
        </div>
      )
    } else if (isApprovePending) {
      submitText = (
        <div className="flex items-center justify-center space-x-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>Approving...</span>
        </div>
      )
    } else {
      submitText = "Processing..."
    }
  } else if (needsMinterApproval)
    submitText = "Approve CAW"
  else if (needsCawNameApproval)
    submitText = "Approve Deposit"
  else if (usernameTaken)
    submitText = "username taken"
  else submitText = depositEnabled && depositAmountWei > 0n ? "Mint & Stake" : "Mint"

  // Show loading screen while waiting for mint to complete
  if (!hasResetForm && (mintStatus === 'pending' || (mintStatus === 'success' && !mintSuccess))) {
    return (
      <MainLayout>
        <div className="max-w-xl mx-auto p-6 space-y-4 mt-8">
          <div className="text-center space-y-6">
            <h1 className="text-4xl font-bold text-white">Creating your new profile...</h1>
            <p className="text-gray-400 text-sm">Your username will be minted as a tradeable and transferable NFT, and will live forever on the Ethereum Blockchain</p>

            {/* Show the username SVG with loader overlay */}
            <div className="flex justify-center items-center my-8">
              <div className="relative w-64 h-64 overflow-hidden" style={{ borderRadius: '22px' }}>
                <UsernameSvg username={username}/>
                {/* Loader overlay */}
                <div className="absolute inset-0 flex items-center justify-center">
                  <div className="w-16 h-16 rounded-full bg-black/60 flex items-center justify-center">
                    <svg className="animate-spin h-10 w-10 text-yellow-500" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
                    </svg>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4">
              {mintStatus === 'pending' && (
                <p className="text-gray-400">
                  Please confirm the transaction in your wallet...
                </p>
              )}
              {mintStatus === 'success' && (
                <p className="text-gray-400">
                  Please wait while your transaction is being processed on the blockchain...
                </p>
              )}
            </div>
          </div>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className={`max-w-md mx-auto p-6 ${isCaptive ? '' : 'space-y-4 mt-8'}`}>
        <div className="text-center space-y-3">
          <h1 className="text-4xl font-bold">Create a Profile</h1>
          <p className="text-gray-400 text-sm mx-auto" style={{ width: '85%' }}>
            Your username is a tradeable NFT that will be used to access your account and posts. Minting a username requires CAW to be burnt, fewer characters increase in cost and rarity.
          </p>
        </div>

        {/* Imagen generada del username - siempre visible */}
        <div className={`flex justify-center items-center mb-6 ${isCaptive ? 'mt-8' : 'mt-16'}`}>
            <div className="w-64 h-64 overflow-hidden" style={{ borderRadius: '22px' }}>
                <UsernameSvg username={username}/>
            </div>
        </div>

        <div className={`${isCaptive ? 'mt-12' : 'mt-16'} space-y-4`}>
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                </div>
                <input
                    type="text"
                    value={username}
                    pattern="[A-Za-z0-9]*"
                    onChange={e => { stopTypewriter(); setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '')); }}
                    onFocus={stopTypewriter}
                    className="w-full pl-10 pr-12 py-3 bg-black border border-white/20 rounded-full text-white placeholder-white/50 focus:outline-none focus:border-white/30 focus:bg-black transition-all duration-300"
                    placeholder="Enter your username"
                />
                <div className="absolute inset-y-0 right-0 pr-3 flex items-center">
                    <div 
                        className="relative"
                        onMouseEnter={() => setShowPricingModal(true)}
                        onMouseLeave={() => setShowPricingModal(false)}
                    >
                        <button 
                            className="text-gray-400 hover:text-white transition-colors duration-200"
                        >
                            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                        </button>
                        
                        {/* Modal de precios */}
                        {showPricingModal && (
                            <div className="absolute bottom-full right-0 mb-6 w-72 bg-black border border-white/20 rounded-lg p-5 shadow-xl z-50">
                                <div className="text-sm font-medium text-center text-white mb-3">Username Pricing</div>
                                <div className="space-y-2">
                                    {[
                                      { label: '1 Character', cost: '1T' },
                                      { label: '2 Characters', cost: '240B' },
                                      { label: '3 Characters', cost: '60B' },
                                      { label: '4 Characters', cost: '6B' },
                                      { label: '5 Characters', cost: '200M' },
                                      { label: '6 Characters', cost: '20M' },
                                      { label: '7 Characters', cost: '10M' },
                                      { label: '8+ Characters', cost: '1M' },
                                    ].map(({ label, cost }) => (
                                      <div key={label} className="flex justify-between text-xs items-center">
                                        <span className="text-gray-300">{label}</span>
                                        <span className="font-mono text-white">BURN {cost} CAW</span>
                                      </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-center text-sm">
                <div className="text-gray-400">
                    Balance: <span className="font-mono text-white">{formatNumberCompact(convertToNumber(balance))} CAW</span>
                </div>
                <div className="text-gray-400">
                    Cost: <span className="font-mono text-white">{formatNumber(convertToNumber(cost, 18),0)} CAW</span>
                </div>
            </div>

            {/* Deposit option */}
            <div className="border border-white/10 rounded-xl p-4 space-y-3">
              <label className="flex items-center gap-3 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setDepositEnabled(!depositEnabled)}
                  className={`relative w-10 h-6 rounded-full transition-colors duration-200 cursor-pointer ${
                    depositEnabled ? 'bg-yellow-500' : 'bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    depositEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
                <div>
                  <div className="flex items-center gap-1.5">
                  <span className="text-white text-sm font-medium">{username ? `Stake CAW as @${username}` : 'Stake CAW'}</span>
                  <div className="relative group">
                    <HiInformationCircle className="w-4 h-4 text-gray-400 cursor-help" />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 w-[min(450px,100vw)] bg-gray-900 rounded-lg shadow-lg">
                      <StakingRewardsInfo alwaysDark />
                    </div>
                  </div>
                  </div>
                  <p className="text-gray-500 text-xs mt-0.5">This is required to enable posting, liking, following and all other actions</p>
                </div>
              </label>

              {depositEnabled && (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={depositAmount}
                      onChange={e => setDepositAmount(e.target.value.replace(/[^0-9.]/g, ''))}
                      placeholder="Amount to stake"
                      className="w-full px-4 py-2.5 bg-black border border-white/20 rounded-full text-white placeholder-white/30 focus:outline-none focus:border-white/30 text-sm"
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm">CAW</span>
                  </div>
                  <div className="flex gap-2">
                    {['1000000', '10000000', '100000000', '1000000000', '10000000000'].map(preset => {
                      const active = depositAmount === preset
                      const label = Number(preset) >= 1_000_000_000 ? `${Number(preset) / 1_000_000_000}B` : `${Number(preset) / 1_000_000}M`
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setDepositAmount(preset)}
                          className={`flex-1 py-1.5 text-xs rounded-full border transition-colors cursor-pointer ${
                            active
                              ? 'border-yellow-500 text-yellow-400'
                              : 'border-white/10 text-gray-400 hover:text-white hover:border-white/30'
                          }`}
                        >
                          {label}
                        </button>
                      )
                    })}
                  </div>
                  {depositAmountWei > 0n && (
                    <div className="text-xs text-gray-500 text-center">
                      Total CAW needed: <span className="text-white font-mono">{formatNumber(convertToNumber(totalCawNeeded, 18), 0)}</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            <SubmitButton
                onClick={handleSubmit}
                disabled={wrongChain ? false : (usernameTaken || waiting || !quote || (!needsApproval && (!cost || cost == 0n || !!insufficientBalance)))}
                className="btn btn-submit mt-0 transition-all duration-300"
            >
                {submitText}
            </SubmitButton>

            <div className="text-center">
              <a
                href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors cursor-pointer"
              >
                Need more CAW? Click here.
              </a>
            </div>

            {gasCostEth != null && (
                <div className="text-sm text-gray-500 text-center">
                    est. gas: {gasCostEth.toFixed(4)} ETH
                </div>
            )}
        </div>
      </div>
    </MainLayout>
  )
}

export default NewProfile

