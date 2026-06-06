// src/pages/NewProfile.tsx
import { SubmitButton } from "~/components/buttons/SubmitButton"
import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useReadContract, useAccount, useSwitchChain, useBalance, usePublicClient } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import useAllowance from "~/hooks/useAllowance";
import { maxUint256, parseUnits, erc20Abi, formatEther, parseEther, parseEventLogs } from "viem";
import useContractCall, { UseContractCallReturn } from '~/hooks/useContractCall'
import { useLayoutStore } from '~/store/layoutStore'
import { CAW_ADDRESS, CAW_NAMES_ADDRESS, CAW_NAMES_MINTER_ADDRESS, CAW_NAME_QUOTER_ADDRESS, CAW_PAIR_ADDRESS } from '~/../../../abi/addresses'
import { cawProfileMinterAbi, cawProfileQuoterAbi } from '~/../../../abi/generated'
import { useActiveToken, useTokenDataStore, usePriceStore } from "~/store/tokenDataStore";
import { chains, isTestnet } from '~/config/chains'
import UsernameSvg from '~/components/UsernameSvg'
import { formatNumber, formatNumberCompact, convertToNumber } from "~/utils";
import { formatUsd } from '~/utils/numberFormat'
import { useSearchParams } from 'react-router-dom'
import { useNavigate, Link } from '~/utils/localizedRouter'
import StakingRewardsInfo from '~/components/StakingRewardsInfo'
import QuickSignHowItWorks from '~/components/QuickSignHowItWorks'
import { HiInformationCircle, HiCheckCircle } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { CLIENT_ID, getTipTiers, getCurrentValidatorMinTipWei } from '~/api/actions'
import { apiFetch, IndexingError } from '~/api/client'
import { useValidatorMinTips } from '~/hooks/useValidatorMinTips'
import { useT } from '~/i18n/I18nProvider'
import { getDefaultSpendLimit, getDefaultTipCeiling, DEFAULT_SESSION_DURATION } from '~/hooks/useSessionKey'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { usePoolReserves, useMinCawOut, suggestedSlippageBps } from '~/hooks/useZapQuote'
import { useNetworkFees } from '~/hooks/useNetworkFees'
import NetworkFeeModal from '~/components/NetworkFeeModal'
import EthSpendInput from '~/components/EthSpendInput'

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

const ERC721_TRANSFER_ABI = [{
  type: 'event' as const, name: 'Transfer',
  inputs: [
    { name: 'from', type: 'address', indexed: true },
    { name: 'to', type: 'address', indexed: true },
    { name: 'tokenId', type: 'uint256', indexed: true },
  ],
}] as const

/**
 * Compute the four quick-pick dollar amounts for the "Pay with ETH" tab.
 *
 * Rule: when the username's USD cost is < $25, return the default
 * starter set ($20/$50/$100/$300). Otherwise pick a step matched to
 * the cost's order of magnitude, round the cost UP to the next multiple
 * of that step, and emit 4 consecutive multiples starting there.
 *
 * Worked examples (cost → buttons):
 *   $256    → $500, $1k, $1.5k, $2k       (step $500)
 *   $1,234  → $1.5k, $2k, $2.5k, $3k      (step $500)
 *   $2,560  → $3k, $3.5k, $4k, $4.5k      (step $500)
 *   $10,143 → $12k, $14k, $16k, $18k      (step $2k)
 *   $42,123 → $45k, $50k, $55k, $60k      (step $5k)
 */
function ethQuickPicksForUsernameCost(costUsd: number | null): number[] {
  const DEFAULT = [20, 50, 100, 300]
  if (costUsd == null || costUsd < 25) return DEFAULT

  // Step size by order of magnitude.
  let step: number
  if (costUsd < 5_000) step = 500
  else if (costUsd < 20_000) step = 2_000
  else if (costUsd < 100_000) step = 5_000
  else step = 20_000

  // Round cost UP to next multiple of step. If costUsd is already an
  // exact multiple, bump by one step so the first button leaves at least
  // some headroom above the username cost (otherwise clicking the first
  // option would mint with effectively zero deposit).
  let firstButton = Math.ceil(costUsd / step) * step
  if (firstButton === costUsd) firstButton += step
  return [0, 1, 2, 3].map(i => firstButton + i * step)
}

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

/**
 * Tap-aware popover for the (i) next to "Quick Sign — one-click actions".
 * Same pattern as DepositInfoPopover — sits inside the wrapping <label>,
 * so the click handler stops propagation to avoid toggling the Quick Sign
 * switch when the user taps the icon.
 */
const QuickSignInfoPopover: React.FC = () => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !ref.current?.contains(target)) setOpen(false)
    }
    const onScroll = () => setOpen(false)
    // 12s is plenty of reading time without the popover lingering forever.
    const autoHide = setTimeout(() => setOpen(false), 12000)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      clearTimeout(autoHide)
    }
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label="How Quick Sign works"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex items-center cursor-help"
      >
        <HiInformationCircle className="w-4 h-4 text-gray-400" />
      </button>
      {open && (
        <div
          // Style mirrors DepositInfoPopover for visual parity: dark
          // bg-gray-900 outer card, the shared QuickSignHowItWorks
          // component (also used in Settings + onboarding) renders its
          // own padded content. Position above the icon so it doesn't
          // overflow when the section sits near the bottom of the page.
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-[min(450px,90vw)] bg-gray-900 rounded-lg shadow-lg"
          onClick={(e) => e.stopPropagation()}
        >
          <QuickSignHowItWorks isDark />
        </div>
      )}
    </div>
  )
}

