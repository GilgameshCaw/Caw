/**
 * Invite.tsx — dedicated page for sponsored invite codes.
 *
 * Hosts the buy-a-code form + "My invite codes" list (SponsorInviteSection).
 * Lives at /invite, linked from the Settings menu. Deliberately NOT under
 * /wallet (that page is passkey-only and redirects Pop-A/C away) — invites are
 * for every wallet type, so they get their own top-level, shareable home.
 *
 * Previously embedded in /settings/account; moved out so it has room to breathe
 * and a stable shareable URL.
 */

import { useNavigate } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import { themeText, themeSecondaryButton } from '~/utils/theme'
import { HiArrowLeft } from 'react-icons/hi'
import { useActiveToken } from '~/store/tokenDataStore'
import SponsorInviteSection from '~/components/sponsor/SponsorInviteSection'

export default function InvitePage() {
  const { isDark } = useTheme()
  const t = useT()
  const navigate = useNavigate()
  const activeToken = useActiveToken()
  const activeTokenId = activeToken?.tokenId

  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'

  return (
    <div className="max-w-2xl mx-auto px-6 py-4">
      <div className="flex items-center gap-3 mb-6">
        <button
          onClick={() => navigate('/settings')}
          className={`p-2 rounded-full ${themeSecondaryButton(isDark)}`}
          aria-label={t('common.back')}
        >
          <HiArrowLeft className="w-5 h-5" />
        </button>
        <h1 className={`text-xl font-bold ${themeText(isDark)}`}>Invite friends</h1>
      </div>

      {activeTokenId ? (
        <SponsorInviteSection />
      ) : (
        <p className={`text-sm ${mutedClass}`}>Sign in with a profile to sponsor invite codes.</p>
      )}
    </div>
  )
}
