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
import { acquireScrollLock, releaseScrollLock } from "~/utils/scrollLock";
import { useState, useEffect, useRef, lazy, Suspense } from "react";
import { HiOutlineMenu, HiOutlineX, HiOutlinePencilAlt, HiOutlineHome, HiOutlineSearch, HiOutlineColorSwatch, HiOutlineBell, HiOutlineUser, HiOutlineChat } from "react-icons/hi";
import { useLocation } from "react-router-dom";
import { Link } from "~/utils/localizedRouter";
import { useModalStore } from "~/store";
import { useDmUnreadStore } from "~/store/dmUnreadStore";
import { useNotificationUnreadStore } from "~/store/notificationUnreadStore";
import { useOffersUnreadStore } from "~/store/offersUnreadStore";
import { useComposeDraftStore } from "~/store/composeDraftStore";
import { useActiveToken } from "~/store/tokenDataStore";
import { useLayoutStore } from "~/store/layoutStore";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useAccount } from "wagmi";
import WalletAccountButton from "~/components/buttons/WalletAccountButton";
import cawLogo from '~/assets/images/caw-logo.png';
import { themeLayoutShell } from '~/utils/theme'
import Avatar from '~/components/Avatar';
import { getUserAvatar } from '~/utils/defaultAvatar';
import { useTokenDataStore } from '~/store/tokenDataStore';

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
  const avatarsByTokenId = useTokenDataStore(s => s.avatarsByTokenId)
  const activeAvatarSrc = activeToken?.tokenId
    ? (avatarsByTokenId[activeToken.tokenId] || getUserAvatar({ tokenId: activeToken.tokenId }))
    : null

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

  // Ref for the bottom-nav-height CSS variable plumbing below. Effect
  // lives further down (after hideSidebars/isCaptive are computed).
  const bottomNavRef = useRef<HTMLElement | null>(null)

  // Swipe-to-open/close for the mobile drawer. Open zone is the left 25%
  // of the viewport; close zone is anywhere on the drawer itself. While
  // dragging we set an inline transform on the panel and an opacity on the
  // backdrop so the gesture tracks the finger; on release we snap based on
  // distance + velocity. The CSS class-driven transition is disabled
  // during drag (transition-none) and re-enabled on release.
  const drawerPanelRef = useRef<HTMLDivElement | null>(null)
  const drawerBackdropRef = useRef<HTMLDivElement | null>(null)
  const dragState = useRef<{
    startX: number
    startY: number
    lastX: number
    lastT: number
    velocity: number
    width: number
    dragging: boolean
    fromOpen: boolean
  } | null>(null)
  const [isDragging, setIsDragging] = useState(false)

  const applyDrawerTransform = (translateXPx: number, width: number) => {
    const panel = drawerPanelRef.current
    const backdrop = drawerBackdropRef.current
    if (panel) panel.style.transform = `translateX(${translateXPx}px)`
    if (backdrop) {
      // Backdrop opacity goes from 0 (fully closed: translateX = -width)
      // to 1 (fully open: translateX = 0).
      const progress = 1 + translateXPx / width // -width -> 0, 0 -> 1
      backdrop.style.opacity = String(Math.max(0, Math.min(1, progress)))
    }
  }

  const clearInlineDrawerStyles = () => {
    const panel = drawerPanelRef.current
    const backdrop = drawerBackdropRef.current
    if (panel) panel.style.transform = ''
    if (backdrop) backdrop.style.opacity = ''
  }

  const onDrawerTouchStart = (e: React.TouchEvent, fromOpen: boolean) => {
    if (e.touches.length !== 1) return
    const t = e.touches[0]
    // When closed, only react if the touch starts in the left 25% of the viewport.
    if (!fromOpen) {
      if (t.clientX > window.innerWidth * 0.25) return
    }
    const panel = drawerPanelRef.current
    const width = panel?.offsetWidth || Math.min(320, window.innerWidth * 0.9)
    dragState.current = {
      startX: t.clientX,
      startY: t.clientY,
      lastX: t.clientX,
      lastT: performance.now(),
      velocity: 0,
      width,
      dragging: false,
      fromOpen,
    }
  }

  const onDrawerTouchMove = (e: React.TouchEvent) => {
    const s = dragState.current
    if (!s) return
    const t = e.touches[0]
    const dx = t.clientX - s.startX
    const dy = t.clientY - s.startY

    if (!s.dragging) {
      // Only commit to a horizontal drag once it clearly beats the vertical
      // motion — otherwise feed-scroll touches starting in the left band
      // would steal Y-scroll. 10px threshold matches typical native drawers.
      if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy)) return
      // Direction must match: opening = swipe right, closing = swipe left.
      if (!s.fromOpen && dx <= 0) {
        dragState.current = null
        return
      }
      if (s.fromOpen && dx >= 0) {
        // Swiping right while open: no-op (don't over-translate past 0).
        return
      }
      s.dragging = true
      setIsDragging(true)
      // Make sure the overlay is hit-testable while we drag open.
      if (!s.fromOpen && !isMobileMenuOpen) setIsMobileMenuOpen(true)
    }

    const now = performance.now()
    const dt = now - s.lastT
    if (dt > 0) s.velocity = (t.clientX - s.lastX) / dt // px/ms
    s.lastX = t.clientX
    s.lastT = now

    // translateX range: -width (closed) → 0 (open).
    const base = s.fromOpen ? 0 : -s.width
    const next = Math.max(-s.width, Math.min(0, base + dx))
    applyDrawerTransform(next, s.width)
  }

  const onDrawerTouchEnd = () => {
    const s = dragState.current
    if (!s) return
    dragState.current = null
    if (!s.dragging) {
      setIsDragging(false)
      return
    }
    // Decide snap: position past midpoint OR sufficient velocity (px/ms).
    const panel = drawerPanelRef.current
    const transform = panel?.style.transform || ''
    const match = transform.match(/translateX\((-?\d+(?:\.\d+)?)px\)/)
    const currentX = match ? parseFloat(match[1]) : (s.fromOpen ? 0 : -s.width)
    const passedMidpoint = currentX > -s.width / 2
    const fastOpen = s.velocity > 0.5
    const fastClose = s.velocity < -0.5
    const shouldOpen = fastOpen || (!fastClose && passedMidpoint)
    setIsMobileMenuOpen(shouldOpen)
    // Clear inline styles so the class-driven transition takes over.
    clearInlineDrawerStyles()
    setIsDragging(false)
  }

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
  const hideMobileNavOverride = useLayoutStore(s => s.hideMobileNavOverride)
  const hideSidebars = hideChromeOverride || hideSidebarsProp || (isCaptive && (location.pathname.startsWith('/help') || location.pathname.startsWith('/usernames') || location.pathname.startsWith('/faucet')))

  // Publish the bottom-nav height as a CSS variable so pages with their own
  // fixed-bottom UI (e.g. DM composer in /messages/<id>) can sit above the
  // nav instead of being covered by it. Resolves to "0px" whenever the nav
  // isn't rendered, is `md:hidden` on desktop, or is translated off-screen
  // by the inline-draft state.
  const showBottomNav = !hideSidebars && !isCaptive && !hideMobileNavOverride
  useEffect(() => {
    const root = document.documentElement
    if (!showBottomNav || hasInlineDraft) {
      root.style.setProperty('--bottom-nav-h', '0px')
      return () => { root.style.removeProperty('--bottom-nav-h') }
    }
    const node = bottomNavRef.current
    if (!node) return
    const sync = () => {
      // offsetHeight is 0 under `md:hidden` on desktop — exactly what
      // consumers want. Includes safe-area-inset-bottom on iOS.
      root.style.setProperty('--bottom-nav-h', `${node.offsetHeight}px`)
    }
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(node)
    // Viewport changes (rotation, devtools resize) flip `md:hidden` without
    // resizing the node itself, so listen for window resizes too.
    window.addEventListener('resize', sync)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', sync)
      root.style.removeProperty('--bottom-nav-h')
    }
  }, [showBottomNav, hasInlineDraft])

  // Lock background scroll while the mobile drawer is open so the feed
  // behind the backdrop doesn't scroll under the finger. Reuses the same
  // refcounted lock as modals — handles iOS Safari (which ignores
  // overflow:hidden) via position:fixed and restores scrollY on close.
  useEffect(() => {
    if (!isMobileMenuOpen) return
    acquireScrollLock()
    return () => releaseScrollLock()
  }, [isMobileMenuOpen])

  return (
    <>
    {/* Fixed backdrop so scrolling doesn't reveal the root gradient */}
    {!isDark && !hideSidebars && (
      <div className="fixed inset-0 z-0 flex justify-center pointer-events-none">
        <div className={`w-full max-w-[1050px] ${themeLayoutShell(isDark)}`} />
      </div>
    )}
    <div className={`min-h-screen w-full flex [--app-mobile-header-h:calc(3rem+max(env(safe-area-inset-top),1rem))] transition-colors duration-300 relative z-[1] ${
      hideSidebars
        ? (isDark ? 'bg-black' : 'bg-gray-100')
        : `max-w-[1050px] m-auto ${themeLayoutShell(isDark)}`
    }`}>
      {/* Mobile Header. pt-top uses max(inset, 1rem) — NOT inset+1rem —
          so on iOS the icon row pads exactly to the safe-area edge (just
          below the translucent URL chrome), while on Android/desktop the
          inset is 0 and the original 1rem padding takes over. Adding
          padding ON TOP of the inset produces a visible black strip
          between the URL bar and the icons. */}
      {!hideSidebars && (
        <div className={`md:hidden fixed top-0 left-0 right-0 z-[9999] flex items-center justify-center px-4 pb-4 pt-[max(env(safe-area-inset-top),1rem)] border-b w-screen overflow-hidden transition-all duration-300 ${
          isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
        }`}>
          <button
            onClick={() => {
              // Belt-and-suspenders: a half-finished swipe-drag can leave an
              // inline `style.transform` on the panel that overrides the
              // class-based `translate-x-0/-translate-x-full` toggle. Clearing
              // here guarantees the class transition takes over on every tap.
              clearInlineDrawerStyles()
              setIsMobileMenuOpen(prev => !prev)
            }}
            className={`absolute left-4 p-2 rounded-lg transition-colors duration-200 ${
              isDark ? 'text-white hover:bg-white/10' : 'text-black hover:bg-gray-100'
            }`}
          >
            {isMobileMenuOpen ? <HiOutlineX className="w-6 h-6" /> : <HiOutlineMenu className="w-6 h-6" />}
          </button>

          <Link
            to="/messages"
            aria-label="Messages"
            onClick={() => { clearInlineDrawerStyles(); setIsMobileMenuOpen(false) }}
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

          <Link
            to="/home"
            onClick={(e) => {
              if (location.pathname === '/home') {
                e.preventDefault()
                window.scrollTo({ top: 0, behavior: 'smooth' })
              }
            }}
            className="caw-logo-lockup flex items-center justify-center w-full"
          >
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
        <>
          {/* Edge-swipe catcher: when the drawer is closed, this invisible
              strip listens for touchstarts in the left 25% of the screen and
              starts the open-drag. It sits below the bottom nav so taps on
              nav buttons aren't intercepted. pointer-events on touch only —
              click is unaffected. */}
          {!isMobileMenuOpen && (
            <div
              className="md:hidden fixed top-0 left-0 bottom-[calc(var(--bottom-nav-h,0px)+50px)] w-2 z-[65]"
              style={{ touchAction: 'pan-y' }}
              onTouchStart={(e) => onDrawerTouchStart(e, false)}
              onTouchMove={onDrawerTouchMove}
              onTouchEnd={onDrawerTouchEnd}
              onTouchCancel={onDrawerTouchEnd}
            />
          )}
          <div
            ref={drawerBackdropRef}
            // z-[90] sits above page-level floating elements like the
            // Profile back button (z-[80]) so they don't bleed through
            // on top of the drawer menu items. Stays below the mobile
            // header (z-[9999]) so the hamburger / close toggle in the
            // header remains tappable to dismiss the drawer.
            className={`md:hidden fixed inset-0 z-[90] ${isDragging ? '' : 'transition-all duration-300'} ${
              isMobileMenuOpen ? 'bg-black/50 opacity-100' : 'bg-black/0 opacity-0 pointer-events-none'
            }`}
            onClick={() => setIsMobileMenuOpen(false)}
          >
            <div
              ref={drawerPanelRef}
              className={`fixed left-0 top-0 h-full w-80 max-w-[90vw] transform ${isDragging ? '' : 'transition-transform duration-300 ease-in-out'} ${
                isMobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
              } ${
                isDark ? 'bg-black border-r border-white/20' : 'bg-white border-r border-gray-300'
              }`}
              style={{ touchAction: 'pan-y' }}
              onClick={(e) => e.stopPropagation()}
              onTouchStart={(e) => onDrawerTouchStart(e, true)}
              onTouchMove={onDrawerTouchMove}
              onTouchEnd={onDrawerTouchEnd}
              onTouchCancel={onDrawerTouchEnd}
            >
              <Sidebar onNavigate={() => setIsMobileMenuOpen(false)} />
            </div>
          </div>
        </>
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
          : `${isDark ? 'bg-black text-white' : 'bg-white text-black'} ${isMobileMenuOpen ? 'md:pt-0 pt-[var(--app-mobile-header-h)]' : 'pt-[var(--app-mobile-header-h)] md:pt-0'}`
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
            // bg pin is intentional in dark mode: without it the right
            // panel inherits the page's black background and reads as
            // floating text, not a panel. Light mode already reads as
            // a separate column via the gray border + page bg contrast.
            isDark ? 'bg-black border-white/20' : 'bg-white border-gray-300'
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
            <div className="flex items-center gap-2">
              {/* Wallet pill — gives connected captive users a path to
                  the account modal (and Disconnect). Hidden when not
                  connected; the primary CTA below leads that case. */}
              <WalletAccountButton />
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
        </div>
      )}

      {/* Mobile bottom nav */}
      {!hideSidebars && !isCaptive && !hideMobileNavOverride && (
        <nav
          ref={bottomNavRef}
          // While the user is scrolling we drop opacity AND pointer-events.
          // Without `pointer-events-none`, the semi-transparent nav still
          // catches taps over the post action row behind it — visible icons
          // suggest the row is interactive but the click lands on the nav
          // (bug #215). The nav reclaims pointer events as soon as scroll
          // settles, so its own buttons remain usable.
          className={`md:hidden fixed bottom-0 left-0 right-0 z-[55] flex items-center justify-around h-14 pb-[env(safe-area-inset-bottom)] [height:calc(theme(height.14)+env(safe-area-inset-bottom))] border-t transition-all duration-200 ${
            hasInlineDraft ? 'opacity-0 translate-y-full pointer-events-none' : isScrolling ? 'opacity-30 pointer-events-none' : 'opacity-100'
          } ${
            isDark ? 'bg-black border-white/10' : 'bg-white border-gray-200'
          }`}
        >
          {[
            { to: '/home', icon: HiOutlineHome, match: '/home', badge: 0, isProfile: false },
            { to: '/explore', icon: HiOutlineSearch, match: '/explore', badge: 0, isProfile: false },
            { to: '/usernames', icon: HiOutlineColorSwatch, match: '/usernames', badge: offersUnreadCount, isProfile: false },
            { to: '/notifications', icon: HiOutlineBell, match: '/notifications', badge: notifUnreadCount, isProfile: false },
            { to: activeToken?.username ? `/users/${activeToken.username}` : '/welcome', icon: HiOutlineUser, match: activeToken?.username ? `/users/${activeToken.username}` : '/welcome', badge: 0, isProfile: true },
          ].map(({ to, icon: Icon, match, badge, isProfile }) => {
            const active = location.pathname === match || location.pathname.startsWith(match + '/')
            const showAvatar = isProfile && !!activeAvatarSrc
            return (
              <Link
                key={to}
                to={to}
                onClick={(e) => {
                  // Tapping a tab while already on it scrolls the page
                  // back to top (Twitter/X behavior). Without this,
                  // React Router treats the click as a no-op and
                  // leaves the user wherever they were scrolled.
                  if (active) {
                    e.preventDefault()
                    window.scrollTo({ top: 0, behavior: 'smooth' })
                  }
                }}
                className={`flex-1 h-full flex items-center justify-center transition-colors ${
                  active
                    ? (isDark ? 'text-yellow-500' : 'text-yellow-600')
                    : (isDark ? 'text-white/70 hover:text-white' : 'text-gray-600 hover:text-black')
                }`}
              >
                <span className="relative inline-flex">
                  {showAvatar ? (
                    <span className={`w-7 h-7 rounded-full overflow-hidden block ${
                      active ? (isDark ? 'ring-2 ring-yellow-500' : 'ring-2 ring-yellow-600') : ''
                    }`}>
                      <Avatar src={activeAvatarSrc!} size="small" className="w-full h-full object-cover" />
                    </span>
                  ) : (
                    <Icon className="w-7 h-7" />
                  )}
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
      {!hideSidebars && !isCaptive && !hideMobileNavOverride && !(
        location.pathname.startsWith('/messages') ||
        location.pathname.startsWith('/usernames') ||
        location.pathname.startsWith('/staking') ||
        location.pathname.startsWith('/settings')
      ) && (
        <button
          onClick={() => openModal('post')}
          aria-label={t('main_layout.post_aria')}
          // Mirrors the bottom-nav rule: pointer-events-none while
          // scrolling so the semi-transparent FAB doesn't intercept
          // taps meant for the post action row sitting behind it.
          className={`md:hidden fixed right-6 bottom-20 z-[60] w-12 h-12 rounded-full bg-yellow-500 hover:bg-yellow-400 active:bg-yellow-600 text-black flex items-center justify-center shadow-lg shadow-black/30 transition-all duration-200 cursor-pointer ${
            hasInlineDraft ? 'opacity-0 translate-y-24 pointer-events-none' : isScrolling ? 'opacity-30 pointer-events-none' : 'opacity-100'
          }`}
        >
          <HiOutlinePencilAlt className="w-7 h-7" />
        </button>
      )}

      {/* Floating feedback button */}
      <div className="fixed z-[51] left-[5px] bottom-[calc(var(--bottom-nav-h,0px)+5px)]">
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
