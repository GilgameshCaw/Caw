import React from 'react'
import { useT } from '~/i18n/I18nProvider'

interface QuickSignHowItWorksProps {
  isDark?: boolean
}

/**
 * Shared "How it works" content for Quick Sign — used in Settings and onboarding.
 */
const QuickSignHowItWorks: React.FC<QuickSignHowItWorksProps> = ({ isDark = true }) => {
  const t = useT()
  return (
    <div className={`rounded-lg p-4 text-sm border ${
      isDark ? 'bg-yellow-900/20 border-yellow-700/50' : 'bg-yellow-50/80 border-yellow-200 shadow-xl'
    }`}>
      <p className={`font-medium ${isDark ? 'text-yellow-400' : 'text-gray-900'}`}>{t('quick_sign.how.title')}</p>
      <p className={`mt-2 ${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
        {t('quick_sign.how.intro')}
      </p>
      <p className={`${isDark ? 'text-gray-300' : 'text-gray-600'}`} style={{ marginBottom: 10 }}>
        {t('quick_sign.how.limits_prefix')}{' '}
        <strong>{t('quick_sign.how.limits_strong')}</strong>
        {t('quick_sign.how.limits_suffix')}
      </p>
      <ul className={`space-y-1 list-disc list-outside pl-5 ${isDark ? 'text-gray-300' : 'text-gray-600'}`}>
        <li>{t('quick_sign.how.bullet.extensions')}</li>
        <li>{t('quick_sign.how.bullet.transfer_invalidates')}</li>
        <li>{t('quick_sign.how.bullet.auto_expire')}</li>
        <li>{t('quick_sign.how.bullet.revoke')}</li>
      </ul>
    </div>
  )
}

export default QuickSignHowItWorks
