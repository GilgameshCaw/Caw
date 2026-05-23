/**
 * WithdrawLockStatus
 *
 * Shown in AccountSettings when the active profile was minted via the card
 * payment path and has its withdrawals locked at the contract level.
 *
 * For MVP the "Verify identity" button shows an informational toast — the
 * full Civic Pass / zkMe widget will be wired in once the KYC adapter
 * contract is deployed on-chain.
 */

import React from 'react'
import toast from 'react-hot-toast'
import { HiLockClosed } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useWithdrawLocked } from '~/hooks/useWithdrawLocked'

interface WithdrawLockStatusProps {
  tokenId: number | undefined
}

export const WithdrawLockStatus: React.FC<WithdrawLockStatusProps> = ({ tokenId }) => {
  const { isDark } = useTheme()
  const t = useT()
  const { isLocked, isLoading } = useWithdrawLocked(tokenId)

  // Nothing to show for unlocked profiles or while loading
  if (isLoading || !isLocked) return null

  const handleVerify = () => {
    toast(t('withdraw_lock.not_available'), { duration: 4000 })
  }

  return (
    <section className="mb-8">
      <h2
        className={`text-sm font-semibold mb-2 uppercase tracking-wide ${
          isDark ? 'text-white/40' : 'text-gray-400'
        }`}
      >
        {t('withdraw_lock.title')}
      </h2>

      <div
        className={`p-4 rounded-lg border ${
          isDark
            ? 'bg-yellow-500/10 border-yellow-500/30'
            : 'bg-yellow-50 border-yellow-200'
        }`}
      >
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <HiLockClosed
              className={`w-5 h-5 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`}
            />
          </div>
          <div className="flex-1 min-w-0">
            <p
              className={`font-medium mb-1 ${
                isDark ? 'text-yellow-300' : 'text-yellow-800'
              }`}
            >
              {t('withdraw_lock.title')}
            </p>
            <p
              className={`text-sm mb-3 ${
                isDark ? 'text-yellow-300/70' : 'text-yellow-700'
              }`}
            >
              {t('withdraw_lock.body')}
            </p>
            <button
              type="button"
              onClick={handleVerify}
              className={`px-4 py-2 text-sm font-semibold rounded-full transition-colors cursor-pointer ${
                isDark
                  ? 'bg-yellow-500/20 text-yellow-300 hover:bg-yellow-500/30'
                  : 'bg-yellow-100 text-yellow-800 hover:bg-yellow-200'
              }`}
            >
              {t('withdraw_lock.verify_cta')}
            </button>
          </div>
        </div>
      </div>
    </section>
  )
}
