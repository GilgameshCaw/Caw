/**
 * RecoveryBanner.tsx
 *
 * A small informational banner shown when the user is signed in via their
 * backup file (recovery mode). Nudges them to re-enroll a passkey under
 * Identity settings before their session ends.
 *
 * Rendered in MainLayout just below the top nav bar so it's always visible
 * across all pages while the recovered key is in memory.
 */

import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { Link } from '~/utils/localizedRouter'
import { useRecoveryContext } from '~/components/identity/RecoveryProvider'

export default function RecoveryBanner() {
  const { isInRecoveryMode } = useRecoveryContext()
  const { isDark } = useTheme()
  const t = useT()

  if (!isInRecoveryMode) return null

  return (
    <div
      className={`w-full px-4 py-2 flex items-center justify-center gap-2 text-sm ${
        isDark
          ? 'bg-yellow-500/15 border-b border-yellow-500/30 text-yellow-300'
          : 'bg-yellow-50 border-b border-yellow-200 text-yellow-800'
      }`}
    >
      <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
      </svg>
      <span>
        {t('recovery.banner.message')}{' '}
        <Link
          to="/settings/account"
          className={`underline font-medium ${
            isDark ? 'text-yellow-300 hover:text-yellow-200' : 'text-yellow-800 hover:text-yellow-900'
          }`}
        >
          {t('recovery.banner.link_label')}
        </Link>
      </span>
    </div>
  )
}
