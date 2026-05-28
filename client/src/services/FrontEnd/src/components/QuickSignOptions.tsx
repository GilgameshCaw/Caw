import React, { useState, useMemo } from 'react'
import { HiPencil } from 'react-icons/hi'
import {
  SESSION_DURATION_OPTIONS,
} from '~/hooks/useSessionKey'
import { getTipTiers } from '~/api/actions'
import { usePriceStore } from '~/store/tokenDataStore'

/** Dollar-denominated spend limit presets */
const DOLLAR_PRESETS = [
  { label: '$5',    usd: 5 },
  { label: '$10',   usd: 10 },
  { label: '$25',   usd: 25 },
  { label: '$100',  usd: 100 },
]

function fmtUsd(amount: number): string {
  const rounded = Math.round(amount * 100) / 100
  return rounded === Math.floor(rounded) ? `$${Math.round(rounded)}` : `$${rounded.toFixed(2)}`
}

/** Format small USD amounts with 5 decimal places (used for per-action tips which are fractions of a cent). */
function fmtUsdSmall(amount: number): string {
  if (amount === 0) return '$0'
  return `$${amount.toFixed(5)}`
}

function formatSpendLimit(value: bigint): string {
  if (value === BigInt(0)) return 'no limit'
  const n = Number(value)
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}K`
  return String(n)
}

function formatDuration(seconds: number): string {
  const opt = SESSION_DURATION_OPTIONS.find(o => o.value === seconds)
  return opt?.label ?? `${Math.round(seconds / 86400)} days`
}

interface QuickSignOptionsProps {
  spendLimit: bigint
  onSpendLimitChange: (v: bigint) => void
  duration: number
  onDurationChange: (v: number) => void
  /** Tip ceiling (whole CAW tokens). 0n = "No tip" (opt-out). */
  tipCeiling?: bigint
  onTipCeilingChange?: (v: bigint) => void
  walletProtect?: boolean
  onWalletProtectChange?: (v: boolean) => void
  /** Use dark-mode-aware styling (for settings page / modal). Default: false (onboarding always-dark). */
  themed?: boolean
  isDark?: boolean
}

const QuickSignOptions: React.FC<QuickSignOptionsProps> = ({
  spendLimit,
  onSpendLimitChange,
  duration,
  onDurationChange,
  tipCeiling,
  onTipCeilingChange,
  walletProtect = false,
  onWalletProtectChange,
  themed = false,
  isDark = true,
}) => {
  const [expanded, setExpanded] = useState(false)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)

  // Convert dollar presets to CAW amounts based on live price
  const dollarOptions = useMemo(() => {
    if (!cawPrice || cawPrice <= 0) return null
    return DOLLAR_PRESETS.map(p => ({
      ...p,
      caw: BigInt(Math.round(p.usd / cawPrice)),
    }))
  }, [cawPrice])

  // Tip tiers from the validator's config. These MUST be before the early return (Rules of Hooks).
  const tiers = useMemo(() => getTipTiers(), [])

  // Check which dollar preset matches the current spend limit (if any)
  const matchedPreset = dollarOptions?.find(o => spendLimit === o.caw)

  // Style helpers — onboarding is always dark, settings/modal respect theme
  const labelClass = themed
    ? `text-sm font-medium ${isDark ? 'text-gray-300' : 'text-gray-600'}`
    : 'text-sm font-medium text-gray-300'

  const descClass = themed
    ? `text-xs mb-2 ${isDark ? 'text-white/30' : 'text-gray-400'}`
    : 'text-xs mb-2 text-white/30'

  const mutedClass = themed
    ? (isDark ? 'text-white/50' : 'text-gray-500')
    : 'text-white/50'

  const mutedLightClass = themed
    ? (isDark ? 'text-white/30' : 'text-gray-400')
    : 'text-white/30'

  // Used for the <strong> highlights in the collapsed summary. White
  // works on the dark surface, but in light-mode the same hue blended
  // into a near-white background and read as invisible — pin it to
  // the theme's body color so the bold actually renders as emphasis.
  const strongClass = themed
    ? (isDark ? 'text-white' : 'text-black')
    : 'text-white'

  const btnClass = (selected: boolean) => {
    if (selected) return 'bg-yellow-500 text-black border border-yellow-500'
    if (themed && !isDark) return 'bg-gray-100 text-gray-900 hover:bg-gray-200 border border-gray-300'
    return 'bg-white/10 text-white hover:bg-white/20 border border-white/20'
  }

  const walletProtectCheckbox = onWalletProtectChange ? (
    <div className="mt-3">
      <label className="flex items-center gap-2 cursor-pointer">
        <button
          type="button"
          role="checkbox"
          aria-checked={walletProtect}
          onClick={() => onWalletProtectChange(!walletProtect)}
          className={`w-4 h-4 rounded flex-shrink-0 flex items-center justify-center transition-colors duration-150 ${
            walletProtect
              ? 'bg-yellow-500'
              : themed && !isDark ? 'bg-gray-200 border border-gray-300' : 'bg-black border border-white/30'
          }`}
        >
          {walletProtect && (
            <svg className="w-3 h-3 text-black" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>
        <span className={`text-sm ${themed ? (isDark ? 'text-gray-300' : 'text-gray-600') : 'text-gray-300'}`}>
          Require wallet unlock each session
        </span>
      </label>
      {walletProtect && (
        <p className={`text-xs mt-1 ml-6 ${mutedLightClass}`}>
          Your signing key will be encrypted. You'll sign once when you open the app to unlock it.
        </p>
      )}
      {!walletProtect && spendLimit === 0n && (
        <p className="text-xs mt-1 ml-6 text-red-400">
          No spending limit means a compromised session key could drain all of your deposited CAW.
        </p>
      )}
    </div>
  ) : null

  // Display the tip ceiling as a dollar amount when CAW price is known.
  // Tips are tiny (often fractions of a cent), so we use 4 decimal places
  // to avoid showing "$0" for non-zero values.
  // Defined here (above the early return) so the collapsed one-liner can use it.
  const formatTipCaw = (caw: bigint): string => {
    if (caw === 0n) return 'no tip'
    if (cawPrice > 0) return fmtUsdSmall(Number(caw) * cawPrice)
    return `${formatSpendLimit(caw)} CAW`
  }

  const isNoTip = tipCeiling === 0n

  if (!expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={`w-full flex items-center justify-center gap-2 px-3 rounded-lg text-center transition-colors cursor-pointer border ${
            themed && !isDark ? 'bg-gray-50 hover:bg-gray-100 border-gray-200' : ''
          }`}
          style={!themed || isDark ? { backgroundColor: 'rgba(20, 20, 20, 0.85)', borderColor: '#1A1A1A' } : undefined}
        >
          <span className={`text-sm ${mutedClass} p-2`}>
            {/* Strong items use the theme-appropriate body color so the
                "bold" reads as emphasis against the muted summary text.
                Hardcoding text-white was invisible in light mode. */}
            Enable for <strong className={strongClass}>{formatDuration(duration)}</strong> with a security limit of <strong className={spendLimit === 0n ? 'text-red-400' : strongClass}>
              {spendLimit === 0n
                ? 'no limit'
                : cawPrice > 0
                  ? fmtUsd(Number(spendLimit) * cawPrice)
                  : `${formatSpendLimit(spendLimit)} CAW`
              }
            </strong> from your deposits.<br className="hidden sm:block" /><br className="hidden sm:block" />
            Validator tips <strong className={isNoTip ? 'text-yellow-500' : strongClass}>{tipCeiling !== undefined ? (isNoTip ? formatTipCaw(tipCeiling) : `~${formatTipCaw(tipCeiling)}`) : '—'}</strong> per action<br />and <strong className={strongClass}>{walletProtect ? 'wallet unlock required' : 'no need for wallet unlock per-session'}</strong>
          </span>
          <HiPencil className={`w-4.5 h-4.5 flex-shrink-0 ${themed ? (isDark ? 'text-white' : 'text-gray-600') : 'text-white'}`} />
        </button>
      </div>
    )
  }

  const handleNoLimit = () => {
    onSpendLimitChange(BigInt(0))
    if (onWalletProtectChange) onWalletProtectChange(true)
  }

  return (
    <div className={`space-y-4 mt-4 p-4 rounded-xl border ${
      themed && !isDark ? 'bg-gray-50 border-gray-200' : ''
    }`} style={!themed || isDark ? { backgroundColor: 'rgba(20, 20, 20, 0.85)', borderColor: '#1A1A1A' } : undefined}>
      {/* Spending limit */}
      <div>
        <p className={labelClass}>Spending limit</p>
        <p className={descClass}>Safety cap on how much deposited CAW this key can use.<br/>This is not a charge — it just limits the key's access.</p>
        <div className="flex flex-wrap gap-2">
          {dollarOptions ? (
            <>
              {dollarOptions.map(opt => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => onSpendLimitChange(opt.caw)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(spendLimit === opt.caw)}`}
                >
                  {opt.label}
                </button>
              ))}
              <button
                type="button"
                onClick={handleNoLimit}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(spendLimit === 0n)}`}
              >
                No limit
              </button>
            </>
          ) : (
            // Fallback if price not loaded yet — show raw CAW amounts
            <>
              {[10_000_000, 50_000_000, 100_000_000, 500_000_000].map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => onSpendLimitChange(BigInt(n))}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(spendLimit === BigInt(n))}`}
                >
                  {formatSpendLimit(BigInt(n))}
                </button>
              ))}
              <button
                type="button"
                onClick={handleNoLimit}
                className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(spendLimit === 0n)}`}
              >
                No limit
              </button>
            </>
          )}
        </div>
        {spendLimit > 0n && (
          <p className={`text-xs mt-1.5 text-left ${mutedLightClass}`}>
            {formatSpendLimit(spendLimit)} CAW
            {dollarOptions && matchedPreset ? '' : cawPrice > 0 ? ` ≈ ${fmtUsd(Number(spendLimit) * cawPrice)}` : ''}
          </p>
        )}
      </div>

      {/* Session duration */}
      <div>
        <p className={labelClass}>Session duration</p>
        <p className={descClass}>The key expires automatically after this period.</p>
        <div className="flex flex-wrap gap-1">
          {SESSION_DURATION_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              onClick={() => onDurationChange(opt.value)}
              className={`rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(duration === opt.value)}`}
              style={{ padding: '5px 8px' }}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Max tip per action — user sets their ceiling; Network drives the actual rate */}
      {onTipCeilingChange && (
        <div>
          <p className={labelClass}>Max tip per action (CAW)</p>
          <p className={descClass}>
            The Network sets the actual rate; this is your maximum.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min="0"
              step="1"
              value={isNoTip ? '' : String(tipCeiling ?? 0n)}
              placeholder={isNoTip ? '0' : undefined}
              disabled={isNoTip}
              onChange={e => {
                const raw = e.target.value.trim()
                if (raw === '' || raw === '0') {
                  onTipCeilingChange(0n)
                } else {
                  const parsed = parseInt(raw, 10)
                  if (!isNaN(parsed) && parsed >= 0) onTipCeilingChange(BigInt(parsed))
                }
              }}
              className={`w-36 px-3 py-1.5 rounded-lg text-sm font-medium border transition-colors ${
                themed && !isDark
                  ? 'bg-white text-black border-gray-300 focus:border-yellow-500'
                  : 'bg-white/10 text-white border-white/20 focus:border-yellow-500'
              } disabled:opacity-40`}
            />
            <button
              type="button"
              onClick={() => onTipCeilingChange(isNoTip ? tiers.fast : 0n)}
              className={`rounded-lg text-sm font-medium transition-all cursor-pointer px-3 py-1.5 ${btnClass(isNoTip)}`}
            >
              No tip
            </button>
          </div>
          {isNoTip && (
            <p className="text-xs text-red-400 mt-1.5 text-left">
              Your posts will be extremely slow, and may not get included at all.
              Most validators reject zero-tip actions.
            </p>
          )}
          {!isNoTip && tipCeiling !== undefined && tipCeiling > 0n && (
            <p className={`text-xs mt-1.5 text-left ${mutedLightClass}`}>
              ~{formatTipCaw(tipCeiling)} per action
            </p>
          )}
        </div>
      )}

      {walletProtectCheckbox}

      <p className={`text-xs text-left ${mutedLightClass} mt-4 mb-1`}>
        You can change these settings anytime in Settings.
      </p>

    </div>
  )
}

export default QuickSignOptions