/** Format a tiny USD amount with a deliberate round-DOWN at the last shown
 *  digit so $0.001 shows as "$0.0009" — visually smaller, never misleadingly
 *  rounding up. Used in the Tip/action display and the validators popover. */
function formatTipUsd(usd: number): string {
  if (usd <= 0) return '$0'
  if (usd < 0.01) {
    // 4-decimal display, round down by subtracting 1 at the 4th decimal
    const v = Math.max(1, Math.floor(usd * 10000) - 1) / 10000
    return `$${v.toFixed(4)}`
  }
  const v = Math.max(0.001, Math.floor(usd * 1000) - 1) / 1000
  return `$${v.toFixed(3)}`
}

/**
 * Tap-aware popover for the (i) next to "Tip / action" in the Quick Sign
 * expanded row. Explains the ETH-pegged tip mechanism + lists discovered
 * mirrors with their published min-tip floors so users can see how many
 * validators will accept their actions.
 */
const TipPerActionPopover: React.FC<{ isDark: boolean }> = ({ isDark }) => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { minTipsMap, total } = useValidatorMinTips()

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !ref.current?.contains(target)) setOpen(false)
    }
    const onScroll = () => setOpen(false)
    const autoHide = setTimeout(() => setOpen(false), 12000)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      clearTimeout(autoHide)
    }
  }, [open])

  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label="How tipping works"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen(v => !v) }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex items-center cursor-help"
      >
        <HiInformationCircle className="w-3.5 h-3.5 text-gray-400" />
      </button>
      {open && (
        <div
          className={`absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-[min(360px,90vw)] rounded-lg shadow-lg p-3 text-left text-xs ${
            isDark ? 'bg-gray-900 text-white/90' : 'bg-white text-gray-800 border border-gray-200'
          }`}
          onClick={(e) => e.stopPropagation()}
        >
          <p className="mb-2 font-medium">How tipping works</p>
          <ul className={`space-y-1.5 mb-3 list-disc pl-4 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
            <li>Each action pays a small tip to the validator that processes it.</li>
            <li>Validators publish their floor in <span className="font-semibold">ETH terms</span>, not CAW.</li>
            <li>On-chain, an oracle converts the ETH-pegged rate to CAW at the current market price.</li>
            <li>Result: the dollar amount stays roughly constant even as CAW's price moves.</li>
          </ul>
          {total > 0 ? (
            <div>
              <p className="mb-1 font-medium">Discovered validators ({total}):</p>
              <ul className="space-y-0.5 font-mono text-[11px]">
                {Array.from(minTipsMap.entries()).map(([url, wei]) => {
                  let host = url
                  try { host = new URL(url).hostname } catch {}
                  const tipUsd = ethPrice > 0 && wei > 0n ? (Number(wei) / 1e18) * ethPrice : null
                  return (
                    <li key={url} className="flex justify-between gap-2">
                      <span className="truncate">{host}</span>
                      <span className={isDark ? 'text-white/70' : 'text-gray-600'}>
                        {tipUsd != null
                          ? `~${formatTipUsd(tipUsd)}`
                          : (wei === 0n ? 'free' : '—')}
                      </span>
                    </li>
                  )
                })}
              </ul>
            </div>
          ) : (
            <p className={`text-[11px] italic ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              No other validators discovered yet. They'll appear here once registered on-chain.
            </p>
          )}
        </div>
      )}
    </div>
  )
}

/**
 * Tap-aware popover for the (i) next to "Authenticate with this network".
 * Explains the auth gate + reassures users that names are still tradeable
 * without paying the auth fee.
 */
