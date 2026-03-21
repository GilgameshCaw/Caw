import React, { useState } from 'react'
import { HiPencil } from 'react-icons/hi'
import {
  SPEND_LIMIT_OPTIONS,
  SESSION_DURATION_OPTIONS,
} from '~/hooks/useSessionKey'

function formatSpendLimit(value: bigint): string {
  if (value === BigInt(0)) return 'no limit'
  const n = Number(value)
  if (n >= 1_000_000) return `${n / 1_000_000}M`
  if (n >= 1_000) return `${n / 1_000}K`
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
          Enabled for <strong className="text-white">{formatDuration(duration)}</strong> with a <strong className={spendLimit === 0n ? 'text-red-400' : 'text-white'}>{formatSpendLimit(spendLimit)} CAW</strong> spending limit
        </span>
        <HiPencil className={`w-4.5 h-4.5 flex-shrink-0 ${themed ? (isDark ? 'text-white/40' : 'text-gray-400') : 'text-white/40'}`} />
      </button>
    )
  }

  return (
    <div className="space-y-4 mt-6">
      {/* Spending limit */}
      <div>
        <p className={labelClass}>Spending limit</p>
        <p className={descClass}>Max CAW this key can spend on actions and tips.</p>
        <div className="flex flex-wrap gap-2">
          {SPEND_LIMIT_OPTIONS.map(opt => (
            <button
              key={opt.label}
              type="button"
              onClick={() => onSpendLimitChange(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(spendLimit === opt.value)}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
        {spendLimit === 0n && (
          <p className="text-xs text-red-400 mt-1 text-center">
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
