/**
 * ConfirmStep.tsx
 *
 * Final step of /onboarding: shows the confirmed tx hash and provides
 * a "Continue to feed" button that navigates to /.
 *
 * This step is reached only after bootstrapNewUser() has returned a txHash,
 * so the tx is already in the mempool (or confirmed, depending on whether
 * the sponsor waits for a receipt). We display it as informational
 * without blocking navigation on confirmation — the user can continue
 * while the tx finalizes.
 */

import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { useNavigate } from '~/utils/localizedRouter'

export interface ConfirmStepProps {
  username: string
  txHash: string
}

function shortHash(hash: string): string {
  if (hash.length < 12) return hash
  return `${hash.slice(0, 8)}…${hash.slice(-6)}`
}

export default function ConfirmStep({ username, txHash }: ConfirmStepProps) {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const strongClass = isDark ? 'text-white' : 'text-gray-900'

  return (
    <div className="space-y-6 text-center">
      {/* Success icon */}
      <div className="flex justify-center">
        <div className={`w-20 h-20 rounded-full flex items-center justify-center ${isDark ? 'bg-green-500/20' : 'bg-green-100'}`}>
          <svg className="w-10 h-10 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
      </div>

      <div>
        <h2 className={`text-2xl font-bold mb-2 ${strongClass}`}>
          {t('onboarding.confirm.title')}
        </h2>
        <p className={`text-sm ${mutedClass}`}>
          {t('onboarding.confirm.subtitle', { username })}
        </p>
      </div>

      {/* Tx hash */}
      <div className={`rounded-xl p-4 text-left space-y-2 ${isDark ? 'bg-white/5' : 'bg-gray-50'}`}>
        <p className={`text-xs font-medium ${mutedClass}`}>
          {t('onboarding.confirm.tx_label')}
        </p>
        <p className={`text-sm font-mono break-all ${strongClass}`} title={txHash}>
          {shortHash(txHash)}
        </p>
        <p className={`text-xs ${mutedClass}`}>
          {t('onboarding.confirm.tx_note')}
        </p>
      </div>

      <button
        onClick={() => navigate('/')}
        className="w-full py-3 rounded-full font-semibold text-sm bg-yellow-500 text-black hover:bg-yellow-400 transition-colors cursor-pointer"
      >
        {t('onboarding.confirm.cta')}
      </button>
    </div>
  )
}
