// src/components/ReplyItem.tsx - Specific component for replies in individual posts
import React, { useState, useRef, useEffect } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { HiOutlineHeart, HiOutlineEye, HiOutlineChat } from 'react-icons/hi'
import Recaw from '~/assets/images/recaw.svg?react';
import Pencil from '~/assets/images/pencil.svg?react';
import Bookmark from '~/assets/images/bookmark.svg?react';
import Share from '~/assets/images/share.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { Link } from 'react-router-dom'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'

const ReplyItem: React.FC<{ item: CawItem }> = ({ item }) => {
  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const openModal        = useModalStore(s => s.openModal)
  const { isDark } = useTheme()
  const [busyLike, setBusyLike]     = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  const [isRecawed, setIsRecawed]   = useState(false)
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // close menu on any outside click
  useEffect(() => {
    if (!showRecawMenu) return
    function onClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        e.stopPropagation();
        e.preventDefault();
        setShowRecawMenu(false)
      }
    }
    document.addEventListener('click', onClickOutside, true)
    return () => document.removeEventListener('click', onClickOutside, true)
  }, [showRecawMenu])

  const handleLike = async (event: React.MouseEvent) => {
    if (!activeTokenId || busyLike) return
    event.preventDefault()
    setBusyLike(true)
    try {
      await signAndSubmit({
        actionType:      item.hasLiked ? 'unlike' : 'like',
        senderId:        activeTokenId,
        receiverId:      item.user.id,
        receiverCawonce: item.cawonce ?? 0,
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
        receiverId:      Number(item.user.id ?? 0),
        receiverCawonce: item.cawonce ?? 0,
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

  return (
    <Link to={`/caws/${item.id}`} className="block">
      <div className="p-4 transition-all duration-300 hover:bg-gray-500/5 cursor-pointer">
        {/* Reply Layout - Avatar left, content right */}
        <div className="flex items-start space-x-3">
          {/* Avatar - Left side, positioned for vertical line connection */}
          <Link 
            to={`/users/${item.user.username}`} 
            className="w-10 h-10 rounded-full cursor-pointer overflow-hidden flex-shrink-0"
          >
            <img 
              src="/images/logo.jpeg" 
              alt={`${item.user.username} avatar`}
              className="w-full h-full object-cover rounded-full hover:opacity-80 transition-opacity duration-200"
            />
          </Link>
          
          {/* Content - Right side of avatar */}
          <div className="flex-1 min-w-0">
            {/* User info */}
            <div className="flex items-center space-x-2 mb-2">
              <Link 
                to={`/users/${item.user.username}`} 
                className={`font-semibold transition-colors duration-300 cursor-pointer hover:underline ${
                  isDark ? 'text-white' : 'text-black'
                }`}
              >
                {item.user.username}
              </Link>
              <span className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                @{item.user.username}
              </span>
              <span className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-500' : 'text-gray-500'
              }`}>
                · {Math.floor(Math.random() * 24) + 1}h
              </span>
            </div>
            
            {/* Post content */}
            <div className={`mb-3 transition-colors duration-300 ${
              isDark ? 'text-gray-200' : 'text-gray-800'
            }`}>
              {item.content}
            </div>
            
            {/* Interaction icons - aligned with user info and content */}
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
                <span className="text-sm">{item.commentCount}</span>
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
                  }`}>{item.recawCount}</span>
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
                  item.hasLiked 
                    ? 'text-red-500' 
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleLike}
                disabled={busyLike}
                title="Like"
              >
                <HiOutlineHeart className={`w-5 h-5 ${item.hasLiked ? 'fill-current' : ''}`} />
                <span className="text-sm">{item.likeCount}</span>
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
          </div>
        </div>
      </div>
    </Link>
  )
}

export default ReplyItem

