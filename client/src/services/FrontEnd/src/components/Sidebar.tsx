// src/services/FrontEnd/src/components/Sidebar.tsx
import React, { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { NavLink, useNavigate } from '~/utils/localizedRouter'
import ProfileChooser           from '~/components/ProfileChooser'
import { fetchTxPage }          from '../api/txs'
import { useTokenDataStore, useActiveToken, usePriceStore, usePriceSourceStore } from "~/store/tokenDataStore";
import { useTheme } from "~/hooks/useTheme";
import { useDmIdentity } from "~/hooks/useDmIdentity";
import { useDmUnreadStore } from "~/store/dmUnreadStore";
import { useNotificationUnreadStore } from "~/store/notificationUnreadStore";
import { useOffersUnreadStore } from "~/store/offersUnreadStore";


import { 
  HiOutlineHome, 
  HiOutlineClock, 
  HiOutlineCube, 
  HiOutlinePlus,
  HiOutlineSearch,
  HiOutlineBell,
  HiOutlineChat,
  HiOutlineBookmark,
  HiOutlineCog,
  HiOutlineUserAdd,
  HiOutlineColorSwatch,
  HiOutlineUser,
  HiOutlinePencilAlt,
  HiOutlineSun,
  HiOutlineMoon,
} from 'react-icons/hi'
import cawLogo from '~/assets/images/caw-logo.png'
import { useInstanceStore } from '~/store/instanceStore'
import { API_HOST } from '~/api/client'
import { useSignInModalStore } from '~/store/signInModalStore'
import { useModalStore } from '~/store'
import { useT } from '~/i18n/I18nProvider'

const links = ['Home','Explore','Notifications','Messages','Profile'] as const

/**
 * Shows which API the frontend is connected to, if it's not the current domain.
 * Only visible when using a fallback or discovered instance.
 */
function ApiHostIndicator() {
  const activeApiHost = useInstanceStore(s => s.activeApiHost)
  const { isDark } = useTheme()

  // Always show — display the resolved host or fallback to default
  const effectiveHost = activeApiHost || API_HOST || window.location.origin
  let displayHost: string
  try {
    displayHost = new URL(effectiveHost).host
  } catch {
    displayHost = effectiveHost || 'local'
  }

  const currentOrigin = window.location.origin
  const isFallback = activeApiHost && activeApiHost !== '' && activeApiHost !== currentOrigin && activeApiHost !== API_HOST
  const dotColor = isFallback ? 'bg-yellow-500 animate-pulse' : 'bg-green-500'

  return (
    <div className={`hidden sm:flex fixed bottom-3 left-3 z-10 items-center gap-1.5 text-xs ${
      isFallback
        ? isDark ? 'text-yellow-500/70' : 'text-amber-600/70'
        : isDark ? 'text-white/30' : 'text-gray-400'
    }`}>
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${dotColor}`} />
      <span className="truncate max-w-[200px]" title={effectiveHost}>
        {isFallback ? 'via ' : ''}{displayHost}
      </span>
    </div>
  )
}

function CawPriceTicker() {
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const mainnetPrice = usePriceStore(s => s.priceMap['a-hunters-dream-mainnet'] ?? 0)
  const sepoliaPrice = usePriceStore(s => s.priceMap['a-hunters-dream-sepolia'] ?? 0)
  const source = usePriceSourceStore(s => s.source)
  const toggleSource = usePriceSourceStore(s => s.toggle)
  const { isDark } = useTheme()

  const formatAmount = (n: number): string => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toFixed(0)
  }

  // Only allow toggling if BOTH sources are available — on production the
  // sepolia mirror will be null and toggling would do nothing useful.
  const canToggle = mainnetPrice > 0 && sepoliaPrice > 0

  if (!cawPrice || cawPrice <= 0) {
    return (
      <div className={`mt-1 text-xs ml-[17px] ${isDark ? 'text-white/30' : 'text-gray-700'}`}>
        CAW price loading...
      </div>
    )
  }

  const cawPerPenny = 0.01 / cawPrice

  return (
    <div
      onClick={canToggle ? toggleSource : undefined}
      title={canToggle ? `CAW price source: ${source} (click to switch)` : undefined}
      className={`mt-1 text-xs ml-[17px] select-none ${canToggle ? 'cursor-pointer' : ''} ${isDark ? 'text-white/30 hover:text-white/50' : 'text-gray-700 hover:text-gray-900'}`}
    >
      $0.01 ≈ {formatAmount(cawPerPenny)} CAW
      {source === 'sepolia' && canToggle && (
        <span className={`ml-1 ${isDark ? 'text-white/20' : 'text-gray-500'}`}>(s)</span>
      )}
    </div>
  )
}

interface SidebarProps {
  /** Called whenever the user activates a nav link. Used by the mobile
   *  drawer in MainLayout to close itself after navigation; desktop
   *  doesn't pass it because there's no drawer to close. */
  onNavigate?: () => void
}

const Sidebar: React.FC<SidebarProps> = ({ onNavigate }) => {
  const t = useT()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useActiveToken()
  const { isDark, toggle } = useTheme()
  const { hasIdentity: dmEnabled } = useDmIdentity(activeToken?.tokenId)
  // Sidebar badge mirrors the drawer: count of CONVERSATIONS with unread
  // messages, not total unread messages. See dmUnreadStore for rationale.
  const dmUnreadCount = useDmUnreadStore(s => s.unreadConversations)
  const notifUnreadCount = useNotificationUnreadStore(s => s.unreadCount)
  const offersUnreadCount = useOffersUnreadStore(s => s.unreadCount)
  const navigate = useNavigate()
  const location = useLocation()
  const showSignIn = useSignInModalStore(s => s.show)
  const openModal = useModalStore(s => s.openModal)
  const isCaptive = !activeToken?.username

  // Intercept nav clicks for captive users — show sign-in modal instead of navigating.
  // Always call onNavigate (even when we preventDefault for the sign-in
  // intercept) — the mobile drawer should close either way; the sign-in
  // modal renders above everything so the user still sees it.
  //
  // Twitter-style same-tab scroll-to-top: tapping a nav link while
  // already on its route scrolls back to the page top instead of
  // doing a no-op navigation.
  const guardClick = (e: React.MouseEvent) => {
    if (isCaptive) {
      e.preventDefault()
      showSignIn()
    } else {
      const targetHref = (e.currentTarget as HTMLAnchorElement).getAttribute('href') || ''
      if (targetHref && location.pathname === targetHref) {
        e.preventDefault()
        window.scrollTo({ top: 0, behavior: 'smooth' })
      }
    }
    onNavigate?.()
  }

  const handlePostClick = () => {
    if (isCaptive) {
      showSignIn()
      return
    }
    openModal('post')
  }

  // Helper function for consistent NavLink styling
  const getNavLinkClasses = (isActive: boolean) => {
    if (isActive) {
      return isDark
        ? 'bg-white/10 text-white'
        : 'bg-gray-100 text-black border border-gray-200'
    } else {
      return isDark
        ? 'text-gray-300 hover:text-white hover:bg-white/10'
        : 'text-gray-600 hover:text-black hover:bg-gray-200/50'
    }
  }

  return (
    <div className={`flex flex-col h-screen h-[100dvh] sm:h-full sm:justify-between w-full sm:w-[200px] border-r-0.5 sm:border-r transition-all duration-300 ${
      isDark 
        ? 'bg-black border-white/20' 
        : 'bg-white border-gray-300'
    }`}>
      <div className="flex flex-col flex-1 min-h-0">
        {/* Logo Section - Hidden on mobile */}
        <div className="hidden sm:block p-4">
          <NavLink
            to="/home"
            onClick={guardClick}
            className="caw-logo-lockup flex items-center pl-3 cursor-pointer hover:opacity-80 transition-opacity duration-200"
          >
              <img
                src={cawLogo}
                alt="CAW Logo"
                width={36}
                height={36}
                decoding="sync"
                loading="eager"
                fetchPriority="high"
                className={`caw-logo-mark w-9 h-9 object-contain ${isDark ? '' : 'drop-shadow-[1px_1px_1px_rgba(0,0,0,0.8)]'}`}
              />
            <span
              className="text-[2rem]"
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
          </NavLink>
          <CawPriceTicker />
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2 pt-[calc(72px+env(safe-area-inset-top))] sm:px-4 sm:py-3 sm:pr-2 sm:pl-2 sm:pt-1 space-y-0.5 flex-1 min-h-0 overflow-y-auto overscroll-contain thin-scrollbar">
          <NavLink
          to="/home"
          onClick={guardClick}
          className={({ isActive }) =>
            `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
          }>
            <HiOutlineHome className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.home')}</span>
          </NavLink>

           <NavLink
             to="/explore"
             onClick={() => onNavigate?.()}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
            <HiOutlineSearch className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.explore')}</span>
           </NavLink>

           <NavLink
             to="/notifications"
             onClick={guardClick}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
             <div className="relative shrink-0">
              <HiOutlineBell className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
              {notifUnreadCount > 0 && (
                <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
                </span>
              )}
             </div>
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.notifications')}</span>
           </NavLink>

           <NavLink
             to="/messages"
             onClick={(e) => {
               if (isCaptive) { e.preventDefault(); showSignIn(); onNavigate?.(); return }
               if (location.pathname.startsWith('/messages')) {
                 e.preventDefault()
                 navigate('/messages')
               }
               onNavigate?.()
             }}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive || location.pathname.startsWith('/messages/'))}`
             }
           >
             <div className="relative shrink-0">
              <HiOutlineChat className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
              {activeToken && dmEnabled === false && (
                <span className={`absolute -top-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full border-2 ${isDark ? 'border-black' : 'border-white'}`} />
              )}
              {dmUnreadCount > 0 && (
                <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {dmUnreadCount > 99 ? '99+' : dmUnreadCount}
                </span>
              )}
             </div>
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.messages')}</span>
           </NavLink>

           <NavLink
             to="/bookmarks"
             onClick={guardClick}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
            <HiOutlineBookmark className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.bookmarks')}</span>
           </NavLink>

           <NavLink
             to="/scheduled"
             onClick={guardClick}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
            <HiOutlineClock className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.scheduled')}</span>
           </NavLink>

           <NavLink
             to="/staking"
             onClick={guardClick}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
            <HiOutlineCube className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.staking')}</span>
           </NavLink>

           <NavLink
             to="/usernames"
             onClick={() => onNavigate?.()}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
             <div className="relative shrink-0">
              <HiOutlineColorSwatch className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
              {offersUnreadCount > 0 && (
                <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {offersUnreadCount > 99 ? '99+' : offersUnreadCount}
                </span>
              )}
             </div>
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.usernames')}</span>
           </NavLink>

           <NavLink
             to={activeToken?.username ? `/users/${activeToken.username}` : "/welcome"}
             onClick={guardClick}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
            <HiOutlineUser className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.profile')}</span>
           </NavLink>

           <NavLink
             to="/settings"
             onClick={guardClick}
             className={({ isActive }) =>
               `relative flex items-center gap-3 px-4 py-3.5 sm:gap-3 sm:px-3 sm:py-3.5 rounded-2xl transition-colors duration-200 min-w-0 ${getNavLinkClasses(isActive)}`
             }
           >
            <HiOutlineCog className="w-5 h-5 sm:w-6 sm:h-6 shrink-0" />
            <span className="font-medium text-base sm:text-lg min-w-0 truncate">{t('nav.settings')}</span>
           </NavLink>
        </nav>

        {!isCaptive && (
          <div className="hidden sm:block px-4 pt-2 pb-3">
            <button
              type="button"
              onClick={handlePostClick}
              className="w-full inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full bg-yellow-500 px-3 py-3 text-sm font-semibold text-black transition-colors duration-200 hover:bg-yellow-400 cursor-pointer"
            >
              <HiOutlinePencilAlt className="w-5 h-5" />
              {t('nav.write_something')}
            </button>
          </div>
        )}
      </div>

      <div className="pl-3 pr-0 mt-2 pb-[env(safe-area-inset-bottom)] sm:pl-4 sm:pr-0 sm:py-3 sm:mt-0 w-full shrink-0">
        <ProfileChooser compact />
        {/* Theme toggle — mobile only (desktop has it elsewhere) */}
        <button
          type="button"
          onClick={toggle}
          aria-label={isDark ? t('theme.switch_to_light') : t('theme.switch_to_dark')}
          className={`sm:hidden -ml-1 mt-1 mb-4 mr-3 flex items-center gap-2.5 pl-2 pr-3 py-2 rounded-2xl transition-colors duration-200 ${
            isDark ? 'text-gray-300 hover:text-white hover:bg-white/10' : 'text-gray-600 hover:text-black hover:bg-gray-200/50'
          }`}
        >
          {isDark ? <HiOutlineSun className="w-6 h-6" /> : <HiOutlineMoon className="w-6 h-6" />}
          <span className="font-medium text-base">{isDark ? t('theme.light_mode') : t('theme.dark_mode')}</span>
        </button>
      </div>
    </div>
  )
}

export default Sidebar
