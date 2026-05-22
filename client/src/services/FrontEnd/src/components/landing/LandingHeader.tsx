import { Link } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'
import LanguageSwitcher from '~/components/LanguageSwitcher'
import Avatar from '~/components/Avatar'
import { getUserAvatar } from '~/utils/defaultAvatar'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import cawLogo from '~/assets/images/caw-logo.png'

// Resource links — single source of truth for the pre-auth landing pages
// (CaptiveSplash + ManifestoPage). Rendered in the top-left header cluster
// and re-exported so the CaptiveSplash footer renders the same list. Keeping
// one list avoids the copies drifting apart when a link is added/removed.
// Each entry carries either a `tKey` (i18n) or a plain `label`.
export const RESOURCE_LINKS: { to: string; tKey?: string; label?: string }[] = [
  { to: '/help/faq',        tKey: 'captive_splash.footer.faq' },
  { to: '/manifesto',       tKey: 'captive_splash.footer.manifesto' },
  { to: '/help/history',    tKey: 'captive_splash.footer.history' },
  { to: '/help/howto',      tKey: 'captive_splash.footer.how_it_works' },
  { to: '/help/developers', tKey: 'captive_splash.footer.developers' },
  { to: '/help/resources',  tKey: 'captive_splash.footer.resources' },
  { to: '/help/whitepaper', label: 'Whitepaper' },
  { to: '/faucet',          tKey: 'captive_splash.footer.faucet' },
]

// Shared landing-page header — two positioned clusters (no bar, no border):
// CAW logo lockup + resource links top-left, LanguageSwitcher + active-user
// avatar top-right.
//
// `fixed=false` (default): clusters are `absolute` — they scroll away with
//   the page. The host must be `position: relative`. Used by ManifestoPage
//   (natural document scroll) and WhitepaperPage (root doesn't scroll).
// `fixed=true`: clusters are `fixed` — they stay pinned while the page
//   scrolls. Used by CaptiveSplash, whose root is itself the scroll area.
export default function LandingHeader({ fixed = false }: { fixed?: boolean }) {
  const { isDark } = useTheme()
  const pos = fixed ? 'fixed' : 'absolute'
  const t = useT()
  const activeToken = useActiveToken()
  const avatarsByTokenId = useTokenDataStore(s => s.avatarsByTokenId)
  const activeAvatarSrc = activeToken?.tokenId
    ? (avatarsByTokenId[activeToken.tokenId] || getUserAvatar({ tokenId: activeToken.tokenId }))
    : null

  return (
    <>
      {/* Top-right: language picker + active-user avatar. */}
      <div className={`${pos} top-5 right-6 sm:right-10 lg:right-16 z-20 flex items-center gap-2`}>
        <LanguageSwitcher />
        {activeToken?.username && activeAvatarSrc && (
          <Link
            to={`/users/${activeToken.username}`}
            aria-label={activeToken.username}
            title={activeToken.username}
            className="w-9 h-9 rounded-full overflow-hidden block border border-white/20 hover:border-white/50 transition-colors"
          >
            <Avatar src={activeAvatarSrc} size="small" className="w-full h-full object-cover" />
          </Link>
        )}
      </div>

      {/* Top-left: CAW logo lockup + resource links. */}
      <div className={`${pos} top-5 left-6 sm:left-10 lg:left-16 z-20 flex items-center gap-2`}>
        <Link to="/welcome" className="caw-logo-lockup flex items-center" aria-label="CAW">
          <img
            src={cawLogo}
            alt="CAW Logo"
            width={32}
            height={32}
            decoding="sync"
            loading="eager"
            fetchPriority="high"
            className={`caw-logo-mark w-8 h-8 object-contain ${isDark ? '' : 'drop-shadow-[1px_1px_1px_rgba(0,0,0,0.8)]'}`}
          />
          <span
            className="text-[1.75rem]"
            style={{
              fontFamily: 'Inter, sans-serif',
              fontWeight: 800,
              color: '#ebc046',
              letterSpacing: '3px',
              marginLeft: '8px',
              textShadow: isDark
                ? '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)'
                : 'rgba(0,0,0,1) 0.5px 0.5px 1px, rgba(0,0,0,0.3) 1.5px 1.5px 1px, rgba(240,177,0,1) 0px 0px 3px',
            }}
          >
            CAW
          </span>
        </Link>
        {/* Hidden below md — the left and right clusters would collide on a
            phone-width viewport. CaptiveSplash keeps them reachable in its
            footer on mobile. */}
        <nav className="hidden md:flex items-center gap-x-4 ml-2 text-sm">
          {RESOURCE_LINKS.map(l => (
            <Link
              key={l.to}
              to={l.to}
              className={`transition-colors ${isDark ? 'text-white/50 hover:text-white' : 'text-gray-500 hover:text-gray-800'}`}
            >
              {l.tKey ? t(l.tKey) : l.label}
            </Link>
          ))}
        </nav>
      </div>
    </>
  )
}
