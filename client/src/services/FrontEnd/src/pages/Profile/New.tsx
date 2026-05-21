// src/pages/NewProfile.tsx
import { SubmitButton } from "~/components/buttons/SubmitButton"
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useReadContract, useAccount, useSwitchChain } from 'wagmi'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import useAllowance from "~/hooks/useAllowance";
import { maxUint256, parseUnits, erc20Abi, formatEther, parseEther } from "viem";
import useContractCall, { UseContractCallReturn } from '~/hooks/useContractCall'
import { useLayoutStore } from '~/store/layoutStore'
import { CAW_ADDRESS, CAW_NAMES_MINTER_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_PAIR_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMinterAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { useActiveToken, useTokenDataStore, usePriceStore } from "~/store/tokenDataStore";
import { chains, isTestnet } from '~/config/chains'
import UsernameSvg from '~/components/UsernameSvg'
import { formatNumber, formatNumberCompact, convertToNumber } from "~/utils";
import { formatUsd } from '~/utils/numberFormat'
import { useSearchParams } from 'react-router-dom'
import { useNavigate, Link } from '~/utils/localizedRouter'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import { HiInformationCircle } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { CLIENT_ID, getTipTiers } from '~/api/actions'
import { useT } from '~/i18n/I18nProvider'
import { getDefaultSpendLimit, getDefaultTipCeiling, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { usePoolReserves, useMinCawOut, suggestedSlippageBps } from '~/hooks/useZapQuote'
import { useNetworkFees } from '~/hooks/useNetworkFees'
import NetworkFeeModal from '~/components/NetworkFeeModal'

// Quick Sign default scope: all actions except WITHDRAW (bit 6) — matches the
// 0xBF hard-wired on L2 in the bundled session register flow.
const QUICK_SIGN_DEFAULT_SCOPE = 0xBF

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

/**
 * Tap-aware popover for the (i) icon next to "Deposit CAW". The whole row
 * is wrapped in a <label> that toggles the deposit on click — so the icon
 * needs to stop propagation, otherwise tapping it on mobile flips the
 * deposit toggle. group-hover doesn't fire on touch devices either, so
 * we drive open/closed with click state and dismiss on tap-outside,
 * scroll, or 4s timeout.
 */
const DepositInfoPopover: React.FC = () => {
  const t = useT()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !ref.current?.contains(target)) setOpen(false)
    }
    const onScroll = () => setOpen(false)
    const autoHide = setTimeout(() => setOpen(false), 4000)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      clearTimeout(autoHide)
    }
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={t('new_profile.show_deposit_info')}
        onClick={(e) => {
          // Don't let the click bubble up to the wrapping <label>, which
          // would toggle the deposit-on/off switch.
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        // Hover-show on desktop preserves the original UX. Pointer events
        // fire on both, but the click handler above is what makes mobile
        // work — the hover handlers are pure additive niceness.
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex items-center cursor-help"
      >
        <HiInformationCircle className="w-4 h-4 text-gray-400" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-[min(450px,90vw)] bg-gray-900 rounded-lg shadow-lg"
          // Stop propagation here too — taps inside the info card shouldn't
          // toggle the deposit switch either.
          onClick={(e) => e.stopPropagation()}
        >
          <StakingRewardsInfo alwaysDark />
        </div>
      )}
    </div>
  )
}

