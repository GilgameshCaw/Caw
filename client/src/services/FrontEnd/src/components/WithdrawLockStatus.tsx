/**
 * WithdrawLockStatus
 *
 * Shown in AccountSettings when the active profile has a withdraw gate set.
 * Two variants depending on the gate kind:
 *
 *   - 'time_lock' (level 1) — 180-day stored-value countdown. No action; the
 *     lock unlocks automatically. We render the unlock date + days remaining.
 *
 *   - 'kyc' (level ≥ 2) — user must complete KYC via the configured verifier
 *     before they can withdraw. We render a "Verify identity" button. The full
 *     Civic Pass / zkMe widget will be wired in once the KYC adapter contract
 *     is deployed; for MVP the button shows an informational toast.
 */

import React from 'react'
import toast from 'react-hot-toast'
import { HiLockClosed, HiClock } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useWithdrawLocked } from '~/hooks/useWithdrawLocked'

interface WithdrawLockStatusProps {
  tokenId: number | undefined
}

function formatUnlockDate(unlockAtSec: number): string {
  return new Date(unlockAtSec * 1000).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

function daysUntil(unlockAtSec: number): number {
  return Math.max(0, Math.ceil((unlockAtSec - Date.now() / 1000) / 86400))
}

export const WithdrawLockStatus: React.FC<WithdrawLockStatusProps> = ({ tokenId }) => {
  const { isDark } = useTheme()
  const t = useT()
  const lock = useWithdrawLocked(tokenId)

  if (lock.isLoading || !lock.isLocked) return null

  const handleVerify = () => {
    toast(t('withdraw_lock.not_available'), { duration: 4000 })
  }

  const containerClass = `p-4 rounded-lg border ${
    isDark ? 'bg-yellow-500/10 border-yellow-500/30' : 'bg-yellow-50 border-yellow-200'
  }`
  const headingClass = `text-sm font-semibold mb-2 uppercase tracking-wide ${
    isDark ? 'text-white/40' : 'text-gray-400'
  }`
  const iconClass = `w-5 h-5 ${isDark ? 'text-yellow-400' : 'text-yellow-600'}`
  const titleClass = `font-medium mb-1 ${isDark ? 'text-yellow-300' : 'text-yellow-800'}`
  const bodyClass = `text-sm ${isDark ? 'text-yellow-300/70' : 'text-yellow-700'}`

  if (lock.kind === 'time_lock' && lock.unlockAtSec) {
    const days = daysUntil(lock.unlockAtSec)
    const unlockDate = formatUnlockDate(lock.unlockAtSec)
    return (
      <section className="mb-8">
        <h2 className={headingClass}>{t('withdraw_lock.title')}</h2>
        <div className={containerClass}>
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0 mt-0.5">
              <HiClock className={iconClass} />
            </div>
            <div className="flex-1 min-w-0">
              <p className={titleClass}>
                {t('withdraw_lock.time_locked.title')}
              </p>
              <p className={`${bodyClass} mb-1`}>
                {t('withdraw_lock.time_locked.body_date', { date: unlockDate })}
              </p>
              <p className={`${bodyClass} text-xs opacity-80`}>
                {t('withdraw_lock.time_locked.body_days', { days: String(days) })}
              </p>
            </div>
          </div>
        </div>
      </section>
    )
  }

  // KYC path (level >= 2)
  return (
    <section className="mb-8">
      <h2 className={headingClass}>{t('withdraw_lock.title')}</h2>
      <div className={containerClass}>
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 mt-0.5">
            <HiLockClosed className={iconClass} />
          </div>
          <div className="flex-1 min-w-0">
            <p className={titleClass}>{t('withdraw_lock.title')}</p>
            <p className={`${bodyClass} mb-3`}>{t('withdraw_lock.body')}</p>
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
