import { useState } from 'react'
import { HiMenu, HiX } from 'react-icons/hi'
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
// Below `md` the clusters would collide on a phone-width viewport, so the
// resource links + language picker + avatar collapse behind a burger button
// that slides in a right-side drawer.
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

  const [menuOpen, setMenuOpen] = useState(false)
  const closeMenu = () => setMenuOpen(false)

  return (
    <>
      {/* Top-right cluster. Desktop: language picker + avatar. Mobile:
          a burger that opens the drawer below. */}
      <div className={`${pos} top-5 right-6 sm:right-10 lg:right-16 z-20 flex items-center gap-2`}>
        <div className="hidden md:flex items-center gap-2">
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
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="Open menu"
          className={`md:hidden w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
            isDark
              ? 'bg-white/10 text-white border-transparent hover:border-white/40'
              : 'bg-black/5 text-black border-transparent hover:border-black/30'
          }`}
        >
          <HiMenu className="w-5 h-5" />
        </button>
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
        {/* Resource links — desktop only; on mobile they live in the drawer. */}
        <nav className="hidden md:flex items-center gap-x-4 ml-8 text-sm">
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

      {/* Mobile drawer — resource links, with the language picker + avatar
          pinned to the bottom. Always mounted so it can slide; pointer
          events are off while closed. md+ never opens it (no burger). */}
      <div className={`fixed inset-0 z-40 md:hidden ${menuOpen ? '' : 'pointer-events-none'}`}>
        <div
          onClick={closeMenu}
          className={`absolute inset-0 bg-black/60 transition-opacity duration-200 ${
            menuOpen ? 'opacity-100' : 'opacity-0'
          }`}
        />
        <div
          className={`absolute top-0 right-0 h-full w-72 max-w-[80vw] flex flex-col transition-transform duration-200 ${
            menuOpen ? 'translate-x-0' : 'translate-x-full'
          } ${isDark ? 'bg-black border-l border-white/10' : 'bg-white border-l border-gray-200'}`}
        >
          <div className="flex justify-end p-4">
            <button
              type="button"
              onClick={closeMenu}
              aria-label="Close menu"
              className={`w-9 h-9 rounded-lg flex items-center justify-center border transition-colors ${
                isDark
                  ? 'bg-white/10 text-white border-transparent hover:border-white/40'
                  : 'bg-black/5 text-black border-transparent hover:border-black/30'
              }`}
            >
              <HiX className="w-5 h-5" />
            </button>
          </div>

          <nav className="flex flex-col px-3 gap-1 overflow-y-auto">
            {RESOURCE_LINKS.map(l => (
              <Link
                key={l.to}
                to={l.to}
                onClick={closeMenu}
                className={`px-3 py-2.5 rounded-lg text-sm transition-colors ${
                  isDark ? 'text-white/70 hover:bg-white/10' : 'text-gray-700 hover:bg-black/5'
                }`}
              >
                {l.tKey ? t(l.tKey) : l.label}
              </Link>
            ))}
          </nav>

          {/* Language picker — a control, so it sits with the nav links
              just under Faucet. Kept OUT of the overflow-y-auto <nav> so
              its absolute dropdown panel isn't clipped. Scaled down. */}
          <div className="px-6 pt-2 origin-left scale-90">
            <LanguageSwitcher placement="right" />
          </div>

          {/* Bottom: active-user avatar, pinned to the foot of the drawer. */}
          {activeToken?.username && activeAvatarSrc && (
            <div
              className={`mt-auto border-t p-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}
            >
              <Link
                to={`/users/${activeToken.username}`}
                onClick={closeMenu}
                aria-label={activeToken.username}
                title={activeToken.username}
                className="flex items-center gap-2 min-w-0"
              >
                <span className="w-9 h-9 rounded-full overflow-hidden block border border-white/20">
                  <Avatar src={activeAvatarSrc} size="small" className="w-full h-full object-cover" />
                </span>
                <span className={`text-sm truncate ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                  {activeToken.username}
                </span>
              </Link>
            </div>
          )}
        </div>
      </div>
    </>
  )
}
