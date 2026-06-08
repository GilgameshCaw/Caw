/**
 * UsernameStep.tsx
 *
 * Step 1 of /onboarding: pick a username and verify it is available on-chain.
 * Uses wagmi's useReadContract to call cawProfileMinter.idByUsername(username)
 * — returns 0n when the name is free, a non-zero tokenId when taken.
 *
 * Availability check is debounced so we don't fire per-keystroke RPC calls.
 *
 * When giftCaw is provided (sponsored flow), the username is also gated by:
 *  - cawCostForLength(len) * 1e18 <= giftCaw  (name must fit in the gift)
 *  - len >= minUsernameLength                 (minimum length enforced by code)
 * The deposit remainder (giftCaw - burnCost) is shown read-only so the user
 * knows what they'll receive. No separate deposit step exists.
 */

import { useState, useEffect, useMemo, useRef } from 'react'
import { useReadContract } from 'wagmi'
import { cawProfileMinterAbi } from '~/../../../abi/generated'
import { CAW_NAMES_MINTER_ADDRESS } from '~/../../../abi/addresses'
import { chains } from '~/config/chains'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { usePriceStore } from '~/store/tokenDataStore'
import { formatUsd } from '~/utils/numberFormat'

const DEBOUNCE_MS = 500

// Lowercase alphanumeric + underscore; min 3, max 24 chars
const USERNAME_REGEX = /^[a-z0-9_]{3,24}$/

// Username burn cost schedule (whole CAW, length → cost). Mirrors
// COST_SCHEDULE in pages/Profile/New.tsx — keep these in sync, or
// extract to a shared module if a third callsite ever shows up.
const COST_SCHEDULE: Record<number, number> = {
  1: 1_000_000_000_000,
  2:   240_000_000_000,
  3:    60_000_000_000,
  4:     6_000_000_000,
  5:       200_000_000,
  6:        20_000_000,
  7:        10_000_000,
}
const DEFAULT_COST = 1_000_000  // 8+ chars

function cawCostForLength(len: number): number {
  if (len === 0) return 0
  return COST_SCHEDULE[len] ?? DEFAULT_COST
}

function formatCawCompact(caw: number): string {
  if (caw >= 1_000_000_000_000) return `${(caw / 1_000_000_000_000).toFixed(0)}T`
  if (caw >= 1_000_000_000) return `${(caw / 1_000_000_000).toFixed(0)}B`
  if (caw >= 1_000_000) return `${(caw / 1_000_000).toFixed(0)}M`
  if (caw >= 1_000) return `${(caw / 1_000).toFixed(0)}K`
  return caw.toString()
}

/** Format a bigint wei amount as a compact CAW string (e.g. "1.2B CAW") */
function formatWeiAsCaw(wei: bigint): string {
  const whole = Number(wei / 10n ** 18n)
  return `${formatCawCompact(whole)} CAW`
}

export interface UsernameStepProps {
  username: string
  usernameAvailable: boolean | null
  onUsernameChange: (value: string) => void
  onAvailabilityChange: (available: boolean | null) => void
  onNext: () => void
  /**
   * Total CAW gift in wei (bigint). When present, enables gift-based gating:
   * the username burn cost must fit within the gift, and the remainder
   * (giftCaw - burnCost) is shown as the auto-deposit.
   * Undefined means the gift hasn't loaded yet — Next is disabled.
   */
  giftCaw?: bigint
  /**
   * Minimum username length enforced by this invite code.
   * Undefined means no server-enforced minimum (the format regex min of 3 applies).
   */
  minUsernameLength?: number
  /** True while the /api/sponsor/code fetch is in flight. Disables Next. */
  giftLoading?: boolean
}

