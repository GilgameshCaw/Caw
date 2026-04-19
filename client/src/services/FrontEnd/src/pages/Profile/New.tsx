// src/pages/NewProfile.tsx
import { SubmitButton } from "~/components/buttons/SubmitButton"
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useReadContract, useAccount, useSwitchChain } from 'wagmi'
import useAllowance from "~/hooks/useAllowance";
import { maxUint256, parseUnits, erc20Abi, formatEther } from "viem";
import MainLayout from '~/layouts/MainLayout'
import useContractCall, { UseContractCallReturn } from '~/hooks/useContractCall'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_MINTER_ADDRESS, CAW_NAME_QUOTER_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileAbi, cawProfileMinterAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { useActiveToken, useTokenDataStore, usePriceStore } from "~/store/tokenDataStore";
import { chains } from '~/config/chains'
import UsernameSvg from '~/components/UsernameSvg'
import { formatNumber, formatNumberCompact, convertToNumber } from "~/utils";
import { formatUnits } from "viem";
import BadgedIcon from '~/assets/images/badged.svg'
import { useNavigate, Link, useSearchParams } from 'react-router-dom'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import { HiInformationCircle } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

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
  const { isDark } = useTheme()
  const { switchChain } = useSwitchChain();
  const [isSwitchingChain, setIsSwitchingChain] = useState(false);
  const handleSwitchChain = async (): Promise<boolean> => {
    setIsSwitchingChain(true);
    try {
      await switchChain({ chainId: chains.l1.chainId });
      return true;
    } catch (error) {
      console.error('Failed to switch chain:', error);
      return false;
    } finally {
      setIsSwitchingChain(false);
    }
  };
  const navigate = useNavigate();
  const activeToken = useActiveToken();
  const { isConnected, address, chainId }      = useAccount()
  const [searchParams] = useSearchParams()
  const [username, setUsername] = useState(() => {
    // Allow pre-filling via ?username=foo (e.g. from "claim this profile" links)
    const prefill = searchParams.get('username') || ''
    return prefill.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
  })
  const [showPricingModal, setShowPricingModal] = useState(false)
  const [mintSuccess, setMintSuccess] = useState(false)
  const [mintedTokenId, setMintedTokenId] = useState<number | null>(null)
  const [hasResetForm, setHasResetForm] = useState(false)
  const [isApprovePending, setIsApprovePending] = useState(false)
  const [pendingMintAfterApproval, setPendingMintAfterApproval] = useState(false)
  const [pendingSubmitAfterSwitch, setPendingSubmitAfterSwitch] = useState(false)
  const [depositEnabled, setDepositEnabled] = useState(true)
  const [depositAmount, setDepositAmount] = useState('')
  const [depositDefaultSet, setDepositDefaultSet] = useState(false)
  const useAddress = address || activeToken?.owner;
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)

  // Dollar presets for staking — converted to CAW amounts
  const DOLLAR_PRESETS = [10, 25, 50, 100]
  const dollarToCaw = (dollars: number) => cawPrice > 0 ? Math.round(dollars / cawPrice) : 0

  // Set default deposit to $25 worth of CAW once price loads — but only if the
  // user hasn't typed anything yet. Otherwise a late-arriving price (e.g. after
  // wallet connect triggers a refetch) would clobber their entered amount.
  useEffect(() => {
    if (!depositDefaultSet && cawPrice > 0 && !depositAmount) {
      setDepositAmount(String(dollarToCaw(25)))
      setDepositDefaultSet(true)
    }
  }, [cawPrice, depositDefaultSet, depositAmount])

  // Typewriter animation for captive users
  const isCaptive = !activeToken?.username
  const [typewriterStopped, setTypewriterStopped] = useState(false)
  const typewriterRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const usernameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!isCaptive || typewriterStopped) return

    const words = ['choose', 'your', 'username']
    let wordIdx = 0
    let charIdx = 0
    let deleting = false
    let pausing = false
    let cycles = 0

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
          if (nextIdx === 0) {
            cycles++
            if (cycles >= 2) {
              // Stop after 2 full cycles, focus the input
              setTypewriterStopped(true)
              setUsername('')
              setTimeout(() => usernameInputRef.current?.focus(), 100)
              return
            }
          }
          // Extra pause after deleting "username" before looping
          typewriterRef.current = setTimeout(tick, nextIdx === 0 ? 1100 : 300)
          return
        }
        typewriterRef.current = setTimeout(tick, 63)
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

  const costInDollars = useMemo(() => {
    if (!cost || cost === 0n) return null
    const cawAmount = convertToNumber(cost, 18)
    return cawPrice > 0 ? (cawAmount * cawPrice) : null
  }, [cost, cawPrice])

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address:      CAW_NAMES_MINTER_ADDRESS,
    abi:          cawProfileMinterAbi,
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

  // quote on‐chain LZ fee from CawProfileQuoter — switches between mint and mintAndDeposit
  const { data: mintOnlyQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, false ],
    query: { enabled: !depositEnabled }
  })
  const { data: mintAndDepositQuote, error: mintAndDepositQuoteError, isLoading: mintAndDepositQuoteLoading } = useReadContract({
    abi: cawProfileQuoterAbi,
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

  const wrongChain = chainId !== chains.l1.chainId;

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
        state: { pendingDeposit: depositEnabled && depositAmountWei > 0n ? depositAmountWei.toString() : null }
      })
    }
  }, [mintSuccess, mintedTokenId, username, depositEnabled, depositAmountWei])

  const { allowance: minterAllowance, refetch: refetchMinterAllowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_MINTER_ADDRESS, useAddress);
  const refetchTokenData = useTokenDataStore(s => s.refetchTokenData)

  // Minter needs allowance for burn cost + deposit amount (it pulls both from the user)
  const minterAllowanceNeeded = cost + (depositEnabled ? depositAmountWei : 0n);
  const needsMinterApproval = !minterAllowance || minterAllowance == 0n || minterAllowanceNeeded > minterAllowance;
  const needsApproval = needsMinterApproval;

  // Approve minter for burn + deposit (single approval handles both)
  const { call: approveMinter } = useContractCall({
    abi: erc20Abi,
    address: CAW_ADDRESS,
    functionName: "approve",
    args: [CAW_NAMES_MINTER_ADDRESS, maxUint256],
    disabled: wrongChain || !needsMinterApproval,
    onPending: () => setIsApprovePending(true),
    onSuccess: async () => {
      setIsApprovePending(false)
      await refetchMinterAllowance()
      setPendingMintAfterApproval(true)
    },
    onError: () => setIsApprovePending(false),
  });

  // hook into mint function (mint-only)
  const { call: mintOnly, status: mintOnlyStatus, gasCostEth: mintOnlyGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mint',
    abi:      cawProfileMinterAbi,
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
    abi:      cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, depositAmountWei, chains.l2.layerZero, lzTokenAmount],
    disabled:     !depositEnabled || !address || !isValid || needsApproval || depositAmountWei === 0n,
    onPending:    hash => {
      console.log('mintAndDeposit tx pending', hash)
      setHasResetForm(false)
    },
    onSuccess:    async (hash) => {
      console.log('minted and deposited!', hash)
      // Refetch token data from chain, then check for the new token
      await refetchTokenData?.()
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          setMintedTokenId(newToken.tokenId)
          setActiveTokenId(newToken.tokenId)
          setMintSuccess(true)
          // Deposit info (lastStakedAt / pendingDepositAmount) is persisted by
          // WelcomePage after /api/users/ensure so the follow buttons rendered
          // in the onboarding stepper see it before the user can click them.
          // Also write a localStorage hint so the profile chooser can render
          // the "+X CAW pending" badge instantly without waiting for the API.
          if (depositAmountWei > 0n) {
            try {
              // Capture the true L2 baseline from cawBalanceOf. For a fresh
              // mint this should be 0 (the tokenId didn't exist on L2 yet),
              // but we call the helper anyway so all three deposit paths
              // (mint&deposit, stake page, onboarding deposit) follow the
              // same ground-truth-from-L2 pattern.
              const { readOnChainStakeForHint } = await import('~/api/actions')
              const onChainBaseline = await readOnChainStakeForHint(newToken.tokenId)
              localStorage.setItem(
                `caw:pendingDeposit:${newToken.tokenId}`,
                JSON.stringify({
                  amount: depositAmountWei.toString(),
                  txHash: hash,
                  at: Date.now(),
                  stakedAtHintTime: onChainBaseline.toString(),
                })
              )
              window.dispatchEvent(new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId: newToken.tokenId } }))
            } catch {}
          }
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
    depositAmountWei: depositAmountWei.toString(),
    minterAllowance: minterAllowance?.toString(),
    cost: cost?.toString(),
    minterAllowanceNeeded: minterAllowanceNeeded.toString(),
  })

  const doApproveOrMint = useCallback(async () => {
    if (needsMinterApproval) {
      console.log('[New] approving minter...')
      setIsApprovePending(true)
      await approveMinter();
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
  }, [needsMinterApproval, approveMinter, mint]);

  // After a chain switch completes and wagmi hooks re-render with the correct
  // chain, auto-trigger the approve/mint flow so it's one-click for the user.
  useEffect(() => {
    if (pendingSubmitAfterSwitch && !wrongChain) {
      setPendingSubmitAfterSwitch(false)
      doApproveOrMint()
    }
  }, [pendingSubmitAfterSwitch, wrongChain, doApproveOrMint])

  // After approval completes and allowance refetches, auto-trigger mint
  // so the user gets the next signature popup without clicking again.
  useEffect(() => {
    if (pendingMintAfterApproval && !needsApproval) {
      setPendingMintAfterApproval(false)
      mint()
    }
  }, [pendingMintAfterApproval, needsApproval, mint])

  const handleSubmit = useCallback(async () => {
    console.log('[New] handleSubmit called', { wrongChain, needsMinterApproval })
    if (wrongChain) {
      const switched = await handleSwitchChain()
      if (!switched) return
      // Don't continue here — the closure has stale hook values from the old chain.
      // Set a flag so a useEffect picks up after re-render with fresh state.
      setPendingSubmitAfterSwitch(true)
      return
    }
    await doApproveOrMint()
  }, [wrongChain, needsMinterApproval, handleSwitchChain, doApproveOrMint]);

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
  } else if (waiting) {
    if (mintStatus === 'pending') {
      submitText = (
        <div className="flex items-center justify-center space-x-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>Creating...</span>
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
  } else if (usernameTaken)
    submitText = "username taken"
  else if (insufficientBalance)
    submitText = "Insufficient Balance"
  else submitText = depositEnabled && depositAmountWei > 0n ? "Create & Deposit" : "Create"

  // Show loading screen while waiting for mint to complete
  if (!hasResetForm && (mintStatus === 'pending' || (mintStatus === 'success' && !mintSuccess))) {
    return (
      <MainLayout hideSidebars>
        <div className="min-h-screen flex items-start justify-center pt-12" ref={el => { if (el) window.scrollTo(0, 0) }}>
          <div className={`max-w-xl w-full mx-auto p-8 rounded-2xl backdrop-blur-[2px] ${
            isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-200/50 border-2 border-gray-300/50'
          }`}>
            <div className="text-center space-y-6">
              <h1 className={`text-4xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                {mintStatus === 'pending' ? 'Creating your new profile...' : 'Confirming on the blockchain...'}
              </h1>
              <p className="text-gray-400 text-sm">Your username will be created as a tradeable and transferable NFT, and will live forever on the Ethereum Blockchain</p>

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

              {depositEnabled && depositAmountWei > 0n && (
                <p className="text-yellow-500 text-sm">{Number(depositAmount).toLocaleString()} CAW deposit pending</p>
              )}

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
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className={`${isCaptive ? 'max-w-4xl' : 'max-w-md'} mx-auto p-6 ${isCaptive ? '' : 'space-y-4 mt-8'}`}>
        <div className={isCaptive ? 'flex flex-col md:flex-row gap-8 md:gap-0 items-start md:divide-x md:divide-white/10 pt-12 md:pt-20' : ''}>
          {/* Left column (captive) or full-width header (normal) */}
          <div className={isCaptive ? 'w-full md:w-1/2 md:sticky md:top-8 md:pr-10' : ''}>
            <div className="text-center space-y-3">
              <h1 className="text-4xl font-bold">Create a Profile</h1>
              <p className="text-gray-400 text-sm mx-auto" style={{ width: '85%' }}>
                Your username is a tradeable NFT that will be used to access your account and posts. Creating a profile requires CAW tokens to be burnt, fewer characters increase in cost and rarity.
              </p>
            </div>

            {/* Username SVG preview */}
            <div className={`flex justify-center items-center mb-6 ${isCaptive ? 'mt-6' : 'mt-16'}`}>
                <div className="w-64 h-64 overflow-hidden" style={{ borderRadius: '22px' }}>
                    <UsernameSvg username={username || 'username'} textOpacity={username ? 1 : 0.5} />
                </div>
            </div>
            <div className="text-center">
              <a
                href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors cursor-pointer"
              >
                Need more CAW? Click here.
              </a>
              <Link to="/usernames" className="block mt-2 text-sm text-gray-400 hover:text-gray-300 transition-colors">
                Username Marketplace &rarr;
              </Link>
            </div>
          </div>

          {/* Right column (captive) or continuation (normal) */}
          <div className={isCaptive ? 'w-full md:w-1/2 md:pl-[55px]' : ''}>
            {isCaptive && (
              <h2 className="text-2xl font-bold text-center md:text-left mb-4 mt-2.5">Choose Your Username</h2>
            )}

        <div className={`${isCaptive ? '' : 'mt-16'} space-y-4`}>
            {usernameTaken && username && (
              <div className="text-sm text-red-400 text-left">
                This username{' '}
                <a
                  href={`/users/${username}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline"
                >
                  is taken
                </a>.
              </div>
            )}
            <div className="relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                    <svg className="h-5 w-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                    </svg>
                </div>
                <input
                    ref={usernameInputRef}
                    type="text"
                    value={username}
                    pattern="[A-Za-z0-9]*"
                    onChange={e => { stopTypewriter(); setUsername(e.target.value.toLowerCase().replace(/[^a-z0-9]/g, '')); }}
                    onFocus={stopTypewriter}
                    className={`w-full pl-10 pr-12 py-3 rounded-full focus:outline-none transition-all duration-300 ${
                      isDark
                        ? 'bg-black border border-white/20 text-white placeholder-white/50 focus:border-white/30 focus:bg-black'
                        : 'bg-gray-100 border border-gray-300 text-black placeholder-gray-400 focus:border-gray-400 focus:bg-white'
                    }`}
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
                            <div className={`absolute top-1/2 -translate-y-1/2 right-full mr-3 w-72 border rounded-lg p-5 shadow-xl z-50 ${
                              isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
                            }`}>
                                <div className={`text-sm font-medium text-center mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>Username Pricing</div>
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
                                        <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>{label}</span>
                                        <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>BURN {cost} CAW</span>
                                      </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-center text-sm">
                {useAddress ? (
                  <div className="text-gray-400">
                    Balance: <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatNumberCompact(convertToNumber(balance))} CAW</span>
                  </div>
                ) : <div />}
                <div className="text-gray-400">
                    Cost: <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatNumberCompact(convertToNumber(cost, 18))} CAW</span>
                    {costInDollars != null && <span className="text-gray-500 ml-1">(~${costInDollars < 0.01 ? '<0.01' : costInDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>}
                </div>
            </div>

            {/* Deposit option */}
            <div className={`border rounded-xl p-4 space-y-3 mt-6 ${
              isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
            }`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setDepositEnabled(!depositEnabled)}
                  className={`relative w-10 min-w-[40px] h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${
                    depositEnabled ? 'bg-yellow-500' : 'bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    depositEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
                <div>
                  <div className="flex items-center gap-1.5">
                  <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{username ? `Deposit CAW as @${username}` : 'Deposit CAW'}</span>
                  <div className="relative group">
                    <HiInformationCircle className="w-4 h-4 text-gray-400 cursor-help" />
                    <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 hidden group-hover:block z-50 w-[min(450px,100vw)] bg-gray-900 rounded-lg shadow-lg">
                      <StakingRewardsInfo alwaysDark />
                    </div>
                  </div>
                  </div>
                  <ul className="text-yellow-500/80 text-xs mt-0.5 list-disc list-outside pl-4 space-y-0.5">
                    <li>Required to post, like, and follow</li>
                    <li>You earn tokens from every action on the protocol based on your deposit</li>
                    <li>The more you deposit, the more you earn</li>
                  </ul>
                </div>
              </label>

              {depositEnabled && (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={depositAmount ? depositAmount.replace(/\B(?=(\d{3})+(?!\d))/g, ',') : ''}
                      onChange={e => { setDepositAmount(e.target.value.replace(/[^0-9]/g, '')); setDepositDefaultSet(true) }}
                      placeholder="Amount to deposit"
                      className={`w-full px-4 py-2.5 rounded-full focus:outline-none text-sm ${
                        isDark
                          ? 'bg-black border border-white/20 text-white placeholder-white/30 focus:border-white/30'
                          : 'bg-white border border-gray-300 text-black placeholder-gray-400 focus:border-gray-400'
                      }`}
                    />
                    <span className="absolute right-4 top-1/2 -translate-y-1/2 text-gray-500 text-sm">CAW</span>
                  </div>
                  <div className="flex justify-between items-center text-xs text-gray-500 px-1">
                    <span>
                      {depositAmountWei > 0n && cawPrice > 0
                        ? `~$${(convertToNumber(depositAmountWei, 18) * cawPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
                        : ''}
                    </span>
                    <span>
                      {balance !== undefined
                        ? `Available: ${formatNumber(convertToNumber(balance, 18), 0)} CAW`
                        : ''}
                    </span>
                  </div>
                  <div className="flex gap-2">
                    {DOLLAR_PRESETS.map(dollars => {
                      const cawAmount = dollarToCaw(dollars)
                      const cawStr = String(cawAmount)
                      const active = depositAmount === cawStr
                      return (
                        <button
                          key={dollars}
                          type="button"
                          onClick={() => setDepositAmount(cawStr)}
                          disabled={cawPrice <= 0}
                          className={`flex-1 py-1.5 text-xs rounded-full border transition-colors cursor-pointer ${
                            active
                              ? 'border-yellow-500 text-yellow-400'
                              : isDark
                                ? 'border-white/10 text-gray-400 hover:text-white hover:border-white/30'
                                : 'border-[#BBB] text-gray-600 hover:text-gray-900 hover:border-gray-500'
                          } disabled:opacity-30 disabled:cursor-not-allowed`}
                        >
                          ${dollars}
                        </button>
                      )
                    })}
                    <button
                      type="button"
                      onClick={() => {
                        if (balance && balance > cost) {
                          const maxDeposit = balance - cost
                          // Convert wei to whole tokens (floor to avoid rounding issues)
                          setDepositAmount(String(maxDeposit / 10n**18n))
                        }
                      }}
                      disabled={!balance || balance <= cost}
                      className={`flex-1 py-1.5 text-xs rounded-full border transition-colors cursor-pointer ${
                        isDark
                          ? 'border-white/10 text-gray-400 hover:text-white hover:border-white/30'
                          : 'border-[#BBB] text-gray-600 hover:text-gray-900 hover:border-gray-500'
                      } disabled:opacity-30 disabled:cursor-not-allowed`}
                    >
                      Max
                    </button>
                  </div>
                  {depositAmountWei > 0n && (
                    <div className="text-xs text-gray-500 text-center">
                      Total CAW needed: <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatNumber(convertToNumber(totalCawNeeded, 18), 0)}</span>
                      {cawPrice > 0 && <span className="text-gray-500 ml-1">(~${(convertToNumber(totalCawNeeded, 18) * cawPrice).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>}
                    </div>
                  )}
                </div>
              )}
            </div>

            <SubmitButton
                onClick={handleSubmit}
                disabled={!!insufficientBalance || (wrongChain ? false : (usernameTaken || waiting || !quote || !cost || cost == 0n))}
                className="btn btn-submit mt-0 transition-all duration-300"
            >
                {submitText}
            </SubmitButton>

            {insufficientBalance && !waiting && (
              <div className="text-center mt-2">
                {chains.l1.chainId === 11155111 ? (
                  <Link
                    to="/faucet"
                    className={`text-sm font-medium transition-colors ${isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-700 hover:text-yellow-600'}`}
                  >
                    Get mCAW from the faucet &rarr;
                  </Link>
                ) : (
                  <a
                    href="https://app.uniswap.org/explore/tokens/ethereum/0xf3b9569f82b18aef890de263b84189bd33ebe452"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={`text-sm font-medium transition-colors ${isDark ? 'text-yellow-500 hover:text-yellow-400' : 'text-yellow-700 hover:text-yellow-600'}`}
                  >
                    Buy CAW on Uniswap &rarr;
                  </a>
                )}
              </div>
            )}

            {gasCostEth != null && (() => {
                const totalEth = gasCostEth + Number(formatEther(quote?.nativeFee ?? 0n))
                return (
                    <div className="text-sm text-gray-500 text-center">
                        est. gas+fees: {totalEth.toFixed(4)} ETH{ethPrice > 0 && ` (~$${(totalEth * ethPrice).toFixed(2)})`}
                        <span className="block text-xs mt-0.5 opacity-60">
                            Half of all fees are used to buy and burn CAW
                        </span>
                    </div>
                )
            })()}
        </div>
          </div>
        </div>
      </div>
    </MainLayout>
  )
}

export default NewProfile

