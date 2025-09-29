import React, { useState, useEffect } from 'react'
import { HiOutlinePlus, HiOutlineMicrophone, HiOutlinePencil } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'

interface MobileSubMenuProps {
  isOpen: boolean
  onClose: () => void
  onPostClick: () => void
  onVoiceRoomClick: () => void
}

const MobileSubMenu: React.FC<MobileSubMenuProps> = ({ 
  isOpen, 
  onClose, 
  onPostClick, 
  onVoiceRoomClick 
}) => {
  const { isDark } = useTheme()
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

  if (!isOpen) {
    return null
  }

  return (
    <>
      {/* Backdrop - Mobile only */}
      <div 
        className="md:hidden fixed inset-0 z-40 bg-black/50"
        onClick={onClose}
      />
      
      {/* Submenu - Mobile only */}
      <div className="md:hidden fixed bottom-20 right-12 z-50">
        {/* New Post Option - Top Right */}
        <div 
          className="fixed"
          style={{ 
            bottom: '160px',
            right: '70px'
          }}
        >
          <button
            onClick={() => {
              onPostClick()
              onClose()
            }}
            className={`w-12 h-12 bg-orange-500 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ${
              isScrolling ? 'opacity-50' : 'opacity-100'
            }`}
          >
            <HiOutlinePencil className="w-5 h-5" />
          </button>
          <div className={`text-xs text-center mt-2 font-medium text-white transition-all duration-300 ${
            isScrolling ? 'opacity-50' : 'opacity-100'
          }`}>
            New Post
          </div>
        </div>

        {/* Voice Room Option - Bottom Left */}
        <div 
          className="fixed"
          style={{ 
            bottom: '80px',
            right: '110px'
          }}
        >
          <button
            onClick={() => {
              onVoiceRoomClick()
              onClose()
            }}
            className={`w-12 h-12 bg-purple-500 text-white rounded-full shadow-lg flex items-center justify-center transition-all duration-300 ${
              isScrolling ? 'opacity-50' : 'opacity-100'
            }`}
          >
            <HiOutlineMicrophone className="w-5 h-5" />
          </button>
          <div className={`text-xs text-center mt-2 font-medium text-white transition-all duration-300 ${
            isScrolling ? 'opacity-50' : 'opacity-100'
          }`} style={{ marginLeft: '-10px' }}>
            Voice Room
          </div>
        </div>
      </div>
    </>
  )
}

export default MobileSubMenu
