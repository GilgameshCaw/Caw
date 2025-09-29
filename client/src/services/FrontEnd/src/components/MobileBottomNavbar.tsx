import React, { useState, useEffect } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { 
  HiOutlineHome, 
  HiOutlineSearch, 
  HiOutlineBell, 
  HiOutlineMail 
} from 'react-icons/hi'

interface MobileBottomNavbarProps {
  activeTab?: string
  onTabChange?: (tab: string) => void
  isVisible?: boolean
}

const MobileBottomNavbar: React.FC<MobileBottomNavbarProps> = ({ 
  activeTab, 
  onTabChange,
  isVisible = true
}) => {
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const [isScrolling, setIsScrolling] = useState(false)

  useEffect(() => {
    let scrollTimer: NodeJS.Timeout
    
    const handleScroll = () => {
      setIsScrolling(true)
      clearTimeout(scrollTimer)
      scrollTimer = setTimeout(() => {
        setIsScrolling(false)
      }, 150)
    }

    window.addEventListener('scroll', handleScroll)
    return () => {
      window.removeEventListener('scroll', handleScroll)
      clearTimeout(scrollTimer)
    }
  }, [])

  const navItems = [
    { id: 'home', icon: HiOutlineHome, label: 'Home', path: '/home' },
    { id: 'search', icon: HiOutlineSearch, label: 'Search', path: '/explore' },
    { id: 'notifications', icon: HiOutlineBell, label: 'Notifications', path: '/notifications' },
    { id: 'messages', icon: HiOutlineMail, label: 'Messages', path: '/messages' }
  ]

  // Determine active tab based on current location
  const getCurrentActiveTab = () => {
    if (activeTab) return activeTab
    
    const currentPath = location.pathname
    const currentItem = navItems.find(item => item.path === currentPath)
    return currentItem?.id || 'home'
  }

  const handleTabClick = (item: typeof navItems[0]) => {
    // Call the onTabChange callback if provided
    onTabChange?.(item.id)
    
    // Navigate to the route
    navigate(item.path)
  }

  if (!isVisible) return null

  return (
    <div className={`md:hidden fixed bottom-0 left-0 right-0 z-50 border-t border-white/10 transition-all duration-300 ${
      isScrolling ? 'bg-black/60' : 'bg-black'
    }`}>
      <div className="flex items-center justify-around py-2">
        {navItems.map((item) => {
          const Icon = item.icon
          const isActive = getCurrentActiveTab() === item.id
          
          return (
            <button
              key={item.id}
              onClick={() => handleTabClick(item)}
              className={`flex items-center justify-center py-3 px-4 transition-all duration-300 ${
                isActive 
                  ? 'text-white' 
                  : 'text-gray-400 hover:text-gray-300'
              } ${isScrolling ? 'opacity-60' : 'opacity-100'}`}
            >
              <Icon className="w-6 h-6" />
            </button>
          )
        })}
      </div>
    </div>
  )
}

export default MobileBottomNavbar
