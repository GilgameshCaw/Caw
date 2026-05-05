import { Toaster } from "react-hot-toast";
import { Modals } from "~/components/modals/Modals";
import Sidebar from "~/components/Sidebar";
import Trending from "~/components/Trending";
import SearchBar from "~/components/SearchBar";
import BugReportModal from "~/components/modals/BugReportModal";
import BugIcon from "~/components/icons/BugIcon";
import { useTheme } from "~/hooks/useTheme";
import Tooltip from "~/components/Tooltip";
import { useT } from "~/i18n/I18nProvider";
import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { HiOutlineMenu, HiOutlineX, HiOutlinePencilAlt, HiOutlineHome, HiOutlineSearch, HiOutlineColorSwatch, HiOutlineBell, HiOutlineUser, HiOutlineChat } from "react-icons/hi";
import { Link, useLocation } from "react-router-dom";
import { useModalStore } from "~/store";
import { useDmUnreadStore } from "~/store/dmUnreadStore";
import { useNotificationUnreadStore } from "~/store/notificationUnreadStore";
import { useOffersUnreadStore } from "~/store/offersUnreadStore";
import { useComposeDraftStore } from "~/store/composeDraftStore";
import { useActiveToken } from "~/store/tokenDataStore";
import { useLayoutStore } from "~/store/layoutStore";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import cawLogo from '~/assets/images/caw-logo.png';
import { themeLayoutShell } from '~/utils/theme'

const BoidsBg = lazy(() => import('~/components/BoidsBg'))

interface MainLayoutProps {
  children: React.ReactNode;
  hideSidebars?: boolean;
}

