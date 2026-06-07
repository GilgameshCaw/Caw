/**
 * CardCheckout.tsx
 *
 * "Buy a CAW profile — pay with card" flow.
 *
 * Step 1: User picks a username + deposit amount (USD slider $5–$120).
 *         Username availability is checked on-chain (same logic as UsernameStep).
 *         Total cost is displayed (username mint cost + deposit).
 *
 * Step 2: POST /api/stripe/create-checkout → redirect to Stripe's hosted page.
 *         If no wallet is connected a fresh EOA is generated and persisted via
 *         keyManager.ts so the webhook-driven mint can target an address.
 *
 * After Stripe payment the webhook on the server calls mintAndDepositSponsored()
 * with kycLevel = 1 (180-day time-lock) — the regulatory-framing path for fiat
 * mints. User lands on /welcome/:username where the post-mint flow polls.
 *
 * Bare route (no MainLayout), same pattern as /onboarding.
 */

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNavigate } from '~/utils/localizedRouter'
import { useReadContract } from 'wagmi'
import { useAccount } from 'wagmi'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { usePriceStore } from '~/store/tokenDataStore'
import { formatUsd } from '~/utils/numberFormat'
import { generateOnrampAccount } from '~/services/onramp/keyManager'
import { createStripeCheckout } from '~/services/stripe/checkout'
import { CLIENT_ID } from '~/api/actions'
import BoidsBg from '~/components/BoidsBg3D'
import LanguageSwitcher from '~/components/LanguageSwitcher'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Minimum deposit in USD */
const DEPOSIT_USD_MIN = 5
/** Maximum deposit in USD */
const DEPOSIT_USD_MAX = 120

const DEBOUNCE_MS = 500
const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/

/** Username burn cost schedule (whole CAW, length → cost). Mirrors UsernameStep. */
const COST_SCHEDULE: Record<number, number> = {
  1: 1_000_000_000_000,
  2:   240_000_000_000,
  3:    60_000_000_000,
  4:     6_000_000_000,
  5:       200_000_000,
  6:        20_000_000,
  7:        10_000_000,
}
const DEFAULT_COST_CAW = 1_000_000 // 8+ chars

function cawCostForLength(len: number): number {
  if (len === 0) return 0
  return COST_SCHEDULE[len] ?? DEFAULT_COST_CAW
}