const AuthInfoPopover: React.FC = () => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !ref.current?.contains(target)) setOpen(false)
    }
    const onScroll = () => setOpen(false)
    const autoHide = setTimeout(() => setOpen(false), 12000)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      clearTimeout(autoHide)
    }
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label="How network authentication works"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v) }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex items-center cursor-help"
      >
        <HiInformationCircle className="w-4 h-4 text-gray-400" />
      </button>
      {open && (
        <div
          className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 z-50 w-[min(380px,90vw)] bg-gray-900 rounded-lg shadow-lg p-4 text-xs text-gray-200 space-y-2"
          onClick={(e) => e.stopPropagation()}
        >
          <p>
            Only users who authenticate with a network and pay its auth fee can
            interact on that network (post, like, follow, etc).
          </p>
          <p className="text-gray-400">
            Usernames can still be bought and sold on the marketplace without
            authenticating. You can authenticate later from your profile settings.
          </p>
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
  const publicClient = usePublicClient()
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

  // Quick Sign is delegated per OWNER ADDRESS, not per profile — one device
  // session covers every profile the address owns. So if the connected wallet
  // already has a live (non-expired) session, a freshly-minted profile under
  // the same address inherits it; there's nothing to enable here. Detect that
  // and render the toggle as on + locked with a cross-profile explanation,
  // rather than offering to set up a redundant session. We check the raw
  // sessions map (not getActiveSessionForAddress, which also requires the key
  // to be unlocked) — a locked-but-valid session still counts as "enabled".
  const sessionsByWallet = useSessionKeyStore(s => s.sessions)
  const hasExistingSessionForAddress = useMemo(() => {
    if (!address) return false
    const raw = sessionsByWallet[address.toLowerCase()]
    // Key purely on "a non-expired session exists for this address" — NOT on
    // the global `enabled` preference (that's "use session keys vs. sign every
    // action", orthogonal to whether a session exists to inherit).
    return !!raw && raw.expiry > Date.now() / 1000
  }, [sessionsByWallet, address])

  // When a session already exists for this address, don't bundle a redundant
  // session leg into the mint tx — route through the plain (non-QS) contract
  // path. The toggle still RENDERS as on (inherited), but quickSignEnabled,
  // which drives the bundled selector / hooks, must be false so we mint via
  // mintAndDeposit(Zap) rather than mintAndDepositAndQuickSign(Zap).
  useEffect(() => {
    if (hasExistingSessionForAddress) setQuickSignEnabled(false)
  }, [hasExistingSessionForAddress])

  // Authenticate-with-network toggle (mint-only / no-deposit path on CAW mode).
  // When deposit is ON, auth is always bundled (no contract path skips auth on
  // mintAndDeposit). Default ON when the Network charges an authFee — matches
  // the historic always-auth behavior; user can flip OFF to mint just the
  // username (marketplace-tradeable) without paying the auth fee.
  const [authEnabled, setAuthEnabled] = useState(true)
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

  // Quick-pick dollar buttons on the "Pay with ETH" tab. Default starter
  // set when the username's USD cost is small; otherwise scales to a
  // sequence that starts above the username cost.
  //
  // While the captive typewriter is animating the username field, freeze
  // the buttons so they don't flicker through 4-5 different value tiers
  // as the typewriter types each new word.
  const ethQuickPickDollarsRef = useRef<number[]>([20, 50, 100, 300])
  const ethQuickPickDollars = useMemo(() => {
    const animating = isCaptive && !typewriterStopped
    if (animating) return ethQuickPickDollarsRef.current
    const next = ethQuickPicksForUsernameCost(costInDollars)
    ethQuickPickDollarsRef.current = next
    return next
  }, [costInDollars, isCaptive, typewriterStopped])

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address:      CAW_NAMES_MINTER_ADDRESS,
    abi:          cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: "idByUsername",
    args:         [username],
    query: { enabled: username.length > 0 }
  })

  const usernameTaken = !checkingUsername && !!existingId;

  const { data: ethBalanceData } = useBalance({
    address,
    chainId: chains.l1.chainId,
    query: { enabled: !!address && paymentMode === 'eth' },
  })

  const { openConnectModal } = useConnectModal()


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
    query: { enabled: !depositEnabled && !authEnabled }
  })
  const { data: mintAndAuthQuote } = useReadContract({
    abi: cawProfileQuoterAbi,
    chainId: chains.l1.chainId,
    functionName: "mintAndAuthQuote",
    address: CAW_NAME_QUOTER_ADDRESS,
    args: [ CLIENT_ID, chains.l2.layerZero, false ],
    query: { enabled: !depositEnabled && authEnabled }
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
        ? (authEnabled ? mintAndAuthQuote : mintOnlyQuote)
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
  // Pad +2% for genuine LZ price-feed drift between quote read and
  // submit (multi-block delay). Excess refunds via _refundUnusedLzEth.
  const zapTxValue = useMemo(() => {
    if (paymentMode !== 'eth' || !quote) return 0n
    const nativeFee = (quote as { nativeFee?: bigint }).nativeFee ?? 0n
    const paddedFee = (BigInt(nativeFee) * 102n) / 100n
    return ethAmountWei + paddedFee
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
      // Clear any stale "stepper-dismissed" marker for this username. If the
      // user previously minted+dismissed and now re-minted the same name
      // (testnet redeploy, name purchased back after expiry, …) the marker
      // would short-circuit WelcomePage to /home before tokensByAddress has
      // the new token — AuthGate then bounces them to the captive splash.
      // A fresh mint is always intent to see the welcome flow.
      try { localStorage.removeItem(`caw:onboardingExited:${username}`) } catch {}
      // Pass state indicating if we deposited (stake is pending via LayerZero),
      // plus the freshly-decoded tokenId. WelcomePage normally derives the
      // tokenId from tokensByAddress, but right after an optimistic mint that
      // store hasn't been populated by the indexer yet (the whole point of the
      // fast-path). Handing the tokenId through location.state lets WelcomePage
      // proceed immediately and call /api/users/ensure { fromChain: true }
      // instead of stalling — and bouncing to /home unauthed — until the
      // indexer catches up.
      navigate(`/welcome/${username}`, {
        replace: true,
        state: {
          pendingDeposit: depositEnabled && depositAmountWei > 0n ? depositAmountWei.toString() : null,
          mintedTokenId,
        }
      })
    }
  }, [mintSuccess, mintedTokenId, username, depositEnabled, depositAmountWei])

  const { allowance: minterAllowance, refetch: refetchMinterAllowance } = useAllowance(CAW_ADDRESS, CAW_NAMES_MINTER_ADDRESS, useAddress);
  const refetchTokenData = useTokenDataStore(s => s.refetchTokenData)

  // ── Fast-path helpers ────────────────────────────────────────────────────
  // Decode the minted tokenId from the Transfer(0x0 → owner) log emitted by
  // the CawNames contract. Returns null on any error (missing receipt, wrong
  // contract, no matching log).
  const decodeMintTokenId = useCallback(async (hash: `0x${string}`): Promise<number | null> => {
    if (!publicClient || !address) return null
    try {
      const receipt = await publicClient.getTransactionReceipt({ hash })
      const logs = parseEventLogs({ abi: ERC721_TRANSFER_ABI, logs: receipt.logs })
      const mintLog = logs.find(
        (l) =>
          l.address.toLowerCase() === CAW_NAMES_ADDRESS.toLowerCase() &&
          (l.args as any).from === '0x0000000000000000000000000000000000000000' &&
          (l.args as any).to?.toLowerCase() === address.toLowerCase()
      )
      if (!mintLog) return null
      return Number((mintLog.args as any).tokenId)
    } catch (e) {
      console.warn('[New] decodeMintTokenId failed:', e)
      return null
    }
  }, [publicClient, address])

  // Warm the DB row in the background. POST /api/users/ensure returns 202 on a
  // miss and pokes NftTransferWatcher (via Redis) to index this tokenId
  // immediately rather than on its next poll cycle; we retry until it lands so
  // the row is warm by the time WelcomePage / the first post need it. No chain
  // read happens in the request path — the watcher does it out-of-band.
  const ensureUserFromChain = useCallback(async (tokenId: number): Promise<boolean> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await apiFetch('/api/users/ensure', {
          method: 'POST',
          body: JSON.stringify({ tokenId }),
        })
        return true
      } catch (err) {
        if (err instanceof IndexingError) {
          if (attempt < 4) {
            await new Promise(r => setTimeout(r, 1500))
            continue
          }
          return false
        } else {
          console.warn('[New] ensureUserFromChain error:', err)
          return false
        }
      }
    }
    return false
  }, [])

  // Returns the numeric tokenId as soon as the L1 receipt is decoded.
  // Previously this also blocked on /api/users/ensure (server-side L1 read +
  // retries) which can stall 30–60s when the indexer / L1 RPC are slow. The
  // user only cares about "is my mint confirmed?" — the on-chain receipt
  // already answers that. We fire ensureUserFromChain in the background so
  // WelcomePage's own /api/users/ensure call finds the row warm; we don't
  // gate the takeover-dismiss on it.
  const resolveMintedTokenId = useCallback(async (hash: `0x${string}`): Promise<number | null> => {
    const tokenId = await decodeMintTokenId(hash)
    if (tokenId === null) return null
    ensureUserFromChain(tokenId).catch(() => { /* WelcomePage retries */ })
    return tokenId
  }, [decodeMintTokenId, ensureUserFromChain])

  // Write the `caw:pendingDeposit:<tokenId>` hint that the onboarding stepper
  // and ProfileChooser read to credit a still-pending (LayerZero-in-flight)
  // deposit against the stake gates. CRITICAL: this is synchronous — the
  // amount lands in localStorage before the caller flips setMintSuccess (which
  // navigates to /welcome and mounts the stepper). The stepper reads the hint
  // once, non-reactively, on mount; a late write would be missed and the user
  // would see "need to stake 30K" despite a pending deposit. We seed the L2
  // baseline at "0" (correct for a fresh mint — the tokenId didn't exist on L2
  // yet) and refine it async best-effort; the amount is all the gate needs.
  const writePendingDepositHint = useCallback((tokenId: number, amountWei: bigint, txHash: string) => {
    try {
      localStorage.setItem(
        `caw:pendingDeposit:${tokenId}`,
        JSON.stringify({ amount: amountWei.toString(), txHash, at: Date.now(), stakedAtHintTime: '0' })
      )
      window.dispatchEvent(new CustomEvent('caw:pendingDepositChanged', { detail: { tokenId } }))
    } catch { /* localStorage unavailable — gate falls back to chain reads */ }
    // Best-effort async refinement of the L2 baseline (used later to detect
    // when the deposit lands). Never blocks the hint write above.
    ;(async () => {
      try {
        const { readOnChainStakeForHint } = await import('~/api/actions')
        const onChainBaseline = await readOnChainStakeForHint(tokenId)
        const raw = localStorage.getItem(`caw:pendingDeposit:${tokenId}`)
        if (!raw) return
        const parsed = JSON.parse(raw)
        parsed.stakedAtHintTime = onChainBaseline.toString()
        localStorage.setItem(`caw:pendingDeposit:${tokenId}`, JSON.stringify(parsed))
      } catch { /* baseline is best-effort */ }
    })()
  }, [])
  // ── End fast-path helpers ────────────────────────────────────────────────

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

  // Shared post-mint success handler (mintOnly + mintAndAuth share the same
  // "find the new token, navigate to /welcome" tail).
  const onMintOnlySuccess = async (hash: `0x${string}`) => {
    console.log('minted!', hash)

    // Fast path: decode tokenId from receipt + ensure server row via L1 read
    const applySuccess = (resolvedTokenId: number) => {
      setMintedTokenId(resolvedTokenId)
      setActiveTokenId(resolvedTokenId)
      setMintSuccess(true)
    }
    const fastTokenId = await resolveMintedTokenId(hash)
    if (fastTokenId !== null) {
      applySuccess(fastTokenId)
      return
    }

    // Fallback: username-polling loop
    await refetchTokenData?.()
    const checkForNewToken = () => {
      const allTokens = useTokenDataStore.getState().allTokens()
      const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
      if (newToken) {
        applySuccess(newToken.tokenId)
      } else {
        refetchTokenData?.()
        setTimeout(checkForNewToken, 3000)
      }
    }
    setTimeout(checkForNewToken, 1000)
  }

  // hook into mint function (mint-only, no auth)
  const { call: mintOnly, status: mintOnlyStatus, gasCostEth: mintOnlyGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mint',
    abi:      cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, lzTokenAmount],
    disabled:     paymentMode === 'eth' || depositEnabled || authEnabled || !address || !isValid || needsApproval,
    onPending:    hash => { console.log('tx pending', hash); setHasResetForm(false) },
    onSuccess:    onMintOnlySuccess,
    onError:      err  => { console.error(err); setHasResetForm(true) },
  })

  // hook into mintAndAuth function (mint + authenticate, no deposit)
  const { call: mintAndAuth, status: mintAndAuthStatus, gasCostEth: mintAndAuthGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mintAndAuth',
    abi:      cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, chains.l2.layerZero, lzTokenAmount],
    disabled:     paymentMode === 'eth' || depositEnabled || !authEnabled || !address || !isValid || needsApproval,
    onPending:    hash => { console.log('mintAndAuth tx pending', hash); setHasResetForm(false) },
    onSuccess:    onMintOnlySuccess,
    onError:      err  => { console.error(err); setHasResetForm(true) },
  })

  // hook into mintAndDeposit function
  const { call: mintAndDeposit, status: mintAndDepositStatus, gasCostEth: mintAndDepositGas }: UseContractCallReturn = useContractCall({
    value:        quote?.nativeFee || 0n,
    functionName: 'mintAndDeposit',
    abi:      cawProfileMinterAbi,
    address: CAW_NAMES_MINTER_ADDRESS,
    args:         [CLIENT_ID, username, depositAmountWei, chains.l2.layerZero, lzTokenAmount],
    disabled:     paymentMode === 'eth' || !depositEnabled || quickSignEnabled || !address || !isValid || needsApproval || depositAmountWei === 0n,
    onPending:    hash => {
      console.log('mintAndDeposit tx pending', hash)
      setHasResetForm(false)
    },
    onSuccess:    async (hash) => {
      console.log('minted and deposited!', hash)

      // Side-effects shared by fast-path and fallback.
      const applyDepositSuccess = async (resolvedTokenId: number) => {
        // Write the pending-deposit hint SYNCHRONOUSLY *before* setMintSuccess.
        // setMintSuccess triggers the navigate to /welcome, where the onboarding
        // stepper mounts and reads this hint (non-reactively) to credit the
        // pending stake at the follow gate. If we awaited the L2 baseline read
        // first (as before), the navigate/mount would win the race and the
        // stepper would read an empty hint → "need to stake 30K" even though a
        // deposit is pending. The amount is all the gate needs; the L2 baseline
        // (used only to detect when the deposit lands) is backfilled async below.
        if (depositAmountWei > 0n) {
          writePendingDepositHint(resolvedTokenId, depositAmountWei, hash)
        }
        setMintedTokenId(resolvedTokenId)
        setActiveTokenId(resolvedTokenId)
        setMintSuccess(true)
      }

      // Fast path: decode tokenId from receipt + ensure server row via L1 read
      const fastTokenId = await resolveMintedTokenId(hash)
      if (fastTokenId !== null) {
        await applyDepositSuccess(fastTokenId)
        return
      }

      // Fallback: username-polling loop
      await refetchTokenData?.()
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          await applyDepositSuccess(newToken.tokenId)
        } else {
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }
      setTimeout(checkForNewToken, 1000)
    },
    onError:      err  => { console.error(err); setHasResetForm(true) },
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
    disabled:     paymentMode === 'eth' || !depositEnabled || !quickSignEnabled || !address || !isValid || needsApproval || depositAmountWei === 0n || qsSessionAddress === '0x0000000000000000000000000000000000000000',
    onPending:    hash => {
      console.log('mintAndDepositAndQuickSign tx pending', hash)
      setHasResetForm(false)
    },
    onSuccess:    async (hash) => {
      console.log('bundled mint+deposit+QuickSign succeeded!', hash)
      // Persist the QuickSign session IMMEDIATELY — see the zap variant's
      // onSuccess for the rationale (don't gate on the indexer-polling
      // closure, which gets GC'd if the user navigates away mid-poll).
      const sess = sessionRef.current
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

      // Side-effects shared by fast-path and fallback.
      const applyBundledSuccess = async (resolvedTokenId: number) => {
        // Synchronous hint write before setMintSuccess — see writePendingDepositHint.
        if (depositAmountWei > 0n) {
          writePendingDepositHint(resolvedTokenId, depositAmountWei, hash)
        }
        setMintedTokenId(resolvedTokenId)
        setActiveTokenId(resolvedTokenId)
        setMintSuccess(true)
      }

      // Fast path: decode tokenId from receipt + ensure server row via L1 read
      const fastTokenId = await resolveMintedTokenId(hash)
      if (fastTokenId !== null) {
        await applyBundledSuccess(fastTokenId)
        return
      }

      // Fallback: username-polling loop
      await refetchTokenData?.()
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          await applyBundledSuccess(newToken.tokenId)
        } else {
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }
      setTimeout(checkForNewToken, 1000)
    },
    onError:      err  => { console.error(err); setHasResetForm(true) },
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

      // Side-effects shared by fast-path and fallback.
      const applyZapSuccess = async (resolvedTokenId: number) => {
        // ZAP deposit amount = swap output - username burn. Write the hint
        // SYNCHRONOUSLY before setMintSuccess so the onboarding stepper credits
        // it at the follow gate (this was the "need to stake 30K despite a
        // pending zap deposit" bug — the awaited L2 read let the navigate win).
        const zapDeposit = zapQuote.expectedCawOut > cost ? zapQuote.expectedCawOut - cost : 0n
        console.log('[New/zap] pendingDeposit hint:', { tokenId: resolvedTokenId, zapDeposit: zapDeposit.toString() })
        if (zapDeposit > 0n) {
          writePendingDepositHint(resolvedTokenId, zapDeposit, hash)
        }
        setMintedTokenId(resolvedTokenId)
        setActiveTokenId(resolvedTokenId)
        setMintSuccess(true)
      }

      // Fast path: decode tokenId from receipt + ensure server row via L1 read
      const fastTokenId = await resolveMintedTokenId(hash)
      if (fastTokenId !== null) {
        await applyZapSuccess(fastTokenId)
        return
      }

      // Fallback: username-polling loop
      await refetchTokenData?.()
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          await applyZapSuccess(newToken.tokenId)
        } else {
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }
      setTimeout(checkForNewToken, 1000)
    },
    onError: err => { console.error(err); setHasResetForm(true) },
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
      // Persist the QuickSign session IMMEDIATELY — don't wait for the L2
      // mirror to index the new token. The session keypair is already
      // committed on-chain by this tx; gating persistence on the indexer
      // polling loop means a user who navigates away mid-poll loses the
      // session entirely (the recursive setTimeout closure gets GC'd).
      const sess = sessionRef.current
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

      // Side-effects shared by fast-path and fallback.
      const applyZapQsSuccess = async (resolvedTokenId: number) => {
        // Synchronous hint write before setMintSuccess — see applyZapSuccess /
        // writePendingDepositHint. deposit = swap output minus burn.
        const zapDeposit = zapQuote.expectedCawOut > cost ? zapQuote.expectedCawOut - cost : 0n
        console.log('[New/zapQs] pendingDeposit hint:', { tokenId: resolvedTokenId, zapDeposit: zapDeposit.toString() })
        if (zapDeposit > 0n) {
          writePendingDepositHint(resolvedTokenId, zapDeposit, hash)
        }
        setMintedTokenId(resolvedTokenId)
        setActiveTokenId(resolvedTokenId)
        setMintSuccess(true)
      }

      // Fast path: decode tokenId from receipt + ensure server row via L1 read
      const fastTokenId = await resolveMintedTokenId(hash)
      if (fastTokenId !== null) {
        await applyZapQsSuccess(fastTokenId)
        return
      }

      // Fallback: username-polling loop
      await refetchTokenData?.()
      const checkForNewToken = async () => {
        const allTokens = useTokenDataStore.getState().allTokens()
        const newToken = allTokens.find((t: any) => t.username.toLowerCase() === username.toLowerCase())
        if (newToken) {
          await applyZapQsSuccess(newToken.tokenId)
        } else {
          refetchTokenData?.()
          setTimeout(checkForNewToken, 3000)
        }
      }
      setTimeout(checkForNewToken, 1000)
    },
    onError: err => { console.error(err); setHasResetForm(true) },
  })

  // Unified status — pick from whichever path is active
  const mintStatus = paymentMode === 'eth'
    ? (quickSignEnabled ? bundledZapStatus : mintAndDepositZapStatus)
    : (depositEnabled
        ? (quickSignEnabled ? bundledStatus : mintAndDepositStatus)
        : (authEnabled ? mintAndAuthStatus : mintOnlyStatus))
  const gasCostEth = paymentMode === 'eth'
    ? (quickSignEnabled ? bundledZapGas : mintAndDepositZapGas)
    : (depositEnabled
        ? (quickSignEnabled ? bundledGas : mintAndDepositGas)
        : (authEnabled ? mintAndAuthGas : mintOnlyGas))
  // DEBUG: dump all six paths' gas estimates side-by-side to diagnose
  // the CAW-vs-ETH fee discrepancy. Remove after identifying the cause.
  console.log('[NetworkFee debug]', {
    paymentMode,
    depositEnabled,
    quickSignEnabled,
    authEnabled,
    activePath:
      paymentMode === 'eth'
        ? (quickSignEnabled ? 'bundledZap' : 'mintAndDepositZap')
        : (depositEnabled ? (quickSignEnabled ? 'bundled' : 'mintAndDeposit') : (authEnabled ? 'mintAndAuth' : 'mintOnly')),
    activeGasCostEth: gasCostEth,
    activeQuoteNativeFee: (quote as any)?.nativeFee?.toString(),
    allGas: {
      mintOnly: mintOnlyGas,
      mintAndAuth: mintAndAuthGas,
      mintAndDeposit: mintAndDepositGas,
      bundled: bundledGas,
      mintAndDepositZap: mintAndDepositZapGas,
      bundledZap: bundledZapGas,
    },
  })
  const mint = paymentMode === 'eth'
    ? (quickSignEnabled ? mintAndDepositAndQuickSignZap : mintAndDepositZap)
    : (depositEnabled
        ? (quickSignEnabled ? mintAndDepositAndQuickSign : mintAndDeposit)
        : (authEnabled ? mintAndAuth : mintOnly))

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
    // ETH-mode submit gate
    paymentMode,
    ethAmount,
    ethAmountWei: ethAmountWei.toString(),
    zapLoaded: zapQuote.loaded,
    zapExpectedCawOut: zapQuote.expectedCawOut.toString(),
    zapMinCawOut: zapQuote.minCawOut.toString(),
    zapMinCawOut_lt_cost: zapQuote.minCawOut < cost,
    quickSignEnabled,
    usernameTaken,
    waiting,
    wrongChain,
    chainId,
    reservesLoaded: reserves.loaded,
    insufficientBalance,
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
    // Reset the form-dismissal flag so the "Creating…" takeover shows on this
    // attempt. Without this, a previous tx that errored (onError sets the flag
    // true to dismiss the takeover) leaves the flag stuck and the next submit
    // never shows the takeover.
    setHasResetForm(false)
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
    else if (zapQuote.loaded && zapQuote.minCawOut < cost) submitText = "Increase ETH Amount"
    else submitText = "Create & Deposit (ETH)"
  }
  else submitText = depositEnabled && depositAmountWei > 0n ? t('new_profile.create_and_deposit') : t('new_profile.create')

  // Show loading screen while waiting for mint to complete. The
  // useLayoutStore effect above hides MainLayout's chrome for this state.
  if (showMintingTakeover) {
    return (
      <div className="min-h-screen flex items-start justify-center pt-32" ref={el => { if (el) window.scrollTo(0, 0) }}>
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

              {depositEnabled && (() => {
                // ETH mode: actual CAW deposited = zap output minus username cost.
                // CAW mode: user typed the deposit amount directly.
                const pendingWei = paymentMode === 'eth'
                  ? (zapQuote.expectedCawOut > cost ? zapQuote.expectedCawOut - cost : 0n)
                  : depositAmountWei
                if (pendingWei === 0n) return null
                const pendingCaw = Number(pendingWei) / 1e18
                // USD basis: in ETH mode, derive from what the user actually
                // paid (ETH × ethPrice scaled by deposit/totalOut), NOT from
                // CoinGecko's cawPrice — on testnet the pool ratio diverges
                // wildly from the public CAW price and pendingCaw × cawPrice
                // can be 5x off. CAW mode falls back to cawPrice as before.
                let usd: number | null = null
                if (paymentMode === 'eth' && ethPrice > 0 && zapQuote.expectedCawOut > 0n) {
                  const ethPaid = Number(ethAmount) || 0
                  const ratio = Number(pendingWei) / Number(zapQuote.expectedCawOut)
                  usd = ethPaid * ethPrice * ratio
                } else if (cawPrice > 0) {
                  usd = pendingCaw * cawPrice
                }
                return (
                  <p className="text-yellow-500 text-sm">
                    {pendingCaw.toLocaleString(undefined, { maximumFractionDigits: 0 })} CAW
                    {usd != null && (
                      <> (~${formatUsd(usd)})</>
                    )}
                    {' '}deposit pending
                  </p>
                )
              })()}

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
        <div className={isCaptive ? 'flex flex-col md:flex-row gap-8 md:gap-0 items-start md:divide-x md:divide-white/10 pt-6' : ''}>
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

            {/* ETH-mode input — shared component, see components/EthSpendInput.tsx.
                Pass usernameCostCaw so the readout handles the "below burn cost"
                warning + the deposit-remainder math. */}
            {paymentMode === 'eth' && (
              <div className="mt-3">
                <EthSpendInput
                  title="ETH to spend"
                  subtitle=" - buys and deposits CAW into your profile."
                  titleSuffix={
                    <span className="flex items-center gap-1.5 mt-0.5 text-yellow-500/80 text-xs">
                      {t('new_profile.deposit.bullet3')}
                      <DepositInfoPopover />
                    </span>
                  }
                  ethAmount={ethAmount}
                  setEthAmount={setEthAmount}
                  ethPrice={ethPrice}
                  quickPickDollars={ethQuickPickDollars}
                  expectedCawOut={zapQuote.expectedCawOut}
                  reservesLoaded={reserves.loaded}
                  usernameCostCaw={cost}
                  ethBalanceWei={ethBalanceData?.value}
                  onConnectClick={!address ? openConnectModal : undefined}
                  balanceLabel={t('new_profile.balance_label')}
                />
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
                  {/* When deposit is OFF, surface the full "why bother"
                      pitch so the user understands the trade. Once they
                      flip it on, collapse to just the encouragement line
                      — the (i) popover holds the full yield rundown for
                      anyone who wants more detail. */}
                  {!depositEnabled ? (
                    <ul className="text-yellow-500/80 text-xs mt-0.5 list-disc list-outside pl-4 space-y-0.5">
                      <li>{t('new_profile.deposit.bullet1')}</li>
                      <li>{t('new_profile.deposit.bullet2')}</li>
                      <li>{t('new_profile.deposit.bullet3')}</li>
                    </ul>
                  ) : (
                    <p className="text-yellow-500/80 text-xs mt-0.5">
                      {t('new_profile.deposit.bullet3')}
                    </p>
                  )}
                </div>
              </label>

              {depositEnabled && (
                <div className="space-y-2">
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

            {/* Authenticate-with-network toggle — only shown when deposit is OFF
                AND the Network charges a non-zero authFee. mintAndDeposit always
                bundles auth on-chain (no contract path skips it), so this toggle
                is only meaningful in the bare-mint case. */}
            {paymentMode === 'caw' && !depositEnabled && (networkFees.authFee ?? 0n) > 0n && (
            <div className={`border rounded-xl p-4 space-y-3 mt-3 ${
              isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
            }`}>
              <label className="flex items-center gap-3 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setAuthEnabled(!authEnabled)}
                  className={`relative w-10 min-w-[40px] h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${
                    authEnabled ? 'bg-yellow-500' : 'bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                    authEnabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`} />
                </button>
                <div className="flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      Authenticate with this network{networkFees.name ? ` (${networkFees.name})` : ''}
                    </span>
                    <AuthInfoPopover />
                  </div>
                  <p className="text-yellow-500/80 text-xs mt-0.5">
                    Required to post, like, follow, etc. on this network
                  </p>
                </div>
              </label>
            </div>
            )}

            {/* Quick Sign option — appears alongside any deposit-bearing flow
                (CAW-mode mintAndDeposit OR ETH-mode mintAndDepositZap, since
                both bundled selectors include the session leg).
                ETH-mode always shows it (even before the user types) so the
                option is discoverable; the bundled selector only fires when
                ethAmountWei > 0, but the toggle itself doesn't need to wait. */}
            {((paymentMode === 'caw' && depositEnabled && depositAmountWei > 0n) ||
              paymentMode === 'eth') && (
            <div className={`border rounded-xl p-4 space-y-3 mt-3 ${
              isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
            }`}>
              {/* Override space-y-3 gap below this label to 5px */}
              <label className={`flex items-center gap-3 [&+*]:!mt-[5px] ${hasExistingSessionForAddress ? 'cursor-default' : 'cursor-pointer'}`}>
                {hasExistingSessionForAddress ? (
                  // Already enabled for this owner address — Quick Sign is
                  // delegated per address and the new profile inherits the
                  // existing session, so there's nothing to toggle. Show a
                  // checkmark instead of a switch.
                  <HiCheckCircle className="w-6 h-6 text-yellow-500 flex-shrink-0" aria-label="Quick Sign already enabled" />
                ) : (
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
                )}
                <div className="flex-1">
                  {/* Title row — plain span so a click bubbles to the
                      wrapping <label> and toggles the switch (parity with
                      the rest of the label). The (i) popover next to it
                      stops propagation so it can open without flipping
                      Quick Sign off. */}
                  <div className="flex items-center gap-1.5">
                    <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Quick Sign — one-click actions</span>
                    <QuickSignInfoPopover />
                  </div>
                  {hasExistingSessionForAddress ? (
                    <p className="text-yellow-500/80 text-xs mt-0.5">
                      Already enabled — Quick Sign works across all profiles on this wallet.
                    </p>
                  ) : (
                    <>
                      <p className="text-yellow-500/80 text-xs mt-0.5">
                        Delegate funds to your device to skip wallet sigs
                      </p>
                      <p className="text-gray-500 text-xs mt-0.5">You can configure later in settings</p>
                    </>
                  )}
                </div>
              </label>
              {quickSignEnabled && quickSignExpanded && (() => {
                // Display THIS validator's published per-action minimum tip
                // (ETH wei, sourced from /api/validator-analytics/tip-config).
                // The on-chain oracle converts ETH→CAW at submission time; the
                // user's CAW ceiling (still wired to getDefaultTipCeiling for
                // session args at lines ~782 / ~923) is just a safety bound.
                const validatorTipWei = getCurrentValidatorMinTipWei()
                const validatorTipEth = Number(validatorTipWei) / 1e18
                const validatorTipUsd = ethPrice > 0 && validatorTipWei > 0n
                  ? validatorTipEth * ethPrice
                  : null
                return (
                  <div className={`flex justify-around items-start text-xs pt-2 mt-2 border-t ${
                    isDark ? 'border-white/10 text-gray-400' : 'border-gray-200 text-gray-600'
                  }`}>
                    <div className="flex flex-col items-center text-center">
                      <span>Spend limit</span>
                      <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        ~$10
                      </span>
                    </div>
                    <div className="flex flex-col items-center text-center">
                      <span className="inline-flex items-center gap-1">
                        Tip / action
                        <TipPerActionPopover isDark={isDark} />
                      </span>
                      <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {validatorTipUsd != null ? `~${formatTipUsd(validatorTipUsd)}` : '—'}
                      </span>
                    </div>
                    <div className="flex flex-col items-center text-center">
                      <span>Expires in</span>
                      <span className={`font-mono ${isDark ? 'text-white' : 'text-gray-900'}`}>
                        {Math.round(DEFAULT_SESSION_DURATION / 86400)} days
                      </span>
                    </div>
                  </div>
                )
              })()}
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
              // `quote.nativeFee` from the Quoter is the FULL msg.value (per-Network
              // storage fees ×2 + true LZ message fee). Don't add storage fees
              // separately or we'd double-count. Gas is the only addend.
              const includesDeposit = depositEnabled || paymentMode === 'eth'
              // Auth is bundled with every mint+deposit path, AND with mint-only
              // when the user opts in via the `authEnabled` toggle.
              const includesAuth = includesDeposit || (!includesDeposit && authEnabled)
              let applicableStorageFeesWei = networkFees.mintFee ?? 0n
              if (includesDeposit) applicableStorageFeesWei += networkFees.depositFee ?? 0n
              if (includesAuth) applicableStorageFeesWei += networkFees.authFee ?? 0n
              const lzFeeWei = quote?.nativeFee ?? 0n
              const gasWei = gasCostEth != null ? BigInt(Math.round(gasCostEth * 1e18)) : 0n
              const totalWei = lzFeeWei + gasWei
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
              applicableStorageFeesWei={(() => {
                const includesDeposit = depositEnabled || paymentMode === 'eth'
                const includesAuth = includesDeposit || (!includesDeposit && authEnabled)
                let s = networkFees.mintFee ?? 0n
                if (includesDeposit) s += networkFees.depositFee ?? 0n
                if (includesAuth) s += networkFees.authFee ?? 0n
                return s
              })()}
            />
        </div>
            </div>
          </div>
        </div>
      </div>
  )
}

export default NewProfile