const MainLayout = ({ children, hideSidebars: hideSidebarsProp }: MainLayoutProps) => {
  const t = useT()
  const { isDark } = useTheme()
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false)
  const [showBugReport, setShowBugReport] = useState(false)
  const location = useLocation()
  const activeToken = useActiveToken()
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const openModal = useModalStore(s => s.openModal)
  const dmUnreadCount = useDmUnreadStore(s => s.totalUnread)
  const notifUnreadCount = useNotificationUnreadStore(s => s.unreadCount)
  const offersUnreadCount = useOffersUnreadStore(s => s.unreadCount)
  const hasInlineDraft = useComposeDraftStore(s => s.hasInlineDraft)

  // Bottom-nav transparency while scrolling: solid when idle, translucent
  // while the user actively scrolls so feed content can peek through.
  const [isScrolling, setIsScrolling] = useState(false)
  const scrollIdleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const onScroll = () => {
      setIsScrolling(true)
      if (scrollIdleTimer.current) clearTimeout(scrollIdleTimer.current)
      scrollIdleTimer.current = setTimeout(() => setIsScrolling(false), 180)
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      if (scrollIdleTimer.current) clearTimeout(scrollIdleTimer.current)
    }
  }, [])

  // Captive mode: no username and on a public page like /help/*
  const isCaptive = !activeToken?.username
  // hideSidebars resolution order (any one truthy wins):
  //   1. Imperative override via useLayoutStore — used for transient
  //      states inside a layout-wrapped route (e.g. /usernames/new
  //      mid-mint shows a fullscreen takeover).
  //   2. The legacy prop (kept for back-compat with any straggling page
  //      that wraps with <MainLayout hideSidebars> — none today, but it
  //      costs nothing to keep working).
  //   3. Captive + public-page heuristic (unauthenticated user on /help,
  //      /usernames, or /faucet — show captive banner instead).
  // useMatches() / route handles aren't used here: <BrowserRouter> isn't
  // a data router, so useMatches throws. The override store covers the
  // one dynamic case we actually have.
  const hideChromeOverride = useLayoutStore(s => s.hideChromeOverride)
  const hideSidebars = hideChromeOverride || hideSidebarsProp || (isCaptive && (location.pathname.startsWith('/help') || location.pathname.startsWith('/usernames') || location.pathname.startsWith('/faucet')))

  return (
    <>
    {/* Fixed backdrop so scrolling doesn't reveal the root gradient */}
    {!isDark && !hideSidebars && (
      <div className="fixed inset-0 z-0 flex justify-center pointer-events-none">
        <div className={`w-full max-w-[1050px] ${themeLayoutShell(isDark)}`} />
      </div>
    )}
    <div className={`min-h-screen w-full flex [--app-mobile-header-h:4rem] transition-colors duration-300 relative z-[1] ${
      hideSidebars
        ? (isDark ? 'bg-black' : 'bg-gray-100')
        : `max-w-[1050px] m-auto ${themeLayoutShell(isDark)}`
    }`}>
      {/* Mobile Header */}
      {!hideSidebars && (
        <div className={`md:hidden fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center p-4 border-b w-screen overflow-hidden transition-all duration-300 ${
          isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
        }`}>
          <button
            onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
            className={`absolute left-4 p-2 rounded-lg transition-colors duration-200 ${
              isDark ? 'text-white hover:bg-white/10' : 'text-black hover:bg-gray-100'
            }`}
          >
            {isMobileMenuOpen ? <HiOutlineX className="w-6 h-6" /> : <HiOutlineMenu className="w-6 h-6" />}
          </button>

          <Link
            to="/messages"
            aria-label="Messages"
            className={`absolute right-4 translate-y-[2px] p-2 rounded-lg transition-colors duration-200 ${
              isDark ? 'text-white hover:bg-white/10' : 'text-black hover:bg-gray-100'
            }`}
          >
            <span className="relative inline-flex">
              <HiOutlineChat className="w-8 h-8" />
              {dmUnreadCount > 0 && (
                <span className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {dmUnreadCount > 99 ? '99+' : dmUnreadCount}
                </span>
              )}
            </span>
          </Link>

          <Link to="/home" className="caw-logo-lockup flex items-center justify-center w-full">
            <img
              src={cawLogo}
              alt={t('main_layout.caw_logo_alt')}
              width={40}
              height={40}
              decoding="sync"
              loading="eager"
              fetchPriority="high"
              className="caw-logo-mark w-10 h-10 object-contain"
            />
          </Link>
        </div>
      )}

      {/* Mobile Sidebar Overlay */}
      {!hideSidebars && (
        <div
          className={`md:hidden fixed inset-0 z-[70] transition-all duration-300 ${
            isMobileMenuOpen ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
          }`}
          onClick={() => setIsMobileMenuOpen(false)}
        >
          <div
            className={`fixed left-0 top-0 h-full w-80 max-w-[90vw] transform transition-transform duration-300 ease-in-out ${
              isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
            } ${
              isDark ? 'bg-black border-r border-white/20' : 'bg-white border-r border-gray-300'
            }`}
            onClick={(e) => e.stopPropagation()}
          >
            <Sidebar onNavigate={() => setIsMobileMenuOpen(false)} />
          </div>
        </div>
      )}

      {/* Desktop Sidebar */}
      {!hideSidebars && (
        <div className="hidden md:block w-[200px]">
          <div className={`fixed border-r h-full w-[200px] z-30 transition-colors duration-300 ${
            isDark ? 'border-white/20' : 'border-gray-300'
          }`}>
            <Sidebar />
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className={`flex-1 min-w-0 transition-colors duration-300 flex flex-col ${
        hideSidebars
          ? `pt-0 relative overflow-hidden ${isDark ? 'text-white' : 'text-black'}`
          : `${isDark ? 'bg-black text-white' : 'bg-white text-black'} ${isMobileMenuOpen ? 'md:pt-0 pt-16' : 'pt-16 md:pt-0'}`
      }`}>
        {hideSidebars && (
          <Suspense fallback={null}>
            <BoidsBg isDark={isDark} />
          </Suspense>
        )}
        <div className={`flex-1 min-h-0 ${hideSidebars ? 'pb-24 relative z-10' : ''}`}>
          {children}
        </div>
      </main>
      <Toaster
        position="top-center"
        reverseOrder
        containerStyle={{ marginTop: "40px" }}
        toastOptions={{ removeDelay: 0 }}
      />
      {!hideSidebars && (
        <div className="hidden lg:block w-[280px]">
          <div className={`fixed border-l h-full w-[280px] z-30 transition-colors duration-300 ${
            isDark ? 'border-white/20' : 'border-gray-300'
          }`}>
            <div className="p-2">
              <SearchBar />
            </div>
            <div className="mt-4">
              <Trending/>
            </div>
          </div>
        </div>
      )}
      <Modals />

      {/* Captive banner — fixed bottom bar for unauthenticated users on public pages */}
      {hideSidebars && isCaptive && (
        <div className={`fixed bottom-0 left-0 right-0 z-50 border-t backdrop-blur-[2px] ${
          isDark ? 'bg-black/10 border-white/10' : 'bg-white/10 border-gray-200'
        }`}>
          <div className="max-w-3xl mx-auto flex items-center justify-between px-5 py-3">
            <Link to="/welcome" className="caw-logo-lockup flex items-center gap-2.5">
              <img src={cawLogo} alt="CAW" width={48} height={48} decoding="sync" loading="eager" fetchPriority="high" className="caw-logo-mark w-12 h-12 object-contain" />
              <span
                className="text-4xl"
                style={{
                  fontFamily: 'Inter, sans-serif',
                  fontWeight: 800,
                  color: '#ebc046',
                  letterSpacing: '3px',
                  textShadow: '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)',
                }}
              >
                CAW
              </span>
            </Link>
            {location.pathname.startsWith('/usernames') ? (
              <Link
                to="/help/faq"
                className={`px-6 py-2.5 font-semibold text-base rounded-full border transition-all ${
                  isDark
                    ? 'border-white/20 text-white/80 hover:bg-white/10'
                    : 'border-gray-300 text-gray-700 hover:bg-gray-100'
                }`}
              >
                {t('main_layout.learn_more')}
              </Link>
            ) : !isConnected ? (
              <button
                onClick={openConnectModal}
                className="px-6 py-2.5 bg-yellow-500 text-black font-bold text-base rounded-full hover:bg-yellow-400 transition-all shadow-lg cursor-pointer"
              >
                {t('common.sign_in')}
              </button>
            ) : (
              <Link
                to="/usernames/new"
                className="px-6 py-2.5 bg-yellow-500 text-black font-bold text-base rounded-full hover:bg-yellow-400 transition-all shadow-lg"
              >
                {t('main_layout.create_profile')}
              </Link>
            )}
          </div>
        </div>
      )}

      {/* Mobile bottom nav */}
      {!hideSidebars && !isCaptive && (
        <nav className={`md:hidden fixed bottom-0 left-0 right-0 z-[55] flex items-center justify-around h-14 pb-[env(safe-area-inset-bottom)] [height:calc(theme(height.14)+env(safe-area-inset-bottom))] border-t transition-all duration-200 ${
          hasInlineDraft ? 'opacity-0 translate-y-full pointer-events-none' : isScrolling ? 'opacity-30' : 'opacity-100'
        } ${
          isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
        }`}>
          {[
            { to: '/home', icon: HiOutlineHome, match: '/home', badge: 0 },
            { to: '/explore', icon: HiOutlineSearch, match: '/explore', badge: 0 },
            { to: '/usernames', icon: HiOutlineColorSwatch, match: '/usernames', badge: offersUnreadCount },
            { to: '/notifications', icon: HiOutlineBell, match: '/notifications', badge: notifUnreadCount },
            { to: activeToken?.username ? `/users/${activeToken.username}` : '/welcome', icon: HiOutlineUser, match: activeToken?.username ? `/users/${activeToken.username}` : '/welcome', badge: 0 },
          ].map(({ to, icon: Icon, match, badge }) => {
            const active = location.pathname === match || location.pathname.startsWith(match + '/')
            return (
              <Link
                key={to}
                to={to}
                className={`flex-1 h-full flex items-center justify-center transition-colors ${
                  active
                    ? (isDark ? 'text-yellow-500' : 'text-yellow-600')
                    : (isDark ? 'text-white/70 hover:text-white' : 'text-gray-600 hover:text-black')
                }`}
              >
                <span className="relative inline-flex">
                  <Icon className="w-7 h-7" />
                  {badge > 0 && (
                    <span className={`absolute -top-1 -right-1 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                      {badge > 99 ? '99+' : badge}
                    </span>
                  )}
                </span>
              </Link>
            )
          })}
        </nav>
      )}

      {/* Mobile compose FAB */}
      {!hideSidebars && !isCaptive && !(
        location.pathname.startsWith('/messages') ||
        location.pathname.startsWith('/usernames') ||
        location.pathname.startsWith('/staking') ||
        location.pathname.startsWith('/settings')
      ) && (
        <button
          onClick={() => openModal('post')}
          aria-label={t('main_layout.post_aria')}
          className={`md:hidden fixed right-6 bottom-20 z-[60] w-14 h-14 rounded-full bg-yellow-500 hover:bg-yellow-400 active:bg-yellow-600 text-black flex items-center justify-center shadow-lg shadow-black/30 transition-all duration-200 cursor-pointer ${
            hasInlineDraft ? 'opacity-0 translate-y-24 pointer-events-none' : isScrolling ? 'opacity-30' : 'opacity-100'
          }`}
        >
          <HiOutlinePencilAlt className="w-8 h-8" />
        </button>
      )}

      {/* Floating feedback button */}
      <div className={`fixed z-[51] left-[5px] bottom-[5px]`}>
      <Tooltip text={t('bug_report.title')} position="top">
        <button
          onClick={() => setShowBugReport(true)}
          className={`w-9 h-9 rounded-full flex items-center justify-center shadow-lg transition-all cursor-pointer opacity-60 hover:opacity-100 ${
            isDark
              ? 'bg-zinc-800 hover:bg-zinc-700 text-white/70'
              : 'bg-gray-200 hover:bg-gray-300 text-gray-500'
          }`}
        >
        <BugIcon />
        </button>
      </Tooltip>
      </div>
      <BugReportModal isOpen={showBugReport} onClose={() => setShowBugReport(false)} />
    </div>
    </>
  );
};

export default MainLayout;