function formatCawCompact(caw: number): string {
  if (caw >= 1_000_000_000_000) return `${(caw / 1_000_000_000_000).toFixed(0)}T`
  if (caw >= 1_000_000_000) return `${(caw / 1_000_000_000).toFixed(0)}B`
  if (caw >= 1_000_000) return `${(caw / 1_000_000).toFixed(0)}M`
  if (caw >= 1_000) return `${(caw / 1_000).toFixed(0)}K`
  return caw.toString()
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function CardCheckout() {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()
  const { address: connectedAddress } = useAccount()

  const cawPriceUsd = usePriceStore(s => s.priceMap['a-hunters-dream']) as number | undefined

  // Gate: if Stripe isn't configured, show an error card instead of the flow.
  const stripeConfigured = !!import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY

  // ── Username state ────────────────────────────────────────────────────────
  const [username, setUsername] = useState('')
  const [usernameAvailable, setUsernameAvailable] = useState<boolean | null>(null)
  const [debouncedUsername, setDebouncedUsername] = useState('')

  useEffect(() => {
    const id = setTimeout(() => setDebouncedUsername(username), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [username])

  const isValidFormat = USERNAME_REGEX.test(debouncedUsername)

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'idByUsername',
    args: [debouncedUsername],
    query: { enabled: isValidFormat },
  })

  useEffect(() => {
    if (!isValidFormat || checkingUsername) {
      setUsernameAvailable(null)
      return
    }
    const available = existingId === undefined || existingId === 0
    setUsernameAvailable(available)
  }, [existingId, checkingUsername, isValidFormat])

  const isTyping = username !== debouncedUsername || checkingUsername

  // ── Deposit amount ─────────────────────────────────────────────────────────
  const [depositUsd, setDepositUsd] = useState(DEPOSIT_USD_MIN)
  // Slider value is in whole USD. We store USD here (not CAW bigint) since
  // Stripe works in USD cents — no reason to round-trip through CAW.
  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDepositUsd(Number(e.target.value))
  }, [])

  // ── Cost breakdown ─────────────────────────────────────────────────────────
  const cawMintCost = useMemo(() => cawCostForLength(username.length), [username])
  const mintCostUsd = cawPriceUsd != null && cawMintCost > 0
    ? cawMintCost * cawPriceUsd
    : null
  const totalUsd = depositUsd + (mintCostUsd ?? 0)

  // ── Submit state ──────────────────────────────────────────────────────────
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Stable ref for the wallet address we'll use. If the user already has
  // a connected wallet use that; otherwise generate a fresh EOA and
  // persist it so the webhook can target it.
  const walletRef = useRef<string | null>(null)

  const canProceed = usernameAvailable === true && !isSubmitting

  // ── Tooltip for pricing schedule ──────────────────────────────────────────
  const [showPricingTooltip, setShowPricingTooltip] = useState(false)
  const tooltipCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const openTooltip = () => {
    if (tooltipCloseTimer.current) clearTimeout(tooltipCloseTimer.current)
    setShowPricingTooltip(true)
  }
  const scheduleCloseTooltip = () => {
    if (tooltipCloseTimer.current) clearTimeout(tooltipCloseTimer.current)
    tooltipCloseTimer.current = setTimeout(() => setShowPricingTooltip(false), 120)
  }

  // ── Handlers ──────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!canProceed) return
    setIsSubmitting(true)
    setError(null)

    try {
      // Resolve wallet address: prefer connected wallet, otherwise generate a
      // fresh EOA and persist it for the webhook-driven mint.
      let walletAddress = walletRef.current
      if (!walletAddress) {
        if (connectedAddress) {
          walletAddress = connectedAddress
        } else {
          const account = generateOnrampAccount()
          walletAddress = account.address
        }
        walletRef.current = walletAddress
      }

      const result = await createStripeCheckout({
        username,
        depositAmountUsd: depositUsd,
        walletAddress,
        networkId: CLIENT_ID,
      })

      // Redirect to Stripe's hosted checkout page.
      window.location.href = result.url
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      setError(msg || t('checkout.error'))
      setIsSubmitting(false)
    }
  }, [canProceed, connectedAddress, username, depositUsd, t])

  // ── Theme helpers ──────────────────────────────────────────────────────────
  const outerBg = isDark ? 'bg-black' : 'bg-white'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const borderBase = isDark ? 'border-white/20' : 'border-gray-300'
  const borderFocus = 'focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500'
  const inputBg = isDark ? 'bg-white/5' : 'bg-white'
  const cardBg = isDark ? 'bg-white/5 border border-white/10' : 'bg-gray-50 border border-gray-200'

  // ── Not-configured stub ────────────────────────────────────────────────────
  if (!stripeConfigured) {
    return (
      <div className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}>
        <BoidsBg isDark={isDark} />
        <div className="absolute top-3 right-3 z-[110]">
          <LanguageSwitcher />
        </div>
        <div className="relative z-10 px-4 py-8 min-h-screen flex items-center justify-center">
          <div className={`w-full max-w-md rounded-2xl p-6 text-center ${cardBg}`}>
            <h2 className={`text-xl font-bold mb-2 ${strongClass}`}>
              {t('checkout.title')}
            </h2>
            <p className={`text-sm ${mutedClass}`}>
              {t('checkout.stripe_not_configured')}
            </p>
            <button
              onClick={() => navigate('/')}
              className={`mt-4 px-4 py-2 rounded-full text-sm font-medium transition-colors cursor-pointer ${
                isDark
                  ? 'bg-white/10 text-white hover:bg-white/15'
                  : 'bg-black/5 text-gray-900 hover:bg-black/10'
              }`}
            >
              {t('common.back_home')}
            </button>
          </div>
        </div>
      </div>
    )
  }

  // ── Main flow ──────────────────────────────────────────────────────────────
  return (
    <div className={`fixed inset-0 z-[100] overflow-y-auto overflow-x-hidden ${outerBg}`}>
      <BoidsBg isDark={isDark} />

      <div className="absolute top-3 right-3 z-[110]">
        <LanguageSwitcher />
      </div>

      <div className="relative z-10 px-4 py-8 min-h-screen flex items-start justify-center">
        <div className="w-full max-w-lg">

          {/* Back link */}
          <button
            onClick={() => navigate('/')}
            className={`mb-6 flex items-center gap-1 text-sm transition-colors cursor-pointer ${mutedClass} hover:${strongClass}`}
            aria-label={t('common.back')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span>{t('common.back')}</span>
          </button>

          {/* Header */}
          <div className="mb-6">
            <h1 className={`text-2xl font-bold mb-1 ${strongClass}`}>
              {t('checkout.title')}
            </h1>
            <p className={`text-sm ${mutedClass}`}>
              {t('checkout.subtitle')}
            </p>
          </div>

          <div className="space-y-6">

            {/* Username input */}
            <div className="space-y-2">
              <label className={`block text-sm font-medium ${strongClass}`}>
                {t('checkout.username_label')}
              </label>

              <div className="relative">
                <input
                  type="text"
                  value={username}
                  onChange={e => {
                    setUsername(e.target.value.toLowerCase())
                    setUsernameAvailable(null)
                  }}
                  placeholder="yourname"
                  maxLength={24}
                  autoComplete="off"
                  spellCheck={false}
                  disabled={isSubmitting}
                  className={`
                    w-full px-4 py-3 pr-10 rounded-xl border text-sm transition-colors
                    ${inputBg} ${strongClass} ${borderBase} ${borderFocus}
                    ${isSubmitting ? 'opacity-60 cursor-not-allowed' : ''}
                  `}
                />

                {/* Availability indicator */}
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  {isTyping && username.length > 0 && (
                    <svg className="w-4 h-4 animate-spin text-yellow-500" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                  {!isTyping && usernameAvailable === true && (
                    <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                  {!isTyping && usernameAvailable === false && (
                    <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  )}
                </div>
              </div>

              {/* Cost hint + availability */}
              <div className="min-h-[1.25rem] flex items-start justify-between gap-3">
                <div className="flex-1 text-left">
                  {cawMintCost > 0 && username.length >= 3 && (
                    <p className={`text-xs ${mutedClass} flex items-center gap-1`}>
                      <span>Mint cost:</span>
                      <span className={strongClass}>{formatCawCompact(cawMintCost)} CAW</span>
                      {mintCostUsd !== null && (
                        <span className={mutedClass}>(~${formatUsd(mintCostUsd)})</span>
                      )}
                      {/* Pricing schedule tooltip */}
                      <span
                        className="relative inline-flex"
                        onMouseEnter={openTooltip}
                        onMouseLeave={scheduleCloseTooltip}
                      >
                        <button
                          type="button"
                          aria-label="Pricing schedule"
                          className={`inline-flex items-center justify-center transition-colors ${
                            isDark ? 'text-white/40 hover:text-white' : 'text-gray-400 hover:text-gray-700'
                          }`}
                          onFocus={openTooltip}
                          onBlur={scheduleCloseTooltip}
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>
                        {showPricingTooltip && (
                          <div
                            onMouseEnter={openTooltip}
                            onMouseLeave={scheduleCloseTooltip}
                            className={`absolute z-50 bottom-full mb-2 left-1/2 -translate-x-1/2 w-64 border rounded-lg p-4 shadow-lg ${
                              isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
                            }`}
                          >
                            <div className={`text-sm font-medium text-center mb-3 ${strongClass}`}>
                              Username pricing
                            </div>
                            <div className="space-y-2">
                              {([1, 2, 3, 4, 5, 6, 7] as const).map(len => {
                                const cost = COST_SCHEDULE[len]
                                const usd = cawPriceUsd != null ? cost * cawPriceUsd : null
                                return (
                                  <div key={len} className="flex justify-between text-xs items-baseline">
                                    <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>
                                      {len} char
                                    </span>
                                    <span>
                                      <span className={`font-mono ${strongClass}`}>
                                        {formatCawCompact(cost)} CAW
                                      </span>
                                      {usd !== null && (
                                        <span className={`${mutedClass} ml-2`}>(~${formatUsd(usd)})</span>
                                      )}
                                    </span>
                                  </div>
                                )
                              })}
                              <div className="flex justify-between text-xs items-baseline">
                                <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>8+ chars</span>
                                <span>
                                  <span className={`font-mono ${strongClass}`}>1M CAW</span>
                                  {cawPriceUsd != null && (
                                    <span className={`${mutedClass} ml-2`}>(~${formatUsd(DEFAULT_COST_CAW * cawPriceUsd)})</span>
                                  )}
                                </span>
                              </div>
                            </div>
                          </div>
                        )}
                      </span>
                    </p>
                  )}
                  {username.length > 0 && !isValidFormat && !isTyping && (
                    <p className="text-xs text-red-500 mt-0.5">
                      3–24 characters, lowercase letters, numbers, or underscore.
                    </p>
                  )}
                </div>
                <div className="text-right">
                  {!isTyping && usernameAvailable === true && (
                    <p className="text-xs text-green-500">Available</p>
                  )}
                  {!isTyping && usernameAvailable === false && (
                    <p className="text-xs text-red-500">Taken</p>
                  )}
                </div>
              </div>
            </div>

            {/* Deposit slider */}
            <div className="space-y-3">
              <label className={`block text-sm font-medium ${strongClass}`}>
                {t('checkout.deposit_label')}
              </label>

              {/* Big amount display */}
              <div className={`rounded-xl p-4 text-center ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
                <div className={`text-3xl font-bold ${strongClass}`}>
                  <span className="text-yellow-500">$</span>{depositUsd}
                </div>
                {cawPriceUsd != null && (
                  <div className={`text-sm mt-1 ${mutedClass}`}>
                    ≈ {formatCawCompact(Math.round(depositUsd / cawPriceUsd))} CAW
                  </div>
                )}
              </div>

              <input
                type="range"
                min={DEPOSIT_USD_MIN}
                max={DEPOSIT_USD_MAX}
                step={1}
                value={depositUsd}
                onChange={handleSliderChange}
                disabled={isSubmitting}
                className="w-full accent-yellow-500 cursor-pointer"
              />
              <div className={`flex justify-between text-xs ${mutedClass}`}>
                <span>${DEPOSIT_USD_MIN}</span>
                <span>${DEPOSIT_USD_MAX}</span>
              </div>
            </div>

            {/* Total cost breakdown */}
            <div className={`rounded-xl p-4 space-y-2 ${cardBg}`}>
              <p className={`text-sm font-medium mb-1 ${strongClass}`}>
                {t('checkout.total_label')}
              </p>

              <div className={`flex justify-between text-sm ${mutedClass}`}>
                <span>Deposit</span>
                <span>${depositUsd.toFixed(2)}</span>
              </div>

              {mintCostUsd !== null && (
                <div className={`flex justify-between text-sm ${mutedClass}`}>
                  <span>Username mint ({username})</span>
                  <span>~${formatUsd(mintCostUsd)}</span>
                </div>
              )}

              <div className={`flex justify-between text-sm ${mutedClass}`}>
                <span>Network fees</span>
                <span className={mutedClass}>est. &lt;$1</span>
              </div>

              <div className={`pt-2 mt-2 border-t flex justify-between font-semibold ${
                isDark ? 'border-white/10' : 'border-gray-200'
              }`}>
                <span className={strongClass}>Total</span>
                <span className={strongClass}>
                  ~${formatUsd(totalUsd)}
                </span>
              </div>
            </div>

            {/* Info box */}
            <div className={`rounded-xl p-4 text-sm space-y-1 ${
              isDark
                ? 'bg-yellow-500/10 border border-yellow-500/20'
                : 'bg-yellow-50 border border-yellow-200'
            }`}>
              <p className={`font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-800'}`}>
                Your CAW is fully yours
              </p>
              <p className={isDark ? 'text-yellow-300/70' : 'text-yellow-700'}>
                Your deposit earns staking rewards. After a one-time identity
                verification you can withdraw it at any time.
              </p>
            </div>

            {/* Error */}
            {error && (
              <p className="text-sm text-red-500">{error}</p>
            )}

            {/* Submit */}
            <button
              onClick={handleSubmit}
              disabled={!canProceed}
              className={`
                w-full py-3 rounded-full font-semibold text-sm transition-all
                ${canProceed
                  ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
                  : 'bg-yellow-500/30 text-black/40 cursor-not-allowed'
                }
              `}
            >
              {isSubmitting
                ? t('checkout.processing')
                : t('checkout.pay_cta')}
            </button>

            <p className={`text-xs text-center ${mutedClass}`}>
              Payments are processed securely by Stripe. CAW is not a financial instrument.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
