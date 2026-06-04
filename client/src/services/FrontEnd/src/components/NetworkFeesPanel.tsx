import React from 'react'
import { formatUnits } from 'viem'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNetworkFees, NetworkFees } from '~/hooks/useNetworkFees'
import { usePriceStore } from '~/store/tokenDataStore'
import { formatUsd } from '~/utils/numberFormat'

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
  /**
   * Legacy: zero-fee rows used to be opt-in to hide. Now hidden by default
   * when BOTH fee and ceiling are 0 (permanently free). Kept on the interface
   * so existing callers don't break — value is ignored.
   */
  omitZeroRows?: boolean
  /**
   * When true, the per-row "max X — Operator can never raise fees above this"
   * subline is suppressed and a single right-aligned "your capped amount"
   * label is rendered on the panel's NETWORK FEES title row instead. Used by
   * the Staking withdraw panel where the value below the title is the user's
   * deposit-time-locked ceiling, so the per-row ceiling note is noise.
   */
  headerCapHint?: boolean
  className?: string
}

/** Render a network fee. Fees are stored on-chain as ETH wei; we display
 *  in USD using the live ETH price. Falls back to ETH amount when the
 *  price feed hasn't loaded.
 *  (Historically this was named formatCaw and rendered "X CAW" — the unit
 *  was wrong, fees were always ETH-denominated.) */
const formatFee = (wei: bigint, ethPrice: number): string => {
  const ethWhole = Number(formatUnits(wei, 18))
  if (ethWhole === 0) return '$0'
  if (ethPrice > 0) {
    return `$${formatUsd(ethWhole * ethPrice)}`
  }
  // No price feed: show the ETH amount as a fallback.
  if (ethWhole < 0.0001) return `${ethWhole.toExponential(2)} ETH`
  if (ethWhole < 1) return `${ethWhole.toFixed(4)} ETH`
  return `${ethWhole.toLocaleString('en-US', { maximumFractionDigits: 4 })} ETH`
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
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const display =
    value == null
      ? loadingLabel
      : value === 0n
      ? freeLabel
      : formatFee(value, ethPrice)

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
  /** Suppress the per-row "max X — Operator..." subline. Used when the caller
   *  is rendering the cap context elsewhere (e.g. as a panel-header hint). */
  suppressCeilingNote?: boolean
}> = ({ label, fee, ceiling, isDark, freeLabel, loadingLabel, ceilingNote, highlight, feeSubline, suppressCeilingNote }) => {
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const showCeilingNote =
    !suppressCeilingNote &&
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
          max {formatFee(ceiling, ethPrice)} — {ceilingNote}
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
  headerCapHint,
  className,
}) => {
  const { isDark } = useTheme()
  const t = useT()
  const fees: NetworkFees = useNetworkFees(networkId)

  const freeLabel = t('network.free')
  const loadingLabel = t('network.loading')
  const ceilingNote = t('network.fee_ceiling_note')

  // Permanently-free network: all four ceilings are 0 (locked at zero forever)
  // and all current fees are also 0.
  const permanentlyFree =
    fees.withdrawFeeCeiling === 0n &&
    fees.depositFeeCeiling === 0n &&
    fees.authFeeCeiling === 0n &&
    fees.mintFeeCeiling === 0n &&
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
      {/* Header row: "NETWORK FEES". The headerCapHint prop still suppresses
          the per-row "max X — Operator can never raise" subline below when the
          panel value is the user's deposit-time-locked ceiling (Staking
          withdraw flow); the right-aligned "your capped amount" label that
          previously rendered here was removed as redundant noise. */}
      <div
        className={`flex items-baseline justify-between text-[11px] uppercase tracking-wide mb-1 ${
          isDark ? 'text-white/40' : 'text-gray-500'
        }`}
      >
        <span>{t('network.fees_title')}</span>
      </div>

      {permanentlyFree ? (
        <div className={`text-sm ${isDark ? 'text-green-300' : 'text-green-700'}`}>
          {t('network.no_fees')}
        </div>
      ) : (
        <>
          {/* Each row is hidden when the Network has both `fee` and `ceiling` at
              0 — that's the "permanently free" combo (ceiling can only drop, so
              once it's 0 the fee can never come back). The legacy `omitZeroRows`
              flag only checked the current fee, which incorrectly hid temporarily-
              zero rows where the ceiling still allowed the operator to raise. */}
          {show.includes('deposit') && !(fees.depositFee === 0n && fees.depositFeeCeiling === 0n) && (
            <FeeLineWithCeiling
              label={t('network.deposit_fee')}
              fee={fees.depositFee}
              ceiling={fees.depositFeeCeiling}
              isDark={isDark}
              freeLabel={freeLabel}
              loadingLabel={loadingLabel}
              ceilingNote={ceilingNote}
            />
          )}

          {show.includes('auth') && !(fees.authFee === 0n && fees.authFeeCeiling === 0n) && (
            <FeeLineWithCeiling
              // If a Network charges any auth fee at all, every action triggers
              // it (it's not opt-in / extra-network), so make the copy explicit.
              label={t('network.auth_fee_required')}
              fee={fees.authFee}
              ceiling={fees.authFeeCeiling}
              isDark={isDark}
              freeLabel={freeLabel}
              loadingLabel={loadingLabel}
              ceilingNote={ceilingNote}
            />
          )}

          {show.includes('mint') && !(fees.mintFee === 0n && fees.mintFeeCeiling === 0n) && (
            <FeeLineWithCeiling
              label={t('network.mint_fee')}
              fee={fees.mintFee}
              ceiling={fees.mintFeeCeiling}
              isDark={isDark}
              freeLabel={freeLabel}
              loadingLabel={loadingLabel}
              ceilingNote={ceilingNote}
            />
          )}

          {show.includes('withdraw') && !(fees.withdrawFee === 0n && fees.withdrawFeeCeiling === 0n) && (
            <>
              {cachedWithdrawFee != null ? (
                <>
                  <FeeLineWithCeiling
                    label={t('network.withdraw_fee_cached')}
                    fee={cachedWithdrawFee}
                    ceiling={fees.withdrawFeeCeiling}
                    isDark={isDark}
                    freeLabel={freeLabel}
                    loadingLabel={loadingLabel}
                    ceilingNote={ceilingNote}
                    highlight
                    feeSubline={t('network.applies_to_this_withdraw')}
                    suppressCeilingNote={headerCapHint}
                  />
                  {fees.withdrawFee != null && fees.withdrawFee !== cachedWithdrawFee && (
                    <FeeLineWithCeiling
                      label={t('network.withdraw_fee_current')}
                      fee={fees.withdrawFee}
                      ceiling={fees.withdrawFeeCeiling}
                      isDark={isDark}
                      freeLabel={freeLabel}
                      loadingLabel={loadingLabel}
                      ceilingNote={ceilingNote}
                      feeSubline={t('network.applies_to_future')}
                      suppressCeilingNote={headerCapHint}
                    />
                  )}
                </>
              ) : (
                <FeeLineWithCeiling
                  label={t('network.withdraw_fee')}
                  fee={fees.withdrawFee}
                  ceiling={fees.withdrawFeeCeiling}
                  isDark={isDark}
                  freeLabel={freeLabel}
                  loadingLabel={loadingLabel}
                  ceilingNote={ceilingNote}
                  feeSubline={showCacheExplainer ? t('network.caches_at_deposit') : undefined}
                  suppressCeilingNote={headerCapHint}
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
