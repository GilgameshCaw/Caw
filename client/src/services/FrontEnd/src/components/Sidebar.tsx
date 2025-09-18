// src/services/FrontEnd/src/components/Sidebar.tsx
import React, { useEffect, useState } from 'react'
import { NavLink }              from 'react-router-dom'
import ProfileChooser           from '~/components/ProfileChooser'
import { fetchTxPage }          from '../api/txs'
import { useTokenDataStore, useActiveToken } from "~/store/tokenDataStore";
import { useTheme } from "~/hooks/useTheme";


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

const links = ['Home','Explore','Notifications','Messages','Profile'] as const

const Sidebar: React.FC = () => {
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useActiveToken()
  const [pending, setPending] = useState(0)
  const { isDark, toggle } = useTheme()

  console.log('Current theme:', isDark ? 'dark' : 'light')

  useEffect(() => {
    let cancelled = false
    async function load() {
      if (!activeTokenId) return setPending(0)
      try {
        // hit our paginated endpoint with page=1,limit=1 to just get total
        const { total } = await fetchTxPage(activeTokenId, 1, 1)
        if (!cancelled) setPending(total)
      } catch (err) {
        console.error('Could not load pending count', err)
      }
    }
    load()
    const iv = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(iv)
    }
  }, [activeTokenId])

  // Helper function for consistent NavLink styling
  const getNavLinkClasses = (isActive: boolean) => {
    if (isActive) {
      return isDark
        ? 'bg-white/10 text-white'
        : 'bg-gray-800 text-white'
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
      <div className="flex flex-col h-full sm:flex-1">
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
          </NavLink>
        </div>

        {/* Navigation */}
        <nav className="px-2 py-2 pt-20 sm:px-4 sm:py-4 sm:pl-0 sm:pt-4 space-y-1 sm:flex-1">
          <NavLink
          to="/home"
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
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineBell className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Notifications</span>
          </NavLink>

          <NavLink
            to="/messages"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineChat className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Messages</span>
          </NavLink>

          <NavLink
            to="/bookmarks"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineBookmark className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Bookmarks</span>
          </NavLink>

          <NavLink
          to="/pending"
          className={({ isActive }) =>
            `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
          }
          >
            <HiOutlineClock className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Pending</span>
            {pending > 0 && (
              <span className="absolute top-1 right-1 inline-flex items-center justify-center
              px-2 py-0.5 text-xs font-bold text-white bg-red-500 rounded-full
              transform translate-x-1/2 -translate-y-1/2 min-w-[20px] h-5
              shadow-lg shadow-red-500/30 animate-pulse">
                {pending}
              </span>
            )}
          </NavLink>

          <NavLink
            to="/staking"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineCube className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Staking</span>
          </NavLink>

          <NavLink
            to="/mint"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineColorSwatch className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Mint</span>
          </NavLink>

          <NavLink
            to="/gamefi"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <svg className="w-7 h-7 sm:w-7 sm:h-7" fill="none" stroke="currentColor" viewBox="0 0 32 32">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M30.9,25l-3-14.9c-0.3-1.3-1.1-2.5-2.2-3.2c-1.9-1.1-4.3-0.8-5.8,0.7L18.6,9h-2h-1.1h-2l-1.4-1.4 c-1.5-1.5-3.9-1.8-5.8-0.7c-1.2,0.7-2,1.8-2.2,3.2L1.1,25c-0.3,1.6,0.9,3,2.5,3c0.6,0,1.1-0.2,1.5-0.7L8.8,23c1.7-1.9,4.1-3,6.6-3 h1.1c2.5,0,5,1.1,6.6,3l3.8,4.3c0.4,0.4,0.9,0.7,1.5,0.7C30.1,28,31.3,26.5,30.9,25z" />
              <circle strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" cx="23" cy="14" r="2" />
              <line strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" x1="9" y1="16" x2="9" y2="12" />
              <line strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" x1="11" y1="14" x2="7" y2="14" />
              <line strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" x1="17" y1="13" x2="15" y2="13" />
              <line strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" x1="17" y1="16" x2="15" y2="16" />
            </svg>
            <span className="font-medium text-lg sm:text-lg">GameFi</span>
            <span className={`px-1.5 py-0.5 text-xs font-semibold rounded-full transition-colors duration-300 ${
              isDark 
                ? 'bg-yellow-500 text-black' 
                : 'bg-yellow-500 text-black'
            }`}>
              New
            </span>
          </NavLink>

          <NavLink
            to={activeToken ? `/users/${activeToken.username}` : "/profile"}
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineUser className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Profile</span>
          </NavLink>

          <NavLink
            to="/settings"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineCog className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Settings</span>
          </NavLink>
        </nav>
      </div>

      <div className="px-3 -mt-4 pb-0 sm:px-4 sm:py-4 sm:absolute sm:bottom-0">
        <ProfileChooser/>
      </div>
    </div>
  )
}

export default Sidebar