export const NewProfile: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
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
  const { address, chainId }      = useAccount()
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

  // Pay-with-ETH (ZAP) flow: contract swaps ETH→CAW via Uniswap V2 in the
  // same tx and forwards into the existing mint+deposit pipeline. The
  // user enters ETH; we read pool reserves and compute slippage-floor minCawOut.
  const [paymentMode, setPaymentMode] = useState<'caw' | 'eth'>('caw')
  const [ethAmount, setEthAmount] = useState('')
  // Slippage slider — default scaled by trade size against the pool.
  const [slippageBps, setSlippageBps] = useState<number>(200)
  const [slippageAutoSet, setSlippageAutoSet] = useState(false)

  // Quick Sign session — bundle into the same L1 tx as mintAndDeposit. Default
  // ON so brand-new users get one-click posting after onboarding. The actual
  // session keypair is generated lazily, just before submit, so navigating
  // away doesn't burn an unused session in localStorage.
  const [quickSignEnabled, setQuickSignEnabled] = useState(true)
  const [quickSignExpanded, setQuickSignExpanded] = useState(true)
  const setSession = useSessionKeyStore(s => s.setSession)
  const setSessionEnabled = useSessionKeyStore(s => s.setEnabled)
  // Privately-held session params that are active for this submission.
  // Generated on submit (see handleSubmit) and held in BOTH a ref (for the
  // success-callback closure) and state (so the wagmi-hook args update).
  const sessionRef = useRef<{
    privateKey: `0x${string}`
    address: `0x${string}`
    spendLimit: bigint
    duration: number
    expiry: number
  } | null>(null)
  const [pendingSession, setPendingSession] = useState<{
    address: `0x${string}`
    expiry: number
    spendLimit: bigint
  } | null>(null)
  const [pendingMintAfterSession, setPendingMintAfterSession] = useState(false)
  const useAddress = address || activeToken?.owner;
  const setActiveTokenId = useTokenDataStore(state => state.setActiveTokenId);
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const [showFeeModal, setShowFeeModal] = useState(false)
  const networkFees = useNetworkFees(CLIENT_ID)

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

  // ETH-mode: parse input and quote against live pool reserves. The Quoter
  // gives us the LZ + storage fees; the swap leg is purely a frontend concern.
  const ethAmountWei = useMemo(() => {
    if (paymentMode !== 'eth' || !ethAmount) return 0n
    try { return parseEther(ethAmount) } catch { return 0n }
  }, [paymentMode, ethAmount])
  const reserves = usePoolReserves(CAW_PAIR_ADDRESS as `0x${string}`, chains.l1.chainId)
  // Auto-suggest a slippage tolerance that scales with trade size, but only
  // once per page session. After that the slider is the source of truth.
  useEffect(() => {
    if (slippageAutoSet || ethAmountWei === 0n || !reserves.loaded) return
    setSlippageBps(suggestedSlippageBps(ethAmountWei, reserves.wethReserve))
    setSlippageAutoSet(true)
  }, [slippageAutoSet, ethAmountWei, reserves.loaded, reserves.wethReserve])
  const zapQuote = useMinCawOut(ethAmountWei, reserves, slippageBps)


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


  const { data: balance } = useReadContract({
    address:      CAW_ADDRESS,
    abi:          erc20Abi,
    chainId: chains.l1.chainId,
    functionName: "balanceOf",
    args:         [ useAddress! ],
    query: { enabled: !!useAddress }
  })
