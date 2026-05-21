/**
 * SalesProceedsBanner
 *
 * Visible only when the connected wallet has unclaimed sale proceeds sitting
 * in cawProfileMarketplace.pendingPayouts[seller] (V2 H-15 pull-payout model).
 *
 * Renders two paths:
 * - "Claim to this wallet" — calls withdrawPayouts()
 * - "Send to a different address" — expands an input that calls withdrawPayoutsTo(recipient)
 *
 * Note: after a sale the seller's CAW balance does NOT update automatically —
 * proceeds queue here until claimed.
 */

import React, { useState } from 'react'
import { formatUnits, isAddress } from 'viem'
import { useAccount } from 'wagmi'
import { useTheme } from '~/hooks/useTheme'
import { themeText, themeTextMuted, themeBorder, themeBgSubtle } from '~/utils/theme'
import { useMarketplacePayouts } from '~/hooks/useMarketplacePayouts'
import { useT } from '~/i18n/I18nProvider'

function formatCaw(wei: bigint): string {
  const whole = Number(formatUnits(wei, 18))
  if (whole === 0) return '0'
  if (whole < 0.0001) return whole.toExponential(2)
  if (whole < 1) return whole.toFixed(4)
  return whole.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export const SalesProceedsBanner: React.FC = () => {
  const { isDark } = useTheme()
  const t = useT()
  const { address } = useAccount()
  const { pending, loaded, withdraw, withdrawTo, isPending, isConfirming } = useMarketplacePayouts(
    address as `0x${string}` | undefined
  )

  const [showAlternate, setShowAlternate] = useState(false)
  const [altAddress, setAltAddress] = useState('')

  // Only render once we have a confirmed non-zero balance.
  if (!loaded || !address || !pending || pending === 0n) return null

  const busy = isPending || isConfirming

  const handleWithdrawTo = () => {
    if (!isAddress(altAddress)) return
    withdrawTo(altAddress as `0x${string}`)
  }

  return (
    <div
      className={`mb-4 rounded-xl border ${themeBorder(isDark)} ${themeBgSubtle(isDark)} overflow-hidden`}
      role="region"
      aria-label={t('marketplace.proceeds_banner_label')}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3 min-w-0">
          <span className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-green-500/20 text-green-500 text-lg flex-shrink-0">
            $
          </span>
          <div className="min-w-0">
            <div className={`font-semibold ${themeText(isDark)}`}>
              {t('marketplace.proceeds_title')}
            </div>
            <div className={`text-xs ${themeTextMuted(isDark)}`}>
              {formatCaw(pending)} CAW
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            type="button"
            onClick={withdraw}
            disabled={busy}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-green-500 text-black hover:bg-green-400 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer"
          >
            {isPending
              ? t('marketplace.proceeds_claiming')
              : isConfirming
              ? t('marketplace.proceeds_confirming')
              : t('marketplace.proceeds_claim')}
          </button>
          <button
            type="button"
            onClick={() => setShowAlternate(v => !v)}
            disabled={busy}
            className={`px-2 py-1.5 rounded-lg text-xs ${themeTextMuted(isDark)} hover:opacity-70 transition cursor-pointer disabled:cursor-not-allowed`}
            title={t('marketplace.proceeds_send_to_other')}
          >
            {showAlternate ? '▾' : '▸'}
          </button>
        </div>
      </div>

      {/* Alternate recipient */}
      {showAlternate && (
        <div className={`border-t ${themeBorder(isDark)} px-4 py-3 flex gap-2 items-center`}>
          <input
            type="text"
            value={altAddress}
            onChange={e => setAltAddress(e.target.value)}
            placeholder="0x…"
            className={`flex-1 min-w-0 rounded-lg border px-3 py-1.5 text-sm font-mono
              ${themeBorder(isDark)}
              ${isDark ? 'bg-white/5 text-white placeholder:text-white/30' : 'bg-white text-gray-900 placeholder:text-gray-400'}
              focus:outline-none focus:ring-2 focus:ring-green-500/50`}
          />
          <button
            type="button"
            onClick={handleWithdrawTo}
            disabled={busy || !isAddress(altAddress)}
            className="px-3 py-1.5 rounded-lg text-sm font-semibold bg-green-500 text-black hover:bg-green-400 disabled:opacity-50 disabled:cursor-not-allowed transition cursor-pointer flex-shrink-0"
          >
            {t('marketplace.proceeds_send')}
          </button>
        </div>
      )}
    </div>
  )
}

export default SalesProceedsBanner
