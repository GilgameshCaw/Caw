/**
 * UsernameStep.tsx
 *
 * Step 1 of /onboarding: pick a username and verify it is available on-chain.
 * Uses wagmi's useReadContract to call cawProfileMinter.idByUsername(username)
 * — returns 0n when the name is free, a non-zero tokenId when taken.
 *
 * Availability check is debounced so we don't fire per-keystroke RPC calls.
 */

import { useState, useEffect, useMemo } from 'react'
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

export interface UsernameStepProps {
  username: string
  usernameAvailable: boolean | null
  onUsernameChange: (value: string) => void
  onAvailabilityChange: (available: boolean | null) => void
  onNext: () => void
}

export default function UsernameStep({
  username,
  usernameAvailable,
  onUsernameChange,
  onAvailabilityChange,
  onNext,
}: UsernameStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const cawPriceUsd = usePriceStore(s => s.priceMap['a-hunters-dream']) as number | undefined

  // Cost depends on username length — shorter = much more expensive. The
  // burn cost is paid in CAW at mint time and locked forever.
  const cawCost = useMemo(() => cawCostForLength(username.length), [username])
  const usdCost = cawPriceUsd !== undefined && cawCost > 0
    ? cawCost * cawPriceUsd
    : null

  // Debounced value used for the RPC call — avoids a query per keystroke
  const [debouncedUsername, setDebouncedUsername] = useState(username)

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

  // Sync availability to parent whenever it changes
  useEffect(() => {
    if (!isValidFormat || checkingUsername) {
      onAvailabilityChange(null)
      return
    }
    // existingId === 0 or undefined means free; non-zero means taken
    // idByUsername returns uint32 — wagmi types it as number
    const available = existingId === undefined || existingId === 0
    onAvailabilityChange(available)
  }, [existingId, checkingUsername, isValidFormat, onAvailabilityChange])

  const isTyping = username !== debouncedUsername || checkingUsername
  const canProceed = usernameAvailable === true

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

        {/* Hint row: cost on the left, availability state on the right.
            Both lines share the same min-height so the form doesn't jitter
            while typing / RPC checking. */}
        <div className="min-h-[1.25rem] flex items-start justify-between gap-3">
          <div className="flex-1 text-left">
            {cawCost > 0 && (
              <p className={`text-xs ${mutedClass}`}>
                Mint cost: <span className={strongClass}>{formatCawCompact(cawCost)} CAW</span>
                {usdCost !== null && <span className={mutedClass}> (~${formatUsd(usdCost)})</span>}
              </p>
            )}
            {username.length > 0 && !isValidFormat && !isTyping && (
              <p className="text-xs text-red-500 mt-0.5">
                {t('onboarding.username.format_hint')}
              </p>
            )}
          </div>
          <div className="text-right">
            {!isTyping && usernameAvailable === true && (
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

      {/* Pricing table — mirrors new_profile.pricing in pages/Profile/New.tsx.
          Collapsed by default to keep the step focused on the input row;
          users who want the schedule can expand it. */}
      <details className={`rounded-xl border ${isDark ? 'border-white/10 bg-white/[0.03]' : 'border-gray-200 bg-gray-50'}`}>
        <summary className={`px-4 py-3 cursor-pointer text-xs font-medium select-none ${strongClass}`}>
          {t('new_profile.pricing_title')}
        </summary>
        <div className="px-4 pb-3 space-y-1.5">
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
            return (
              <div key={label} className="flex justify-between items-baseline text-xs">
                <span className={mutedClass}>{label}</span>
                <span>
                  <span className={`font-mono ${strongClass}`}>{compact} CAW</span>
                  {usd !== null && <span className={`${mutedClass} ml-2`}>(~${formatUsd(usd)})</span>}
                </span>
              </div>
            )
          })}
        </div>
      </details>

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
        {t('common.next')}
      </button>
    </div>
  )
}
