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
  const { isDark, toggle } = useTheme()

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
            <span className={`ml-2 text-xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
              CAW
            </span>
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
            to="/scheduled"
            className={({ isActive }) =>
              `relative flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5 sm:py-4 rounded-2xl transition-colors duration-200 ${getNavLinkClasses(isActive)}`
            }
          >
            <HiOutlineClock className="w-7 h-7 sm:w-7 sm:h-7" />
            <span className="font-medium text-lg sm:text-lg">Scheduled</span>
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