export default function UsernameStep({
  username,
  usernameAvailable,
  onUsernameChange,
  onAvailabilityChange,
  onNext,
  giftCaw,
  minUsernameLength,
  giftLoading = false,
}: UsernameStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const cawPriceUsd = usePriceStore(s => s.priceMap['a-hunters-dream']) as number | undefined

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

  // Cost depends on username length — shorter = much more expensive. The
  // burn cost is paid in CAW at mint time and locked forever.
  const cawCost = useMemo(() => cawCostForLength(username.length), [username])
  const usdCost = cawPriceUsd !== undefined && cawCost > 0
    ? cawCost * cawPriceUsd
    : null

  // ── Gift-based gating ─────────────────────────────────────────────────────
  // All math in BigInt wei to avoid float precision issues with large numbers.
  const burnCostWei = useMemo(
    () => BigInt(cawCost) * 10n ** 18n,
    [cawCost],
  )

  // On-chain deposit floor: the sponsor server rejects a bootstrap whose
  // deposit is below SPONSOR_MIN_DEPOSIT_CAW (default 1,000,000 CAW) with
  // ZERO_DEPOSIT. So the username burn must leave AT LEAST this much, not just
  // a non-zero remainder — otherwise the name "fits the gift" in the FE but the
  // mint fails server-side. 1M CAW in wei.
  const MIN_DEPOSIT_WEI = 1_000_000n * 10n ** 18n

  // Is the name too expensive? It's too expensive if the burn cost would leave
  // less than the minimum deposit (i.e. burn > gift - MIN_DEPOSIT). This also
  // covers the exact-spend case (burn === gift) — the user must keep enough to
  // fund a real profile, never spend the whole gift on the name.
  const nameTooExpensive = useMemo(
    () => giftCaw !== undefined && burnCostWei > giftCaw - MIN_DEPOSIT_WEI,
    [giftCaw, burnCostWei],
  )

  // Is the name too short per the code's minimum?
  const belowMinLength = useMemo(
    () => minUsernameLength !== undefined && username.length > 0 && username.length < minUsernameLength,
    [minUsernameLength, username.length],
  )

  // Deposit the user will receive after username burn. Null when it wouldn't
  // clear the deposit floor (nameTooExpensive already blocks Next in that case).
  const depositAmount = useMemo((): bigint | null => {
    if (giftCaw === undefined) return null
    const remainder = giftCaw - burnCostWei
    return remainder >= MIN_DEPOSIT_WEI ? remainder : null
  }, [giftCaw, burnCostWei])

  // Debounced value used for the RPC call — avoids a query per keystroke
  const [debouncedUsername, setDebouncedUsername] = useState(username)

  useEffect(() => {
    const id = setTimeout(() => setDebouncedUsername(username), DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [username])

  const isValidFormat = USERNAME_REGEX.test(debouncedUsername)

  // Also enforce minUsernameLength in the RPC-triggering regex gate
  const meetsMinLength = minUsernameLength === undefined || debouncedUsername.length >= minUsernameLength
  const isValidForRpc = isValidFormat && meetsMinLength

  const { data: existingId, isLoading: checkingUsername } = useReadContract({
    address: CAW_NAMES_MINTER_ADDRESS,
    abi: cawProfileMinterAbi,
    chainId: chains.l1.chainId,
    functionName: 'idByUsername',
    args: [debouncedUsername],
    query: { enabled: isValidForRpc },
  })

  // Sync availability to parent whenever the input or check result changes.
  //
  // The `username` (live value) dependency is load-bearing. The parent resets
  // usernameAvailable→null on EVERY keystroke (handleUsernameChange). wagmi
  // caches idByUsername, so deleting a char and retyping the SAME name returns
  // the identical cached `existingId` with `checkingUsername` false, and the
  // debounced value never actually changes (setState bails an equal value) — so
  // without depending on the live `username` the effect would NOT re-run after
  // the keystrokes blanked the parent's state, leaving it stuck at null ("checks
  // a name once, won't re-confirm it"). Depending on `username` re-runs the
  // effect every keystroke; we only PUSH a definitive result once typing has
  // settled (username === debouncedUsername), otherwise we report null (typing).
  useEffect(() => {
    const settled = username === debouncedUsername
    if (!settled || !isValidForRpc || checkingUsername) {
      onAvailabilityChange(null)
      return
    }
    // existingId === 0 or undefined means free; non-zero means taken
    // idByUsername returns uint32 — wagmi types it as number
    const available = existingId === undefined || existingId === 0
    onAvailabilityChange(available)
  }, [existingId, checkingUsername, isValidForRpc, username, debouncedUsername, onAvailabilityChange])

  const isTyping = username !== debouncedUsername || checkingUsername

  // canProceed: available + gift loaded + name fits in gift + meets min length
  const canProceed =
    usernameAvailable === true &&
    !giftLoading &&
    giftCaw !== undefined &&
    !nameTooExpensive &&
    !belowMinLength

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const borderBase = isDark ? 'border-white/20' : 'border-gray-300'
  const borderFocus = 'focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500'
  const inputBg = isDark ? 'bg-white/5' : 'bg-white'

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.username.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.username.subtitle')}
        </p>
      </div>

      {/* Gift summary — shown once giftCaw is loaded */}
      {giftCaw !== undefined && (
        <div className={`rounded-xl p-4 text-sm ${isDark ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-yellow-50 border border-yellow-200'}`}>
          <p className={`font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-800'}`}>
            Your invite includes {formatWeiAsCaw(giftCaw)}
          </p>
          <p className={`mt-1 ${isDark ? 'text-yellow-300/70' : 'text-yellow-700'}`}>
            The username burn cost is deducted; the rest auto-deposits to your profile.
          </p>
        </div>
      )}

      {/* Loading state for gift fetch */}
      {giftLoading && (
        <div className={`flex items-center gap-2 text-sm ${mutedClass}`}>
          <svg className="w-4 h-4 animate-spin text-yellow-500 flex-shrink-0" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>Loading invite details…</span>
        </div>
      )}

      <div className="space-y-2">
        <label className={`block text-sm font-medium ${strongClass}`}>
          {t('onboarding.username.label')}
        </label>

        <div className="relative">
          <input
            type="text"
            value={username}
            onChange={e => onUsernameChange(e.target.value.toLowerCase())}
            placeholder={t('onboarding.username.placeholder')}
            maxLength={24}
            autoComplete="off"
            spellCheck={false}
            className={`
              w-full px-4 py-3 pr-10 rounded-xl border text-sm transition-colors
              ${inputBg} ${strongClass} ${borderBase} ${borderFocus}
            `}
          />

          {/* Status indicator */}
          <div className="absolute right-3 top-1/2 -translate-y-1/2">
            {isTyping && username.length > 0 && (
              <svg
                className="w-4 h-4 animate-spin text-yellow-500"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            )}
            {!isTyping && usernameAvailable === true && !nameTooExpensive && !belowMinLength && (
              <svg className="w-4 h-4 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            )}
            {!isTyping && (usernameAvailable === false || nameTooExpensive || belowMinLength) && username.length > 0 && (
              <svg className="w-4 h-4 text-red-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            )}
          </div>
        </div>

        {/* Hint row: cost on the left, availability / gift-gate state on the right */}
        <div className="min-h-[1.25rem] flex items-start justify-between gap-3">
          <div className="flex-1 text-left">
            {cawCost > 0 && (
              <p className={`text-xs ${nameTooExpensive ? 'text-red-500' : mutedClass} flex items-center gap-1`}>
                <span>Mint cost:</span>
                <span className={nameTooExpensive ? 'text-red-500 font-semibold' : strongClass}>
                  {formatCawCompact(cawCost)} CAW
                </span>
                {usdCost !== null && !nameTooExpensive && (
                  <span className={mutedClass}>(~${formatUsd(usdCost)})</span>
                )}
                {/* Tooltip trigger */}
                <span
                  className="relative inline-flex"
                  onMouseEnter={openTooltip}
                  onMouseLeave={scheduleCloseTooltip}
                >
                  <button
                    type="button"
                    aria-label={t('new_profile.pricing_title')}
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
                        {t('new_profile.pricing_title')}
                      </div>
                      <div className="space-y-2">
                        {[
                          { label: t('new_profile.chars.1'), cawWhole: COST_SCHEDULE[1], compact: '1T' },
                          { label: t('new_profile.chars.2'), cawWhole: COST_SCHEDULE[2], compact: '240B' },
                          { label: t('new_profile.chars.3'), cawWhole: COST_SCHEDULE[3], compact: '60B' },
                          { label: t('new_profile.chars.4'), cawWhole: COST_SCHEDULE[4], compact: '6B' },
                          { label: t('new_profile.chars.5'), cawWhole: COST_SCHEDULE[5], compact: '200M' },
                          { label: t('new_profile.chars.6'), cawWhole: COST_SCHEDULE[6], compact: '20M' },
                          { label: t('new_profile.chars.7'), cawWhole: COST_SCHEDULE[7], compact: '10M' },
                          { label: t('new_profile.chars.8plus'), cawWhole: DEFAULT_COST, compact: '1M' },
                        ].map(({ label, cawWhole, compact }) => {
                          const usd = cawPriceUsd !== undefined ? cawWhole * cawPriceUsd : null
                          const tooExpensive = giftCaw !== undefined && BigInt(cawWhole) * 10n ** 18n > giftCaw
                          return (
                            <div key={label} className={`flex justify-between text-xs items-baseline ${tooExpensive ? 'opacity-40' : ''}`}>
                              <span className={isDark ? 'text-gray-300' : 'text-gray-600'}>{label}</span>
                              <span>
                                <span className={`font-mono ${strongClass}`}>{compact} CAW</span>
                                {usd !== null && (
                                  <span className={`${mutedClass} ml-2`}>(~${formatUsd(usd)})</span>
                                )}
                              </span>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  )}
                </span>
              </p>
            )}
            {username.length > 0 && !isValidFormat && !isTyping && (
              <p className="text-xs text-red-500 mt-0.5">
                {t('onboarding.username.format_hint')}
              </p>
            )}
            {/* Gift gate: name too expensive */}
            {nameTooExpensive && giftCaw !== undefined && username.length > 0 && !isTyping && (
              <p className="text-xs text-red-500 mt-0.5">
                This name costs {formatCawCompact(cawCost)} CAW — your invite includes {formatWeiAsCaw(giftCaw)}. Try a longer name.
              </p>
            )}
            {/* Gift gate: name too short per code minimum */}
            {belowMinLength && minUsernameLength !== undefined && username.length > 0 && !isTyping && (
              <p className="text-xs text-red-500 mt-0.5">
                Your invite requires a username of at least {minUsernameLength} characters.
              </p>
            )}
          </div>
          <div className="text-right">
            {!isTyping && usernameAvailable === true && !nameTooExpensive && !belowMinLength && (
              <p className="text-xs text-green-500">
                {t('onboarding.username.available')}
              </p>
            )}
            {!isTyping && usernameAvailable === false && (
              <p className="text-xs text-red-500">
                {t('onboarding.username.taken')}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Auto-deposit summary — shown when name is valid and gift is loaded */}
      {depositAmount !== null && usernameAvailable === true && !nameTooExpensive && !belowMinLength && !isTyping && (
        <div className={`rounded-xl p-3 text-sm flex items-center gap-2 ${isDark ? 'bg-green-500/10 border border-green-500/20' : 'bg-green-50 border border-green-200'}`}>
          <svg className="w-4 h-4 text-green-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          <span className={isDark ? 'text-green-300' : 'text-green-800'}>
            You'll receive <span className="font-semibold">{formatWeiAsCaw(depositAmount)}</span> deposited to your profile.
          </span>
        </div>
      )}

      <button
        onClick={onNext}
        disabled={!canProceed}
        className={`
          w-full py-3 rounded-full font-semibold text-sm transition-all
          ${canProceed
            ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
            : 'bg-yellow-500/30 text-black/40 cursor-not-allowed'
          }
        `}
      >
        {giftLoading ? 'Loading…' : t('common.next')}
      </button>
    </div>
  )
}
