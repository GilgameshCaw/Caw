import React, { useState, useMemo } from 'react'
import { HiPencil } from 'react-icons/hi'
import {
  SESSION_DURATION_OPTIONS,
} from '~/hooks/useSessionKey'
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
  /** Use dark-mode-aware styling (for settings page / modal). Default: false (onboarding always-dark). */
  themed?: boolean
  isDark?: boolean
}

const QuickSignOptions: React.FC<QuickSignOptionsProps> = ({
  spendLimit,
  onSpendLimitChange,
  duration,
  onDurationChange,
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

  const btnClass = (selected: boolean) => {
    if (selected) return 'bg-yellow-500 text-black'
    if (themed && !isDark) return 'bg-gray-100 text-gray-900 hover:bg-gray-200'
    return 'bg-white/10 text-white hover:bg-white/20'
  }

  if (!expanded) {
    return (
      <div>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className={`w-full flex items-center justify-center gap-2 px-3 rounded-lg text-center transition-colors cursor-pointer ${
            themed
              ? isDark ? 'bg-white/5 hover:bg-white/10' : 'bg-gray-50 hover:bg-gray-100'
              : 'bg-white/5 hover:bg-white/10'
          }`}
        >
          <span className={`text-sm ${mutedClass} p-2`}>
            Enable for <strong className="text-white">{formatDuration(duration)}</strong> with a security limit of <strong className={spendLimit === 0n ? 'text-red-400' : 'text-white'}>
              {spendLimit === 0n
                ? 'no limit'
                : cawPrice > 0
                  ? fmtUsd(Number(spendLimit) * cawPrice)
                  : `${formatSpendLimit(spendLimit)} CAW`
              }
            </strong> from your deposits
          </span>
          <HiPencil className={`w-4.5 h-4.5 flex-shrink-0 ${themed ? (isDark ? 'text-white' : 'text-gray-600') : 'text-white'}`} />
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-4 mt-6">
      {/* Spending limit */}
      <div>
        <p className={labelClass}>Spending limit</p>
        <p className={descClass}>Safety cap on how much staked CAW this key can use.<br/>This is not a charge — it just limits the key's access.</p>
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
                onClick={() => onSpendLimitChange(BigInt(0))}
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
                onClick={() => onSpendLimitChange(BigInt(0))}
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
        {spendLimit === 0n && (
          <p className="text-xs text-red-400 mt-1 text-left">
            No spending limit means a compromised<br/>session key could drain your staked CAW.
          </p>
        )}
      </div>

      {/* Session duration */}
      <div>
        <p className={labelClass}>Session duration</p>
        <p className={descClass}>The key expires automatically after this period.</p>
        <div className="flex flex-wrap gap-2">
          {SESSION_DURATION_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              onClick={() => onDurationChange(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(duration === opt.value)}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <p className={`text-xs text-left ${mutedLightClass} mb-6`}>
        You can change these settings anytime in Settings.
      </p>

    </div>
  )
}

export default QuickSignOptions
