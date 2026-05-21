/**
 * DepositStep.tsx
 *
 * Step 2 of /onboarding: choose how many CAW tokens to deposit into the profile.
 * Minimum is MIN_DEPOSIT_CAW (1,000,000 CAW in base units = 1e24 wei, but UI
 * uses human-readable "CAW" units where 1 CAW = 1e18 base units).
 *
 * Slider and numeric input stay in sync. Validation gates the Next button.
 * If a price hook is available it shows a CAW → USD estimate.
 */

import { useState, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { usePriceStore } from '~/store/tokenDataStore'

// Coingecko ID used in the price map for CAW
const CAW_PRICE_KEY = 'a-hunters-dream'

/** 1,000,000 CAW expressed as a bigint in base units (1e6 * 1e18) */
export const MIN_DEPOSIT_CAW = 1_000_000n * 10n ** 18n

/** Human-readable minimum (used in UI labels) */
const MIN_HUMAN = 1_000_000

/** Slider range: 1M → 50M CAW (human units) */
const SLIDER_MIN_HUMAN = MIN_HUMAN
const SLIDER_MAX_HUMAN = 50_000_000

/** Convert human CAW units to base unit bigint */
function humanToBigInt(human: number): bigint {
  return BigInt(Math.round(human)) * 10n ** 18n
}

function formatCaw(human: number): string {
  if (human >= 1_000_000) return `${(human / 1_000_000).toFixed(1)}M`
  if (human >= 1_000) return `${(human / 1_000).toFixed(0)}K`
  return human.toString()
}

export interface DepositStepProps {
  depositAmount: bigint
  onDepositChange: (amount: bigint) => void
  onNext: () => void
  onBack: () => void
}

export default function DepositStep({
  depositAmount,
  onDepositChange,
  onNext,
  onBack,
}: DepositStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const priceMap = usePriceStore(s => s.priceMap)

  // Keep a local human-readable string for the text input
  const currentHuman = Number(depositAmount / 10n ** 18n)
  const [inputValue, setInputValue] = useState(currentHuman.toString())

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const borderBase = isDark ? 'border-white/20' : 'border-gray-300'
  const borderFocus = 'focus:outline-none focus:ring-2 focus:ring-yellow-500/50 focus:border-yellow-500'
  const inputBg = isDark ? 'bg-white/5' : 'bg-white'

  const isBelowMin = depositAmount < MIN_DEPOSIT_CAW
  const canProceed = !isBelowMin

  // USD price estimate (optional — shows only when CAW price is known)
  const cawPriceUsd: number | undefined = priceMap[CAW_PRICE_KEY]
  const usdEstimate =
    cawPriceUsd !== undefined
      ? (currentHuman * cawPriceUsd).toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          maximumFractionDigits: 2,
        })
      : undefined

  const handleSliderChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const human = parseInt(e.target.value, 10)
      setInputValue(human.toString())
      onDepositChange(humanToBigInt(human))
    },
    [onDepositChange],
  )

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const raw = e.target.value.replace(/[^0-9]/g, '')
      setInputValue(raw)
      const parsed = parseInt(raw || '0', 10)
      if (!isNaN(parsed)) {
        onDepositChange(humanToBigInt(parsed))
      }
    },
    [onDepositChange],
  )

  const handleInputBlur = useCallback(() => {
    // Snap to min on blur if below minimum
    const parsed = parseInt(inputValue || '0', 10)
    if (isNaN(parsed) || parsed < MIN_HUMAN) {
      setInputValue(MIN_HUMAN.toString())
      onDepositChange(MIN_DEPOSIT_CAW)
    }
  }, [inputValue, onDepositChange])

  const sliderValue = Math.min(
    Math.max(currentHuman, SLIDER_MIN_HUMAN),
    SLIDER_MAX_HUMAN,
  )

  return (
    <div className="space-y-6">
      <div>
        <h2 className={`text-xl font-bold mb-1 ${strongClass}`}>
          {t('onboarding.deposit.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.deposit.subtitle')}
        </p>
      </div>

      {/* Amount display */}
      <div className={`rounded-xl p-4 text-center ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <div className={`text-3xl font-bold ${strongClass}`}>
          {formatCaw(currentHuman)} <span className="text-yellow-500">CAW</span>
        </div>
        {usdEstimate && (
          <div className={`text-sm mt-1 ${mutedClass}`}>{usdEstimate}</div>
        )}
      </div>

      {/* Slider */}
      <div className="space-y-2">
        <input
          type="range"
          min={SLIDER_MIN_HUMAN}
          max={SLIDER_MAX_HUMAN}
          step={100_000}
          value={sliderValue}
          onChange={handleSliderChange}
          className="w-full accent-yellow-500 cursor-pointer"
        />
        <div className={`flex justify-between text-xs ${mutedClass}`}>
          <span>{formatCaw(SLIDER_MIN_HUMAN)} CAW</span>
          <span>{formatCaw(SLIDER_MAX_HUMAN)} CAW</span>
        </div>
      </div>

      {/* Text input for precise entry */}
      <div className="space-y-1">
        <label className={`block text-sm font-medium ${strongClass}`}>
          {t('onboarding.deposit.custom_amount')}
        </label>
        <div className="relative">
          <input
            type="text"
            inputMode="numeric"
            value={inputValue}
            onChange={handleInputChange}
            onBlur={handleInputBlur}
            className={`
              w-full px-4 py-3 pr-16 rounded-xl border text-sm transition-colors
              ${inputBg} ${strongClass} ${borderBase} ${borderFocus}
            `}
          />
          <span className={`absolute right-3 top-1/2 -translate-y-1/2 text-sm font-medium ${mutedClass}`}>
            CAW
          </span>
        </div>
        {isBelowMin && (
          <p className="text-xs text-red-500">
            {t('onboarding.deposit.below_minimum', { min: formatCaw(MIN_HUMAN) })}
          </p>
        )}
      </div>

      {/* Info box */}
      <div className={`rounded-xl p-4 text-sm space-y-1 ${isDark ? 'bg-yellow-500/10 border border-yellow-500/20' : 'bg-yellow-50 border border-yellow-200'}`}>
        <p className={`font-medium ${isDark ? 'text-yellow-400' : 'text-yellow-800'}`}>
          {t('onboarding.deposit.info_title')}
        </p>
        <p className={isDark ? 'text-yellow-300/70' : 'text-yellow-700'}>
          {t('onboarding.deposit.info_body')}
        </p>
      </div>

      <div className="flex gap-3">
        <button
          onClick={onBack}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all border cursor-pointer
            ${isDark
              ? 'border-white/20 text-white/70 hover:bg-white/5'
              : 'border-gray-300 text-gray-600 hover:bg-gray-50'
            }
          `}
        >
          {t('common.back')}
        </button>
        <button
          onClick={onNext}
          disabled={!canProceed}
          className={`
            flex-1 py-3 rounded-full font-semibold text-sm transition-all
            ${canProceed
              ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
              : 'bg-yellow-500/30 text-black/40 cursor-not-allowed'
            }
          `}
        >
          {t('common.next')}
        </button>
      </div>
    </div>
  )
}
