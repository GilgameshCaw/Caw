// src/services/FrontEnd/src/components/Sidebar.tsx
import React, { useEffect, useState } from 'react'
import { NavLink, useNavigate, useLocation } from 'react-router-dom'
import ProfileChooser           from '~/components/ProfileChooser'
import { fetchTxPage }          from '../api/txs'
import { useTokenDataStore, useActiveToken, usePriceStore } from "~/store/tokenDataStore";
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
  HiOutlineSun,
  HiOutlineMoon
} from 'react-icons/hi'
import cawLogo from '~/assets/images/caw-logo.png'
import { useInstanceStore } from '~/store/instanceStore'
import { API_HOST } from '~/api/client'
import { useSignInModalStore } from '~/store/signInModalStore'

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
  const { isDark } = useTheme()

  const formatAmount = (n: number): string => {
    if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
    return n.toFixed(0)
  }

  if (!cawPrice || cawPrice <= 0) {
    return (
      <div className={`mt-2 text-xs ml-[26px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
        CAW price loading...
      </div>
    )
  }

  const cawPerPenny = 0.01 / cawPrice

  return (
    <div className={`mt-2 text-xs ml-[26px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
      $0.01 ≈ {formatAmount(cawPerPenny)} CAW
    </div>
  )
}

const Sidebar: React.FC = () => {
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useActiveToken()
  const { isDark, toggle } = useTheme()
  const { hasIdentity: dmEnabled } = useDmIdentity(activeToken?.tokenId)
  const dmUnreadCount = useDmUnreadStore(s => s.totalUnread)
  const notifUnreadCount = useNotificationUnreadStore(s => s.unreadCount)
  const offersUnreadCount = useOffersUnreadStore(s => s.unreadCount)
  const navigate = useNavigate()
  const location = useLocation()
  const showSignIn = useSignInModalStore(s => s.show)
  const isCaptive = !activeToken?.username

  // Intercept nav clicks for captive users — show sign-in modal instead of navigating
  const guardClick = (e: React.MouseEvent) => {
    if (isCaptive) {
      e.preventDefault()
      showSignIn()
    }
  }

  // Helper function for consistent NavLink styling
  const getNavLinkClasses = (isActive: boolean) => {
    if (isActive) {
      return isDark
        ? 'bg-white/10 text-white'
        : 'bg-gray-100 text-black shadow-xl border border-gray-200'
    } else {
      return isDark
        ? 'text-gray-300 hover:text-white hover:bg-white/10'
        : 'text-gray-600 hover:text-black hover:bg-gray-200/50'
    }
  }

  return (
    <div className={`flex flex-col h-screen sm:h-full sm:justify-between w-full sm:w-[200px] border-r-0.5 sm:border-r transition-all duration-300 ${
      isDark 
        ? 'bg-black border-white/20' 
        : 'bg-white border-gray-300'
    }`}>
      <div className="flex flex-col sm:flex-1 sm:min-h-0">
        {/* Logo Section - Hidden on mobile */}
        <div className="hidden sm:block p-4 pl-0">
          <NavLink
            to="/home"
            className="flex items-center pl-3 cursor-pointer hover:opacity-80 transition-opacity duration-200"
          >
            <img
              src={cawLogo}
              alt="CAW Logo"
              className="w-10 h-10 object-contain"
            />
            <span
              className="text-4xl"
              style={{
                fontFamily: 'Fraunces',
                color: '#ebc046',
                letterSpacing: '5px',
                marginLeft: '10px',
                textShadow: isDark
                  ? '0 1px 2px rgba(0, 0, 0, 0.6), 0 0 4px rgba(0, 0, 0, 0.3)'
                  : 'rgb(0 0 0) 0px 1px 1px, rgb(240 177 0) 0px 0px 3px',
              }}
            >
              CAW
            </span>
          </NavLink>
          <CawPriceTicker />
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2 pt-20 sm:px-4 sm:py-4 sm:pr-2 sm:pl-2 sm:pt-4 space-y-1 sm:flex-1 sm:overflow-y-auto sm:min-h-0">
          <NavLink
          to="/home"
          onClick={guardClick}
          className={({ isActive }) =>
            `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
          }>
            <HiOutlineHome className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Home</span>
          </NavLink>

          <NavLink
            to="/explore"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineSearch className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Explore</span>
          </NavLink>

          <NavLink
            to="/notifications"
            onClick={guardClick}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <div className="relative">
              <HiOutlineBell className="w-7 h-7 sm:w-7 sm:h-7" />
              {notifUnreadCount > 0 && (
                <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {notifUnreadCount > 99 ? '99+' : notifUnreadCount}
                </span>
              )}
            </div>
            <span className="font-medium text-lg sm:text-lg">Notifications</span>
          </NavLink>

          <NavLink
            to="/messages"
            onClick={(e) => {
              if (isCaptive) { e.preventDefault(); showSignIn(); return }
              if (location.pathname.startsWith('/messages')) {
                e.preventDefault()
                navigate('/messages')
              }
            }}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive || location.pathname.startsWith('/messages/'))}`
            }
          >
            <div className="relative">
              <HiOutlineChat className="w-7 h-7 sm:w-7 sm:h-7" />
              {activeToken && dmEnabled === false && (
                <span className={`absolute -top-1 -right-1 w-3 h-3 bg-yellow-500 rounded-full border-2 ${isDark ? 'border-black' : 'border-white'}`} />
              )}
              {dmUnreadCount > 0 && (
                <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {dmUnreadCount > 99 ? '99+' : dmUnreadCount}
                </span>
              )}
            </div>
            <span className="font-medium text-lg sm:text-lg">Messages</span>
          </NavLink>

          <NavLink
            to="/bookmarks"
            onClick={guardClick}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineBookmark className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Bookmarks</span>
          </NavLink>

          <NavLink
            to="/scheduled"
            onClick={guardClick}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineClock className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Scheduled</span>
          </NavLink>

          <NavLink
            to="/staking"
            onClick={guardClick}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineCube className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Staking</span>
          </NavLink>

          <NavLink
            to="/usernames"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <div className="relative">
              <HiOutlineColorSwatch className="w-7 h-7 sm:w-7 sm:h-7" />
              {offersUnreadCount > 0 && (
                <span className={`absolute -top-2 -right-2 min-w-[18px] h-[18px] flex items-center justify-center text-[11px] font-bold rounded-full bg-yellow-500 text-black px-1 border-2 ${isDark ? 'border-black' : 'border-white'}`}>
                  {offersUnreadCount > 99 ? '99+' : offersUnreadCount}
                </span>
              )}
            </div>
            <span className="font-medium text-lg sm:text-lg">Usernames</span>
          </NavLink>

          <NavLink
            to={activeToken?.username ? `/users/${activeToken.username}` : "/welcome"}
            onClick={guardClick}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineUser className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Profile</span>
          </NavLink>

          <NavLink
            to="/settings"
            onClick={guardClick}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineCog className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Settings</span>
          </NavLink>
        </nav>
      </div>

      <div className="pl-3 pr-0 -mt-4 pb-0 sm:pl-4 sm:pr-0 sm:py-4 w-full shrink-0">
        <ProfileChooser/>
      </div>
    </div>
  )
}

export default Sidebar

