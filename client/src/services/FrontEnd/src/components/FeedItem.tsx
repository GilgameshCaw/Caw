// src/components/FeedItem.tsx - UPDATED FOR CONSISTENCY
import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSignAndSubmitAction } from '~/api/actions'
import { 
  HiOutlineHeart, 
  HiOutlineEye, 
  HiOutlineChat, 
  HiOutlineDotsHorizontal,
  HiOutlineTranslate,
  HiOutlineClipboard,
  HiOutlineThumbUp,
  HiOutlineThumbDown,
  HiOutlineVolumeOff,
  HiOutlineFilter,
  HiOutlineEyeOff,
  HiOutlineUserRemove,
  HiOutlineExclamation
} from 'react-icons/hi'
import Recaw from '~/assets/images/recaw.svg?react';
import Pencil from '~/assets/images/pencil.svg?react';
import Bookmark from '~/assets/images/bookmark.svg?react';
import Share from '~/assets/images/share.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { Link } from 'react-router-dom'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'

const FeedItem: React.FC<{ item: CawItem; isMainPost?: boolean; isReply?: boolean }> = ({ item, isMainPost = false, isReply = false }) => {
  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const openModal        = useModalStore(s => s.openModal)
  const { isDark } = useTheme()
  const [busyLike, setBusyLike]     = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  const [isRecawed, setIsRecawed]   = useState(false)
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionsMenuRef = useRef<HTMLDivElement>(null)

  // close menus on any outside click
  useEffect(() => {
    if (!showRecawMenu && !showOptionsMenu) return
    function onClickOutside(e: MouseEvent) {
      const target = e.target as Node
      const isRecawMenuOpen = showRecawMenu && menuRef.current && !menuRef.current.contains(target)
      const isOptionsMenuOpen = showOptionsMenu && optionsMenuRef.current && !optionsMenuRef.current.contains(target)
      
      if (isRecawMenuOpen || isOptionsMenuOpen) {
        e.stopPropagation();
        e.preventDefault();
        setShowRecawMenu(false)
        setShowOptionsMenu(false)
      }
    }
    document.addEventListener('click', onClickOutside, true)
    return () => document.removeEventListener('click', onClickOutside, true)
  }, [showRecawMenu, showOptionsMenu])

  let useItem = item;
  let headline;
  if (item.content === "" && item.parent) {
    headline = 'Recawed by ' + item.user.username
    useItem = item.parent;
  }

  const handleLike = async (event: React.MouseEvent) => {
    if (!activeTokenId || busyLike) return
    event.preventDefault()
    setBusyLike(true)
    try {
      await signAndSubmit({
        actionType:      useItem.hasLiked ? 'unlike' : 'like',
        senderId:        activeTokenId,
        receiverId:      useItem.user.id,
        receiverCawonce: useItem.cawonce ?? 0,
      })
    } catch (err) {
      console.error('Like failed', err)
    } finally {
      setBusyLike(false)
    }
  }

  const handleRecaw = async (event: React.MouseEvent) => {
    if (!activeTokenId || busyRecaw) return
    event.preventDefault()
    setBusyRecaw(true)
    try {
      await signAndSubmit({
        actionType:      'recaw',
        senderId:        activeTokenId,
        receiverId:      Number(useItem.user.id ?? 0),
        receiverCawonce: useItem.cawonce ?? 0,
      })
      setIsRecawed(!isRecawed) // Toggle recawed state
    } catch (err) {
      console.error('Recaw failed', err)
    } finally {
      setBusyRecaw(false)
    }
  }

  const handleReply = (e: React.MouseEvent) => {
    e.preventDefault()
    openModal('comment')
  }

  const handleOptionsClick = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    setShowOptionsMenu(!showOptionsMenu)
  }

  const handleMenuAction = (action: string) => {
    setShowOptionsMenu(false)
    // Handle different menu actions
    switch (action) {
      case 'translate':
        console.log('Translate post')
        break
      case 'copy':
        navigator.clipboard.writeText(useItem.content)
        break
      case 'show-more':
        console.log('Show more like this')
        break
      case 'show-less':
        console.log('Show less like this')
        break
      case 'mute-thread':
        console.log('Mute thread')
        break
      case 'mute-words':
        console.log('Mute words and tags')
        break
      case 'hide-post':
        console.log('Hide post for me')
        break
      case 'mute-account':
        console.log('Mute this account')
        break
      case 'block-account':
        console.log('Block account')
        break
      case 'report':
        console.log('Report post')
        break
      default:
        break
    }
  }

  return (
    <>
      <Link to={`/caws/${item.id}`} className="block">
        <div className={`p-4 transition-all duration-300 hover:bg-gray-500/5 cursor-pointer border-b ${
          isDark ? 'border-gray-800' : 'border-gray-200'
        }`}>
          {/* Replying to header */}
          {item.parent && (
            <Link to={`/caws/${item.parent.id}`} className={`block text-xs underline transition-all duration-300 mb-3 truncate md:truncate-none ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Replying to @{item.parent.user.username}
            </Link>
          )}
          
          {/* Recawed header */}
          {headline && (
            <div className={`text-xs mb-3 transition-all duration-300 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              {headline}
            </div>
          )}
          
          {/* Post Header */}
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center space-x-3">
              {/* Avatar */}
              <Link 
                to={`/users/${useItem.user.username}`} 
                className="w-10 h-10 rounded-full cursor-pointer overflow-hidden"
              >
                <img 
                  src="/images/logo.jpeg" 
                  alt={`${useItem.user.username} avatar`}
                  className="w-full h-full object-cover rounded-full hover:opacity-80 transition-opacity duration-200"
                />
              </Link>
              
              {/* User info */}
              <div className="flex-1">
                <div className="flex items-center space-x-2">
                  <Link 
                    to={`/users/${useItem.user.username}`} 
                    className={`font-semibold transition-colors duration-300 cursor-pointer hover:underline max-w-[6ch] truncate md:max-w-none md:truncate-none ${
                      isDark ? 'text-white' : 'text-black'
                    }`}
                  >
                    {useItem.user.username}
                  </Link>
                  <span className={`text-sm transition-colors duration-300 max-w-[6ch] truncate md:max-w-none md:truncate-none ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}>
                    @{useItem.user.username}
                  </span>
                  <span className={`text-sm transition-colors duration-300 ml-4 md:ml-0 ${
                    isDark ? 'text-gray-500' : 'text-gray-500'
                  }`}>
                    · {Math.floor(Math.random() * 24) + 1}h
                  </span>
                </div>
              </div>
            </div>

            {/* Three dots menu */}
            <div className="relative" ref={optionsMenuRef}>
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleOptionsClick(e)
                }}
                className={`p-2 rounded-full transition-all duration-200 hover:bg-gray-500/10 cursor-pointer ${
                  isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
                }`}
                title="More options"
              >
                <HiOutlineDotsHorizontal className="w-5 h-5" />
              </button>
            </div>
          </div>

          {/* Post Content */}
          <div className={`mb-4 transition-colors duration-300 pl-2 md:pl-0 ${
            isDark ? 'text-gray-200' : 'text-gray-800'
          }`}>
            {useItem.content}
          </div>

          {/* Post Actions */}
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-6">
              {/* Comments */}
              <button 
                className={`flex items-center space-x-2 transition-colors duration-300 hover:text-blue-500 cursor-pointer ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleReply}
                title="Reply"
              >
                <HiOutlineChat className="w-5 h-5" />
                <span className="text-sm">{useItem.commentCount}</span>
              </button>

              {/* Retweets */}
              <div className="relative">
                <button 
                  className={`group flex items-center space-x-2 transition-colors duration-300 hover:text-green-500 cursor-pointer ${
                    isRecawed 
                      ? 'text-green-500' 
                      : isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}
                  onClick={e => { e.preventDefault(); setShowRecawMenu(show => !show) }}
                  title="ReCaw"
                >
                  <Recaw className={`w-5 h-5 transition-all duration-300 ${
                    isRecawed ? 'text-green-500' : ''
                  }`} />
                  <span className={`text-sm transition-colors duration-300 ${
                    isRecawed ? 'text-green-500' : ''
                  }`}>{useItem.recawCount}</span>
                </button>

                {showRecawMenu && (
                  <div
                    ref={menuRef}
                    className={`absolute z-10 text-bold rounded-lg p-2 space-y-1 shadow transition-all duration-300 ${
                      isDark 
                        ? 'text-white bg-black' 
                        : 'text-black bg-white border border-gray-200'
                    }`}
                    style={{ left: '-3px', top: '0' }}
                  >
                    <button
                      className={`flex items-center gap-2 px-3 py-1 cursor-pointer rounded transition-all duration-200 ${
                        isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                      }`}
                      onClick={e => { e.preventDefault(); setShowRecawMenu(false); handleRecaw(e) }}
                    >
                      <Recaw className={`w-4 h-4 transition-all duration-300 ${
                        isDark ? 'text-white' : 'text-gray-600'
                      }`} /> Repost
                    </button>
                    <button
                      className={`flex items-center gap-2 px-3 py-1 cursor-pointer rounded transition-all duration-200 ${
                        isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                      }`}
                      onClick={e => { e.preventDefault(); setShowRecawMenu(false); openModal('quote') }}
                    >
                      <Pencil className={`w-4 h-4 transition-all duration-300 ${
                        isDark ? 'fill-white' : 'fill-gray-600'
                      }`}/> Quote
                    </button>
                  </div>
                )}
              </div>

              {/* Likes */}
              <button 
                className={`flex items-center space-x-2 transition-colors duration-300 hover:text-red-500 cursor-pointer ${
                  useItem.hasLiked 
                    ? 'text-red-500' 
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleLike}
                disabled={busyLike}
                title="Like"
              >
                <HiOutlineHeart className={`w-5 h-5 ${useItem.hasLiked ? 'fill-current' : ''}`} />
                <span className="text-sm">{useItem.likeCount}</span>
              </button>

              {/* Views */}
              <button 
                className={`flex items-center space-x-2 transition-colors duration-300 cursor-pointer ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                title="Views"
              >
                <HiOutlineEye className="w-5 h-5" />
                <span className="text-sm">{Math.floor(Math.random() * 1000) + 100}</span>
              </button>
            </div>

            <div className="flex items-center space-x-4">
              {/* Bookmark */}
              <button 
                className={`transition-colors duration-300 hover:text-yellow-500 cursor-pointer ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                title="Save"
              >
                <Bookmark className={`w-5 h-5 transition-all duration-300 ${
                  isDark ? 'stroke-white stroke-[1.5]' : 'stroke-gray-600'
                }`} />
              </button>

              {/* Share */}
              <button 
                className={`transition-colors duration-300 hover:text-blue-500 cursor-pointer ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                title="Share"
              >
                <Share className={`w-5 h-5 transition-all duration-300 ${
                  isDark ? 'stroke-white stroke-[1.5]' : 'stroke-gray-600'
                }`} />
              </button>
            </div>
          </div>
        </div>
      </Link>

      {/* Modal profesional con Portal y positioning calculado */}
      {showOptionsMenu && createPortal(
        <>
          {/* Overlay de fondo profesional */}
          <div 
            className="fixed inset-0 bg-black/50 z-[40]"
            onClick={() => setShowOptionsMenu(false)}
          />
          
          {/* Modal con positioning calculado */}
          <div
            className={`fixed z-[50] w-64 rounded-lg shadow-xl border transition-all duration-300 ${
              isDark 
                ? 'bg-black border-white/20 text-white' 
                : 'bg-white border-gray-200 text-black'
            }`}
            style={{
              top: optionsMenuRef.current ? 
                (() => {
                  const rect = optionsMenuRef.current.getBoundingClientRect()
                  const isMobile = window.innerWidth < 640 // sm breakpoint
                  const navbarHeight = 80 // Height of mobile bottom navbar
                  const modalHeight = 400 // Approximate modal height
                  const bottomPosition = rect.bottom + 8
                  
                  if (isMobile) {
                    // Check if modal would overlap with mobile navbar
                    if ((bottomPosition + modalHeight) > (window.innerHeight - navbarHeight)) {
                      // Try positioning above the button
                      const topPosition = rect.top - modalHeight - 8
                      
                      // If it would go off-screen at the top, center it in viewport
                      if (topPosition < 20) {
                        return `${Math.max(20, (window.innerHeight - navbarHeight - modalHeight) / 2)}px`
                      }
                      
                      return `${topPosition}px`
                    }
                  }
                  
                  return `${bottomPosition}px`
                })() : '20px',
              right: optionsMenuRef.current ? 
                `${window.innerWidth - optionsMenuRef.current.getBoundingClientRect().right}px` : '16px'
            }}
          >
            <div className="py-2">
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('translate')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineTranslate className="w-5 h-5" />
                Translate
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('copy')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineClipboard className="w-5 h-5" />
                Copy post text
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('show-more')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineThumbUp className="w-5 h-5" />
                Show more like this
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('show-less')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineThumbDown className="w-5 h-5" />
                Show less like this
              </button>
              
              <div className={`border-t my-1 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('mute-thread')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineVolumeOff className="w-5 h-5" />
                Mute thread
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('mute-words')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineFilter className="w-5 h-5" />
                Mute words and tags
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('hide-post')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineEyeOff className="w-5 h-5" />
                Hide post for me
              </button>
              
              <div className={`border-t my-1 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('mute-account')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineVolumeOff className="w-5 h-5" />
                Mute this account
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('block-account')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineUserRemove className="w-5 h-5" />
                Block account
              </button>
              
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('report')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                <HiOutlineExclamation className="w-5 h-5" />
                Report post
              </button>
            </div>
          </div>
        </>,
        document.body
      )}
    </>
  )
}

export default FeedItem
