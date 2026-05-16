import React from 'react'
import { formatUnits } from 'viem'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNetworkFees, NetworkFees } from '~/hooks/useNetworkFees'

type FeeKey = 'deposit' | 'auth' | 'withdraw' | 'mint'

export interface NetworkFeesPanelProps {
  networkId: number | undefined
  /** Which fee rows to render. Order is preserved. */
  show: FeeKey[]
  /**
   * When true, show the "withdraw fee caches at deposit time" explainer.
   * Use only in the deposit flow.
   */
  showCacheExplainer?: boolean
  /**
   * A pre-cached withdraw fee (in wei) for users who already deposited.
   * When provided, the withdraw row renders this value and labels it as the
   * fee that applies to their existing position. If the live withdraw fee
   * differs, both are shown so the user can see the delta.
   */
  cachedWithdrawFee?: bigint | null
  /** Hide rows whose value is exactly 0 instead of rendering "Free". */
  omitZeroRows?: boolean
  className?: string
}

const formatCaw = (wei: bigint): string => {
  const whole = Number(formatUnits(wei, 18))
  if (whole === 0) return '0'
  if (whole < 0.0001) return whole.toExponential(2)
  if (whole < 1) return whole.toFixed(4)
  return whole.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

const FeeRow: React.FC<{
  label: string
  value: bigint | null
  isDark: boolean
  freeLabel: string
  loadingLabel: string
  highlight?: boolean
  subline?: string
}> = ({ label, value, isDark, freeLabel, loadingLabel, highlight, subline }) => {
  const display =
    value == null
      ? loadingLabel
      : value === 0n
      ? freeLabel
      : `${formatCaw(value)} CAW`

  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <span className={isDark ? 'text-white/60' : 'text-gray-600'}>{label}</span>
      <span
        className={`font-mono ${
          highlight
            ? isDark
              ? 'text-yellow-300'
              : 'text-yellow-700'
            : isDark
            ? 'text-white'
            : 'text-gray-900'
        }`}
      >
        {display}
        {subline && (
          <span className={`block text-[10px] font-normal ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
            {subline}
          </span>
        )}
      </span>
    </div>
  )
}

/**
 * Shared "fee + ceiling" line. Shows the ceiling subline only when:
 * - ceiling is known (non-null)
 * - ceiling > 0 (zero means permanently free — handled at panel level)
 * - ceiling !== currentFee (no information value if already at max)
 */
export const FeeLineWithCeiling: React.FC<{
  label: string
  fee: bigint | null
  ceiling: bigint | null
  isDark: boolean
  freeLabel: string
  loadingLabel: string
  ceilingNote: string
  highlight?: boolean
  feeSubline?: string
}> = ({ label, fee, ceiling, isDark, freeLabel, loadingLabel, ceilingNote, highlight, feeSubline }) => {
  const showCeilingNote =
    ceiling != null &&
    ceiling > 0n &&
    fee != null &&
    ceiling !== fee

  return (
    <div className="space-y-0.5">
      <FeeRow
        label={label}
        value={fee}
        isDark={isDark}
        freeLabel={freeLabel}
        loadingLabel={loadingLabel}
        highlight={highlight}
        subline={feeSubline}
      />
      {showCeilingNote && (
        <div className={`flex justify-end text-[10px] ${isDark ? 'text-white/35' : 'text-gray-400'}`}>
          max {formatCaw(ceiling)} CAW — {ceilingNote}
        </div>
      )}
    </div>
  )
}

const NetworkFeesPanel: React.FC<NetworkFeesPanelProps> = ({
  networkId,
  show,
  showCacheExplainer,
  cachedWithdrawFee,
  omitZeroRows,
  className,
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const fees: NetworkFees = useNetworkFees(networkId)

  const freeLabel = t('network.free')
  const loadingLabel = t('network.loading')
  const ceilingNote = t('network.fee_ceiling_note')

  // Permanently-free network: ceiling is 0 and all current fees are also 0.
  const permanentlyFree =
    fees.feeCeiling === 0n &&
    fees.depositFee === 0n &&
    fees.authFee === 0n &&
    fees.withdrawFee === 0n &&
    fees.mintFee === 0n

  return (
    <div
      className={`rounded-lg border px-3 py-2.5 space-y-1.5 ${
        isDark ? 'border-white/10 bg-white/[0.03]' : 'border-gray-200 bg-gray-50'
      } ${className ?? ''}`}
    >
      <div
        className={`text-[11px] uppercase tracking-wide mb-1 ${
          isDark ? 'text-white/40' : 'text-gray-500'
        }`}
      >
        {t('network.fees_title')}
      </div>

      {permanentlyFree ? (
        <div className={`text-sm ${isDark ? 'text-green-300' : 'text-green-700'}`}>
          {t('network.no_fees')}
        </div>
      ) : (
        <>
          {show.includes('deposit') && !(omitZeroRows && fees.depositFee === 0n) && (
            <FeeLineWithCeiling
              label={t('network.deposit_fee')}
              fee={fees.depositFee}
              ceiling={fees.feeCeiling}
              isDark={isDark}
              freeLabel={freeLabel}
              loadingLabel={loadingLabel}
              ceilingNote={ceilingNote}
            />
          )}

          {show.includes('auth') && !(omitZeroRows && fees.authFee === 0n) && (
            <FeeLineWithCeiling
              label={t('network.auth_fee')}
              fee={fees.authFee}
              ceiling={fees.feeCeiling}
              isDark={isDark}
              freeLabel={freeLabel}
              loadingLabel={loadingLabel}
              ceilingNote={ceilingNote}
            />
          )}

          {show.includes('mint') && !(omitZeroRows && fees.mintFee === 0n) && (
            <FeeLineWithCeiling
              label={t('network.mint_fee')}
              fee={fees.mintFee}
              ceiling={fees.feeCeiling}
              isDark={isDark}
              freeLabel={freeLabel}
              loadingLabel={loadingLabel}
              ceilingNote={ceilingNote}
            />
          )}

          {show.includes('withdraw') && !(omitZeroRows && fees.withdrawFee === 0n) && (
            <>
              {cachedWithdrawFee != null ? (
                <>
                  <FeeLineWithCeiling
                    label={t('network.withdraw_fee_cached')}
                    fee={cachedWithdrawFee}
                    ceiling={fees.feeCeiling}
                    isDark={isDark}
                    freeLabel={freeLabel}
                    loadingLabel={loadingLabel}
                    ceilingNote={ceilingNote}
                    highlight
                    feeSubline={t('network.applies_to_this_withdraw')}
                  />
                  {fees.withdrawFee != null && fees.withdrawFee !== cachedWithdrawFee && (
                    <FeeLineWithCeiling
                      label={t('network.withdraw_fee_current')}
                      fee={fees.withdrawFee}
                      ceiling={fees.feeCeiling}
                      isDark={isDark}
                      freeLabel={freeLabel}
                      loadingLabel={loadingLabel}
                      ceilingNote={ceilingNote}
                      feeSubline={t('network.applies_to_future')}
                    />
                  )}
                </>
              ) : (
                <FeeLineWithCeiling
                  label={t('network.withdraw_fee')}
                  fee={fees.withdrawFee}
                  ceiling={fees.feeCeiling}
                  isDark={isDark}
                  freeLabel={freeLabel}
                  loadingLabel={loadingLabel}
                  ceilingNote={ceilingNote}
                  feeSubline={showCacheExplainer ? t('network.caches_at_deposit') : undefined}
                />
              )}
            </>
          )}

          {showCacheExplainer && (
            <p
              className={`text-[11px] leading-snug pt-1 ${
                isDark ? 'text-white/50' : 'text-gray-500'
              }`}
            >
              {t('network.fee_cached_explainer')}
            </p>
          )}
        </>
      )}
    </div>
  )
}

export default NetworkFeesPanel
