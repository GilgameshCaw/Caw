import React, { useState, useMemo, useEffect, useRef } from 'react'
import { HiPencil } from 'react-icons/hi'
import {
  SESSION_DURATION_OPTIONS,
} from '~/hooks/useSessionKey'
import { usePriceStore } from '~/store/tokenDataStore'
import { useValidatorMinTips, countAcceptingValidators } from '~/hooks/useValidatorMinTips'

/** Dollar-denominated spend limit presets */
const DOLLAR_PRESETS = [
  { label: '$5',    usd: 5 },
  { label: '$10',   usd: 10 },
  { label: '$25',   usd: 25 },
  { label: '$100',  usd: 100 },
]

/** Dollar-denominated per-action tip presets, ordered most→least (left→right).
 *  $0.0009 is the max and the recommended default (accepted by the most
 *  validators / fastest). Tips are fractions of a cent, so the steps are tiny.
 *  "No tip" is rendered separately after these. */
const TIP_USD_PRESETS = [
  { usd: 0.0009, recommended: true },
  { usd: 0.0005 },
  { usd: 0.0002 },
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
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const { minTipsMap, total: validatorTotal, isLoading: validatorLoading } = useValidatorMinTips()
  // Controlled USD input for tip ceiling
  const [tipUsdInput, setTipUsdInput] = useState<string>('')
  const [tipInputFocused, setTipInputFocused] = useState(false)

  // Convert dollar presets to CAW amounts based on live price
  const dollarOptions = useMemo(() => {
    if (!cawPrice || cawPrice <= 0) return null
    return DOLLAR_PRESETS.map(p => ({
      ...p,
      caw: BigInt(Math.round(p.usd / cawPrice)),
    }))
  }, [cawPrice])

  // Per-action tip presets in dollars → CAW. Label is the dollar amount.
  const tipDollarOptions = useMemo(() => {
    if (!cawPrice || cawPrice <= 0) return null
    return TIP_USD_PRESETS.map(p => ({
      ...p,
      label: fmtUsdSmall(p.usd).replace(/0+$/, '').replace(/\.$/, ''),
      caw: BigInt(Math.max(1, Math.round(p.usd / cawPrice))),
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

  // Keep the USD text input in sync with external tipCeiling changes (e.g. network default arriving)
  // but don't clobber whatever the user is actively typing.
  const prevTipCeilingRef = useRef<bigint | undefined>(tipCeiling)
  useEffect(() => {
    if (!tipInputFocused && tipCeiling !== prevTipCeilingRef.current) {
      prevTipCeilingRef.current = tipCeiling
      if (tipCeiling === undefined || tipCeiling === 0n) {
        setTipUsdInput('')
      } else if (cawPrice > 0) {
        const usd = Number(tipCeiling) * cawPrice
        // Show at least 4 decimal places for sub-cent values
        const formatted = usd < 0.01 ? usd.toFixed(5) : usd.toFixed(3)
        setTipUsdInput(formatted)
      } else {
        setTipUsdInput('')
      }
    }
  }, [tipCeiling, cawPrice, tipInputFocused])

  // Handler: user edits the USD input — convert to whole CAW and propagate
  const handleTipUsdChange = (raw: string) => {
    setTipUsdInput(raw)
    if (!onTipCeilingChange) return
    if (raw === '' || raw === '0') {
      onTipCeilingChange(0n)
      return
    }
    const usd = parseFloat(raw)
    if (isNaN(usd) || usd < 0) return
    if (cawPrice > 0) {
      const caw = BigInt(Math.max(1, Math.round(usd / cawPrice)))
      onTipCeilingChange(caw)
      prevTipCeilingRef.current = caw
    }
  }

  if (!expanded) {
    // Collapsed summary: a compact 3-column read-out of the current params
    // (spend limit / tip per action / expiry) with an edit pencil that opens
    // the full picker. Owning both states here means every consumer
    // (onboarding, renew modal) gets the same summary-then-edit UX.
    const spendDisplay = spendLimit === 0n
      ? 'no limit'
      : cawPrice > 0
        ? fmtUsd(Number(spendLimit) * cawPrice)
        : `${formatSpendLimit(spendLimit)} CAW`
    const tipDisplay = tipCeiling === undefined
      ? '—'
      : isNoTip
        ? formatTipCaw(tipCeiling)
        : `~${formatTipCaw(tipCeiling)}`
    const colLabel = themed ? (isDark ? 'text-gray-400' : 'text-gray-600') : 'text-gray-400'
    const colValue = themed ? (isDark ? 'text-white' : 'text-gray-900') : 'text-white'
    return (
      <div className={`pt-2 mt-2 border-t ${
        themed && !isDark ? 'border-gray-200' : 'border-white/10'
      }`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex-1 flex justify-around items-start text-xs">
            <div className="flex flex-col items-center text-center">
              <span className={colLabel}>Spend limit</span>
              <span className={`font-mono ${spendLimit === 0n ? 'text-red-400' : colValue}`}>{spendDisplay}</span>
            </div>
            <div className="flex flex-col items-center text-center">
              <span className={colLabel}>Tip / action</span>
              <span className={`font-mono ${isNoTip ? 'text-yellow-500' : colValue}`}>{tipDisplay}</span>
            </div>
            <div className="flex flex-col items-center text-center">
              <span className={colLabel}>Expires in</span>
              <span className={`font-mono ${colValue}`}>{formatDuration(duration)}</span>
            </div>
          </div>
          <button
            type="button"
            aria-label="Edit Quick Sign parameters"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setExpanded(true) }}
            className={`flex items-center cursor-pointer flex-shrink-0 ${
              themed ? (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-500 hover:text-gray-900') : 'text-white/70 hover:text-white'
            }`}
          >
            <HiPencil className="w-4 h-4" />
          </button>
        </div>
        {onWalletProtectChange && (
          <div className={`flex items-center justify-center gap-1 mt-2 pt-2 border-t text-xs ${
            themed && !isDark ? 'border-gray-200' : 'border-white/10'
          }`}>
            <span className={colLabel}>Quick Sign Key:</span>
            <span className={`font-mono ${colValue}`}>{walletProtect ? 'Require unlock' : 'Always unlocked'}</span>
          </div>
        )}
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

      {/* Tip speed — determines how quickly validators process your actions */}
      {onTipCeilingChange && (
        <div>
          <p className={labelClass}>Tip per action</p>
          <p className={descClass}>
            Validators pay LayerZero fees to publish your actions on-chain; your tip
            rewards them. Each validator sets the minimum tip it will accept, and
            those preferences can change at any time — a higher tip is accepted by
            more validators and gets your actions processed faster.
          </p>
          {/* USD input */}
          <div className="flex items-center gap-2 mb-2">
            <span className={`text-sm ${mutedClass}`}>$</span>
            <input
              type="number"
              min="0"
              step="0.00001"
              value={tipUsdInput}
              placeholder="0.001"
              onFocus={() => setTipInputFocused(true)}
              onBlur={() => setTipInputFocused(false)}
              onChange={e => handleTipUsdChange(e.target.value)}
              className={`w-28 px-2 py-1 rounded-lg text-sm border outline-none transition-colors ${
                themed && !isDark
                  ? 'bg-white text-gray-900 border-gray-300 focus:border-yellow-500'
                  : 'bg-white/10 text-white border-white/20 focus:border-yellow-500'
              }`}
            />
          </div>
          {/* Dollar presets — $0.0009 is the max + recommended default. */}
          <div className="flex flex-wrap gap-1">
            {(tipDollarOptions ?? []).map(p => (
              <button
                key={p.usd}
                type="button"
                onClick={() => {
                  onTipCeilingChange(p.caw)
                  setTipUsdInput(p.usd.toFixed(5).replace(/0+$/, '').replace(/\.$/, ''))
                }}
                className={`rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(tipCeiling === p.caw)}`}
                style={{ padding: '5px 8px' }}
                title={p.recommended ? 'Recommended — accepted by the most validators' : undefined}
              >
                {p.label}{p.recommended ? ' ★' : ''}
              </button>
            ))}
            <button
              type="button"
              onClick={() => { onTipCeilingChange(0n); setTipUsdInput('') }}
              className={`rounded-lg text-sm font-medium transition-all cursor-pointer ${btnClass(isNoTip)}`}
              style={{ padding: '5px 8px' }}
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
          {/* Validator acceptance indicator (#170) — shows how many discovered
              mirrors will accept this ceiling. Validators publish their floor
              via /api/validator-analytics/tip-config; min-tip wei is converted
              against the user's signed CAW ceiling via current ETH/CAW spot. */}
          {tipCeiling !== undefined && !validatorLoading && validatorTotal > 0 && (() => {
            const { accepting, total: tot, minFloorWei } = countAcceptingValidators(
              minTipsMap,
              validatorTotal,
              tipCeiling,
              cawPrice,
              ethPrice,
            )
            if (accepting === 0 && tot > 0) {
              let minRequiredCaw = ''
              if (minFloorWei > 0n && cawPrice > 0 && ethPrice > 0) {
                const cawInEth = cawPrice / ethPrice
                const minCaw = Math.ceil(Number(minFloorWei) / 1e18 / cawInEth)
                minRequiredCaw = minCaw > 0 ? ` Raise to ≥ ${minCaw.toLocaleString()} CAW to be accepted by all.` : ''
              }
              return (
                <p className="text-xs text-red-400 mt-1.5 text-left">
                  No validators will process actions at this tip rate.{minRequiredCaw}
                </p>
              )
            }
            if (accepting < tot) {
              return (
                <p className={`text-xs mt-1.5 text-left ${mutedLightClass}`}>
                  Accepted by {accepting} of {tot} validator{tot !== 1 ? 's' : ''}.
                </p>
              )
            }
            return (
              <p className={`text-xs mt-1.5 text-left ${mutedLightClass}`}>
                Accepted by all {tot} validator{tot !== 1 ? 's' : ''}.
              </p>
            )
          })()}
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