console.log("BALANCE:", balance)

  // quote on‐chain LZ fee from CawProfileQuoter — switches between mint and mintAndDeposit.
  // When Quick Sign is ON alongside a deposit, use the bundled quote which
  // accounts for the larger LZ payload (extra session-key + expiry + spend args).
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
    query: { enabled: depositEnabled && depositAmountWei > 0n && !quickSignEnabled }
  })
  // Quote for the bundled mintAndDepositAndQuickSign flow. The selector picks
  // the larger LZ gas budget on L2, so we MUST use this when QS is enabled.
  // The Quoter's signature only needs `sessionKey` to know whether the bundled
  // selector applies; expiry/spendLimit don't affect LZ payload size.
  const { data: bundledQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintAndDepositAndQuickSignQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, depositAmountWei, chains.l2.layerZero, false, useAddress as `0x${string}` ?? '0x0000000000000000000000000000000000000001' ],
    query: { enabled: depositEnabled && depositAmountWei > 0n && quickSignEnabled }
  })

  // ZAP quotes — same on-chain LZ + storage fees as the CAW-paid path; the
  // swap leg is computed on the frontend from pool reserves. The Quoter
  // exposes thin wrappers so the frontend has one call per flow.
  const { data: mintAndDepositZapQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintAndDepositZapQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, chains.l2.layerZero, false ],
    query: { enabled: paymentMode === 'eth' && !quickSignEnabled }
  })
  const { data: bundledZapQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintAndDepositAndQuickSignZapQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, useAddress as `0x${string}` ?? '0x0000000000000000000000000000000000000001', chains.l2.layerZero, false ],
    query: { enabled: paymentMode === 'eth' && quickSignEnabled }
  })
  console.log('[New] mintAndDepositQuote:', { data: mintAndDepositQuote, error: mintAndDepositQuoteError?.message, loading: mintAndDepositQuoteLoading, enabled: depositEnabled && depositAmountWei > 0n, depositAmountWei: depositAmountWei.toString(), CLIENT_ID, layerZero: chains.l2.layerZero })
  const quote = paymentMode === 'eth'
    ? (quickSignEnabled ? bundledZapQuote : mintAndDepositZapQuote)
    : (!depositEnabled
        ? mintOnlyQuote
        : (quickSignEnabled ? bundledQuote : mintAndDepositQuote))

  const lzTokenAmount = 0n;
  const totalCawNeeded = cost + depositAmountWei;
  // CAW-mode: needs CAW balance for burn + deposit. ETH-mode: only needs ETH
  // (the swap output covers both burn and deposit), so we don't gate on CAW
  // balance there.
  const insufficientBalance = paymentMode === 'eth'
    ? false
    : (!balance || totalCawNeeded > balance);

  // Total ETH msg.value for the ZAP tx: swap-input + LZ/storage fees.
  const zapTxValue = useMemo(() => {
    if (paymentMode !== 'eth' || !quote) return 0n
    const nativeFee = (quote as { nativeFee?: bigint }).nativeFee ?? 0n
    return ethAmountWei + BigInt(nativeFee)
  }, [paymentMode, ethAmountWei, quote])

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

  // Minter needs allowance for burn cost + deposit amount (it pulls both from the user).
  // In ETH (ZAP) mode the user never spends CAW directly — the swap output IS
  // the CAW the contract uses — so no approval is needed.
  const minterAllowanceNeeded = cost + (depositEnabled ? depositAmountWei : 0n);
  const needsMinterApproval = paymentMode === 'eth'
    ? false
    : (!minterAllowance || minterAllowance == 0n || minterAllowanceNeeded > minterAllowance);
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
    disabled:     !depositEnabled || quickSignEnabled || !address || !isValid || needsApproval || depositAmountWei === 0n,
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

  // Quick Sign session params used by the bundled hook below. We update these
  // pieces of state right before calling the bundled mint so the wagmi hook's
  // `args` reflect the freshly-generated session keypair. Until generated,
  // the bundled hook is `disabled` so the placeholder zero address never
  // makes it into a real call.
  const qsExpiry = pendingSession?.expiry ?? Math.floor(Date.now() / 1000) + DEFAULT_SESSION_DURATION
  const qsSpendLimit = pendingSession?.spendLimit ?? (quickSignEnabled ? getDefaultSpendLimit() : 0n)
  const qsSessionAddress = pendingSession?.address ?? '0x0000000000000000000000000000000000000000' as `0x${string}`

  // hook into mintAndDepositAndQuickSign — bundled flow with session leg.
  const { call: mintAndDepositAndQuickSign, status: bundledStatus, gasCostEth: bundledGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mintAndDepositAndQuickSign',
    abi:      cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    // V2 added trailing perActionTipRate: uint64 — default to the "fast" tip
    // tier (BASE_VALIDATOR_TIP * 3 ≈ $0.003 / action at standard CAW pricing,
    // gives validators priority-lane compensation). Matches what the
    // standalone QuickSign flow uses by default.
    args:         [CLIENT_ID, username, depositAmountWei, chains.l2.layerZero, lzTokenAmount, qsSessionAddress, BigInt(qsExpiry), qsSpendLimit, getDefaultTipCeiling(getTipTiers().fast)],
    disabled:     !depositEnabled || !quickSignEnabled || !address || !isValid || needsApproval || depositAmountWei === 0n || qsSessionAddress === '0x0000000000000000000000000000000000000000',
    onPending:    hash => {
      console.log('mintAndDepositAndQuickSign tx pending', hash)
      setHasResetForm(false)
    },
    onSuccess:    async (hash) => {
      console.log('bundled mint+deposit+QuickSign succeeded!', hash)
      await refetchTokenData?.()
      const sess = sessionRef.current
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          setMintedTokenId(newToken.tokenId)
          setActiveTokenId(newToken.tokenId)
          setMintSuccess(true)
          // Persist deposit hint exactly like the non-QS branch.
          if (depositAmountWei > 0n) {
            try {
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
          // Persist the session locally + write a 'pending' localStorage hint so
          // useSessionKey-aware UI can fall back to it while the L2 mirror catches
          // up. Cleared when ChainSyncService indexes the SessionCreated event
          // (server-side) and the client refetches; for now keep both — the
          // session store is the source of truth for client-side action signing.
          if (sess && useAddress) {
            const owner = (useAddress as string).toLowerCase()
            try {
              setSession({
                privateKey: sess.privateKey,
                address: sess.address,
                ownerAddress: owner,
                expiry: sess.expiry,
                scopeBitmap: QUICK_SIGN_DEFAULT_SCOPE,
                spendLimit: sess.spendLimit.toString(),
              })
              setSessionEnabled(true)
              localStorage.setItem(
                `caw:pendingQuickSign:${owner}`,
                JSON.stringify({
                  sessionKey: sess.address,
                  expiry: sess.expiry,
                  spendLimit: sess.spendLimit.toString(),
                  txHash: hash,
                  submittedAt: Date.now(),
                })
              )
              window.dispatchEvent(new CustomEvent('caw:pendingQuickSignChanged', { detail: { owner } }))
            } catch (e) {
              console.warn('[New] failed to persist QuickSign session:', e)
            }
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

  // ============================================
  // ZAP hooks (pay-with-ETH variants)
  // ============================================
  // mintAndDepositZap — non-bundled ETH path. Same shape as mintAndDeposit
  // but pays with ETH; the contract swaps to CAW + burns name + deposits
  // remainder.
  const { call: mintAndDepositZap, status: mintAndDepositZapStatus, gasCostEth: mintAndDepositZapGas }: UseContractCallReturn = useContractCall({
    value: zapTxValue,
    functionName: 'mintAndDepositZap',
    abi: cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args: [CLIENT_ID, username, ethAmountWei, zapQuote.minCawOut, chains.l2.layerZero, lzTokenAmount],
    disabled: paymentMode !== 'eth' || quickSignEnabled || !address || !isValid || ethAmountWei === 0n || !zapQuote.loaded,
    onPending: hash => { console.log('mintAndDepositZap tx pending', hash); setHasResetForm(false) },
    onSuccess: async (hash) => {
      console.log('mintAndDepositZap success!', hash)
      await refetchTokenData?.()
      const checkForNewToken = async () => {
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
    onError: err => console.error(err),
  })

  // mintAndDepositAndQuickSignZap — bundled ETH + QuickSign onboarding.
  const { call: mintAndDepositAndQuickSignZap, status: bundledZapStatus, gasCostEth: bundledZapGas }: UseContractCallReturn = useContractCall({
    value: zapTxValue,
    functionName: 'mintAndDepositAndQuickSignZap',
    abi: cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    // V2 inserted perActionTipRate: uint64 between spendLimit and lzDestId.
    // Default to fast-tier tip (~$0.003 at ~$3.8e-8/CAW pricing) for parity
    // with the standalone QuickSign flow.
    args: [CLIENT_ID, username, ethAmountWei, zapQuote.minCawOut, qsSessionAddress, BigInt(qsExpiry), qsSpendLimit, getDefaultTipCeiling(getTipTiers().fast), chains.l2.layerZero, lzTokenAmount],
    disabled: paymentMode !== 'eth' || !quickSignEnabled || !address || !isValid || ethAmountWei === 0n || !zapQuote.loaded || qsSessionAddress === '0x0000000000000000000000000000000000000000',
    onPending: hash => { console.log('mintAndDepositAndQuickSignZap tx pending', hash); setHasResetForm(false) },
    onSuccess: async (hash) => {
      console.log('mintAndDepositAndQuickSignZap success!', hash)
      await refetchTokenData?.()
      const sess = sessionRef.current
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          setMintedTokenId(newToken.tokenId)
          setActiveTokenId(newToken.tokenId)
          setMintSuccess(true)
          if (sess && useAddress) {
            const owner = (useAddress as string).toLowerCase()
            try {
              setSession({
                privateKey: sess.privateKey,
                address: sess.address,
                ownerAddress: owner,
                expiry: sess.expiry,
                scopeBitmap: QUICK_SIGN_DEFAULT_SCOPE,
                spendLimit: sess.spendLimit.toString(),
              })
              setSessionEnabled(true)
              localStorage.setItem(
                `caw:pendingQuickSign:${owner}`,
                JSON.stringify({
                  sessionKey: sess.address,
                  expiry: sess.expiry,
                  spendLimit: sess.spendLimit.toString(),
                  txHash: hash,
                  submittedAt: Date.now(),
                })
              )
              window.dispatchEvent(new CustomEvent('caw:pendingQuickSignChanged', { detail: { owner } }))
            } catch (e) {
              console.warn('[New] failed to persist QuickSign session:', e)
            }
          }
        } else {
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }
      setTimeout(checkForNewToken, 1000)
    },
    onError: err => console.error(err),
  })

  // Unified status — pick from whichever path is active
  const mintStatus = paymentMode === 'eth'
    ? (quickSignEnabled ? bundledZapStatus : mintAndDepositZapStatus)
    : (depositEnabled
        ? (quickSignEnabled ? bundledStatus : mintAndDepositStatus)
        : mintOnlyStatus)
  const gasCostEth = paymentMode === 'eth'
    ? (quickSignEnabled ? bundledZapGas : mintAndDepositZapGas)
    : (depositEnabled
        ? (quickSignEnabled ? bundledGas : mintAndDepositGas)
        : mintOnlyGas)
  const mint = paymentMode === 'eth'
    ? (quickSignEnabled ? mintAndDepositAndQuickSignZap : mintAndDepositZap)
    : (depositEnabled
        ? (quickSignEnabled ? mintAndDepositAndQuickSign : mintAndDeposit)
        : mintOnly)

  const waiting = isApprovePending || Boolean(mintStatus.match(/pending/))

  // The "creating profile…" fullscreen takeover used to be expressed as
  // <MainLayout hideSidebars>; post-hoist MainLayout lives at the router
  // level and stays mounted, so we flip its hide-chrome flag imperatively
  // for the transient minting state and clear it on exit.
  //
  // Clearing is deferred via setTimeout(0) so that on a successful mint —
  // which both flips showMintingTakeover false AND fires navigate() to
  // /welcome/:username in the same React commit — the location update
  // propagates first. Without the defer, MainLayout re-renders one frame
  // with hideChromeOverride=false on the still-/usernames/new route AND
  // a now-non-captive activeToken (the new mint just landed in the
  // store), briefly flashing the full sidebar/topbar before the route
  // settles to /welcome and MainLayout unmounts entirely.
  const showMintingTakeover = !hasResetForm && (mintStatus === 'pending' || (mintStatus === 'success' && !mintSuccess))
  const setHideChromeOverride = useLayoutStore(s => s.setHideChromeOverride)
  useEffect(() => {
    if (showMintingTakeover) {
      setHideChromeOverride(true)
      return () => {
        setTimeout(() => setHideChromeOverride(false), 0)
      }
    }
  }, [showMintingTakeover, setHideChromeOverride])

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

  // Generate the Quick Sign session keypair lazily, just before the bundled
  // mint. We don't want to burn an unused session in localStorage if the user
  // changes their mind on the form. This sets `pendingSession` state which
  // re-renders, makes the wagmi hook's `args` reflect the session params, and
  // then a useEffect fires the actual mint call.
  const generatePendingSession = useCallback(() => {
    const privateKey = generatePrivateKey()
    const sessionAccount = privateKeyToAccount(privateKey)
    const spendLimit = getDefaultSpendLimit()
    const expiry = Math.floor(Date.now() / 1000) + DEFAULT_SESSION_DURATION
    sessionRef.current = {
      privateKey,
      address: sessionAccount.address as `0x${string}`,
      spendLimit,
      duration: DEFAULT_SESSION_DURATION,
      expiry,
    }
    setPendingSession({ address: sessionAccount.address as `0x${string}`, expiry, spendLimit })
  }, [])

  const doApproveOrMint = useCallback(async () => {
    if (needsMinterApproval) {
      console.log('[New] approving minter...')
      setIsApprovePending(true)
      await approveMinter();
    } else {
      console.log('[New] calling mint...', {
        depositEnabled,
        quickSignEnabled,
        hasQuote: !!quote,
        hasAddress: !!address,
        isValid,
        needsApproval,
        depositAmountWei: depositAmountWei.toString(),
      })
      // Bundled flow needs a session keypair generated first. Generate it,
      // wait for the hook's `args` to settle on the new address, then mint.
      // Triggered by either CAW-mode or ETH-mode bundled flows.
      const bundledActive = quickSignEnabled && (
        (paymentMode === 'caw' && depositEnabled) ||
        (paymentMode === 'eth' && ethAmountWei > 0n)
      )
      if (bundledActive && !pendingSession) {
        generatePendingSession()
        setPendingMintAfterSession(true)
        return
      }
      await mint();
    }
  }, [needsMinterApproval, approveMinter, mint, depositEnabled, quickSignEnabled, pendingSession, generatePendingSession, paymentMode, ethAmountWei]);

  // After session params land in state and the wagmi hook re-renders with the
  // fresh args, fire the actual mint call. Same pattern as
  // pendingMintAfterApproval / pendingSubmitAfterSwitch above.
  useEffect(() => {
    if (pendingMintAfterSession && pendingSession && !needsApproval) {
      setPendingMintAfterSession(false)
      mint()
    }
  }, [pendingMintAfterSession, pendingSession, needsApproval, mint])

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
        <span>{t('staking.button.switching')}</span>
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
          <span>{t('new_profile.creating')}</span>
        </div>
      )
    } else if (isApprovePending) {
      submitText = (
        <div className="flex items-center justify-center space-x-2">
          <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"/>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"/>
          </svg>
          <span>{t('staking.button.approving')}</span>
        </div>
      )
    } else {
      submitText = t('new_profile.processing')
    }
  } else if (usernameTaken)
    submitText = t('new_profile.username_taken')
  else if (insufficientBalance)
    submitText = t('staking.button.insufficient_balance')
  else if (paymentMode === 'eth') {
    if (ethAmountWei === 0n) submitText = "Enter ETH amount"
    else if (zapQuote.loaded && zapQuote.minCawOut < cost) submitText = "Increase ETH or reduce slippage"
    else submitText = "Create & Deposit (ETH)"
  }
  else submitText = depositEnabled && depositAmountWei > 0n ? t('new_profile.create_and_deposit') : t('new_profile.create')

  // Show loading screen while waiting for mint to complete. The
  // useLayoutStore effect above hides MainLayout's chrome for this state.
  if (showMintingTakeover) {
    return (
      <div className="min-h-screen flex items-start justify-center pt-12" ref={el => { if (el) window.scrollTo(0, 0) }}>
          <div className={`max-w-xl w-full mx-auto p-8 rounded-2xl backdrop-blur-[2px] ${
            isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-200/50 border-2 border-gray-300/50'
          }`}>
            <div className="text-center space-y-6">
              <h1 className={`text-4xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
                {mintStatus === 'pending' ? t('new_profile.creating_title') : t('new_profile.confirming_title')}
              </h1>
              <p className="text-gray-400 text-sm">{t('new_profile.creating_hint')}</p>

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
    )
  }

  return (
      <div
        className={`${isCaptive ? 'max-w-4xl' : 'max-w-md'} mx-auto p-6 ${isCaptive ? '' : 'space-y-4 mt-8'}`}
        style={isCaptive ? undefined : { paddingBottom: 'calc(var(--bottom-nav-h, 0px) + 24px)' }}
      >
        <div className={isCaptive ? 'flex flex-col md:flex-row gap-8 md:gap-0 items-start md:divide-x md:divide-white/10 pt-12 md:pt-20' : ''}>
          {/* Left column (captive) or full-width header (normal) */}
          <div className={isCaptive ? 'w-full md:w-[45%] md:sticky md:top-8 md:pr-8' : ''}>
            <div className={isCaptive ? `px-6 py-6 rounded-2xl backdrop-blur-sm ${isDark ? 'bg-white/[0.04] border border-white/10' : 'bg-black/[0.03] border border-black/10'}` : ''}>
              <div className="text-center space-y-3">
                <h1 className="text-4xl font-bold">{t('new_profile.create_profile_heading')}</h1>
                <p className="text-gray-400 text-sm mx-auto" style={{ width: '85%' }}>
                  {t('new_profile.create_profile_subtitle')}
                </p>
              </div>

              {/* Username SVG preview */}
              <div className={`flex justify-center items-center mb-6 ${isCaptive ? 'mt-6' : 'mt-16'}`}>
                  <div className="w-64 h-64 overflow-hidden" style={{ borderRadius: '22px' }}>
                      <UsernameSvg username={username || 'username'} textOpacity={username ? 1 : 0.5} />
                  </div>
              </div>
              <div className="text-center">
                {isTestnet ? (
                  <Link
                    to="/faucet"
                    className={`inline-flex items-center justify-center px-4 py-2 rounded-full text-sm font-semibold transition-colors cursor-pointer ${
                      isDark
                        ? 'bg-yellow-500/15 text-yellow-400 hover:bg-yellow-500/25'
                        : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
                    }`}
                  >
                    {t('new_profile.claim_mcaw')}
                  </Link>
                ) : (
                  <a
                    href="https://app.uniswap.org/#/swap?inputCurrency=ETH&outputCurrency=0xf3b9569F82B18aEf890De263B84189bd33EBe452"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-yellow-500/70 hover:text-yellow-500 transition-colors cursor-pointer"
                  >
                    {t('new_profile.need_more_caw')}
                  </a>
                )}

                <Link to="/usernames" className="block mt-2 text-sm text-gray-400 hover:text-gray-300 transition-colors">
                  {t('new_profile.marketplace_link')}
                </Link>
              </div>
            </div>
          </div>

          {/* Right column (captive) or continuation (normal) */}
          <div className={isCaptive ? 'w-full md:w-[55%] md:min-w-[380px] md:pl-8' : ''}>
            <div className={isCaptive ? `px-6 py-6 rounded-2xl backdrop-blur-sm ${isDark ? 'bg-white/[0.04] border border-white/10' : 'bg-black/[0.03] border border-black/10'}` : ''}>
            {isCaptive && (
              <h2 className="text-2xl font-bold text-center md:text-left mb-4 mt-2.5">{t('new_profile.choose_username_heading')}</h2>
            )}

        <div className={`${isCaptive ? '' : 'mt-16'} space-y-4`}>
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
                    placeholder={t('new_profile.placeholder.username')}
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
                            <div className={`absolute top-1/2 -translate-y-1/2 right-full mr-3 w-72 border rounded-lg p-5 z-50 ${
                              isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
                            }`}>
                                <div className={`text-sm font-medium text-center mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('new_profile.pricing_title')}</div>
                                <div className="space-y-2">
                                    {[
                                      { label: t('new_profile.chars.1'), cost: '1T' },
                                      { label: t('new_profile.chars.2'), cost: '240B' },
                                      { label: t('new_profile.chars.3'), cost: '60B' },
                                      { label: t('new_profile.chars.4'), cost: '6B' },
                                      { label: t('new_profile.chars.5'), cost: '200M' },
                                      { label: t('new_profile.chars.6'), cost: '20M' },
                                      { label: t('new_profile.chars.7'), cost: '10M' },
                                      { label: t('new_profile.chars.8plus'), cost: '1M' },
                                    ].map(({ label, cost }) => (
                                      <div key={label} className="flex justify-between text-xs items-center">
                                        <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>{label}</span>
                                        <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('new_profile.burn_cost', { cost })}</span>
                                      </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="flex justify-between items-center text-sm gap-2">
                {usernameTaken && username && typewriterStopped ? (
                  <div className="text-red-400 text-left">
                    {t('new_profile.already')}{' '}
                    <a
                      href={`/users/${username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline"
                    >
                      {t('new_profile.taken')}
                    </a>.
                  </div>
                ) : useAddress ? (
                  <div className="text-gray-400">
                    {t('new_profile.balance_label')} <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatNumberCompact(convertToNumber(balance))} CAW</span>
                  </div>
                ) : <div />}
                <div className="text-gray-400">
                    {t('new_profile.cost_label')} <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>{formatNumberCompact(convertToNumber(cost, 18))} CAW</span>
                    {costInDollars != null && <span className="text-gray-500 ml-1">(~${costInDollars < 0.01 ? '<0.01' : costInDollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})</span>}
                </div>
            </div>

            {/* Payment mode toggle: pay with CAW (default) or pay with ETH (ZAP).
                In ETH mode the contract swaps via Uniswap V2 in the same tx;
                slippage is enforced by minCawOut. */}
            <div className={`mt-4 flex items-center gap-2 rounded-full p-1 ${
              isDark ? 'bg-white/[0.04] border border-white/10' : 'bg-black/[0.03] border border-gray-200'
            }`}>
              <button
                type="button"
                onClick={() => setPaymentMode('caw')}
                className={`flex-1 py-2 text-sm font-medium rounded-full transition-colors cursor-pointer ${
                  paymentMode === 'caw'
                    ? (isDark ? 'bg-yellow-500 text-black' : 'bg-yellow-500 text-black')
                    : (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900')
                }`}
              >
                Pay with CAW
              </button>
              <button
                type="button"
                onClick={() => setPaymentMode('eth')}
                className={`flex-1 py-2 text-sm font-medium rounded-full transition-colors cursor-pointer ${
                  paymentMode === 'eth'
                    ? (isDark ? 'bg-yellow-500 text-black' : 'bg-yellow-500 text-black')
                    : (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-gray-900')
                }`}
              >
                Pay with ETH
              </button>
            </div>

            {/* ETH-mode input */}
            {paymentMode === 'eth' && (
              <div className={`border rounded-xl p-4 space-y-3 mt-3 ${
                isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
              }`}>
                <div className="text-sm font-medium">
                  ETH to spend
                  <span className={`block text-xs mt-0.5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    Burns the username cost, deposits the remainder. One tx.
                  </span>
                </div>
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
                {ethAmountWei > 0n && ethPrice > 0 && (
                  <div className={`text-xs ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    ~${formatUsd(Number(ethAmount) * ethPrice)}
                  </div>
                )}
                {ethAmountWei > 0n && reserves.loaded && (
                  <div className={`text-xs space-y-1 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                    {(() => {
                      const depositCaw = zapQuote.expectedCawOut > cost ? zapQuote.expectedCawOut - cost : 0n
                      const depositWhole = convertToNumber(depositCaw, 18)
                      const depositUsd = cawPrice > 0 ? depositWhole * cawPrice : null
                      return (
                        <div>
                          You&apos;ll deposit &asymp;&nbsp;
                          <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                            {formatNumberCompact(depositWhole)} CAW
                          </span>
                          {depositUsd != null && (
                            <span className="ml-1">(~${formatUsd(depositUsd)})</span>
                          )}
                        </div>
                      )
                    })()}
                    {zapQuote.minCawOut < cost && (
                      <div className="text-red-400">
                        Below the {formatNumberCompact(convertToNumber(cost, 18))} CAW burn cost — increase ETH.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* Deposit option (CAW mode only — in ETH mode the deposit is the
                swap-output remainder after burning the username cost, so there's
                no separate "deposit amount" to enter). */}
            {paymentMode === 'caw' && (
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
                    <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>{username ? t('new_profile.deposit_as', { username }) : t('staking.button.deposit')}</span>
                    <DepositInfoPopover />
                  </div>
                  <ul className="text-yellow-500/80 text-xs mt-0.5 list-disc list-outside pl-4 space-y-0.5">
                    <li>{t('new_profile.deposit.bullet1')}</li>
                    <li>{t('new_profile.deposit.bullet2')}</li>
                    <li>{t('new_profile.deposit.bullet3')}</li>
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
                      placeholder={t('new_profile.placeholder.deposit_amount')}
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
            )}

            {/* Quick Sign option — appears alongside any deposit-bearing flow
                (CAW-mode mintAndDeposit OR ETH-mode mintAndDepositZap, since
                both bundled selectors include the session leg). */}
            {((paymentMode === 'caw' && depositEnabled && depositAmountWei > 0n) ||
              (paymentMode === 'eth' && ethAmountWei > 0n)) && (
            <div className={`border rounded-xl p-4 space-y-3 mt-3 ${
              isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
            }`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <button
                  type="button"
                  onClick={() => { setQuickSignEnabled(!quickSignEnabled); setQuickSignExpanded(true) }}
                  className={`relative w-10 min-w-[40px] h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${
                    quickSignEnabled ? 'bg-yellow-500' : 'bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    quickSignEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
                <div className="flex-1">
                  <button
                    type="button"
                    onClick={() => setQuickSignExpanded(v => !v)}
                    className="text-left w-full"
                  >
                    <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Quick Sign — one-click posting</span>
                  </button>
                  <p className="text-yellow-500/80 text-xs mt-0.5">
                    Skip wallet popups for posts, likes, follows, and tips. Withdrawals always require your wallet.
                  </p>
                </div>
              </label>
              {quickSignEnabled && quickSignExpanded && (
                <div className={`text-xs space-y-1 pl-[52px] ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                  <div>Spend limit:&nbsp;
                    <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {formatNumberCompact(Number(qsSpendLimit))} CAW
                    </span>
                    <span className="text-gray-500 ml-1">(~$10)</span>
                  </div>
                  <div>Expires in:&nbsp;
                    <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {Math.round(DEFAULT_SESSION_DURATION / 86400)} days
                    </span>
                  </div>
                  <div className="text-gray-500">You can change these defaults later in Settings.</div>
                </div>
              )}
            </div>
            )}

            <SubmitButton
                onClick={handleSubmit}
                disabled={!!insufficientBalance || (wrongChain ? false : (
                  usernameTaken || waiting || !quote || !cost || cost == 0n ||
                  (paymentMode === 'eth' && (ethAmountWei === 0n || !zapQuote.loaded || zapQuote.minCawOut < cost))
                ))}
                className="btn btn-submit mt-0 transition-all duration-300"
            >
                {submitText}
            </SubmitButton>

            {insufficientBalance && !waiting && (
              <div className="text-center mt-2">
                {isTestnet ? (
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

            {/* Rolled-up network fee row */}
            {(() => {
              // Sum all protocol fees that apply to the current flow
              let protocolFeesWei = networkFees.mintFee ?? 0n
              if (depositEnabled || paymentMode === 'eth') {
                protocolFeesWei += networkFees.depositFee ?? 0n
              }
              if (quickSignEnabled && (depositEnabled || paymentMode === 'eth')) {
                protocolFeesWei += networkFees.authFee ?? 0n
              }
              const lzFeeWei = quote?.nativeFee ?? 0n
              const gasWei = gasCostEth != null ? BigInt(Math.round(gasCostEth * 1e18)) : 0n
              const totalWei = protocolFeesWei + lzFeeWei + gasWei
              const totalEth = Number(formatEther(totalWei))
              const totalUsd = ethPrice > 0 ? totalEth * ethPrice : null
              return (
                <div className="flex items-center justify-center gap-1 text-sm text-gray-500">
                  <span>Network fee:</span>
                  <span className={isDark ? 'text-white' : 'text-gray-900'}>
                    {totalUsd != null ? `~$${formatUsd(totalUsd)}` : '—'}
                  </span>
                  <button
                    type="button"
                    aria-label="Network fee details"
                    onClick={() => setShowFeeModal(true)}
                    className="flex items-center cursor-pointer text-gray-400 hover:text-yellow-500 transition-colors"
                  >
                    <HiInformationCircle className="w-4 h-4" />
                  </button>
                </div>
              )
            })()}

            <NetworkFeeModal
              isOpen={showFeeModal}
              onClose={() => setShowFeeModal(false)}
              networkId={CLIENT_ID}
              ethPrice={ethPrice}
              lzFeeWei={quote?.nativeFee ?? 0n}
            />
        </div>
            </div>
          </div>
        </div>
      </div>
  )
}

export default NewProfile
