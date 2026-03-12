// src/components/ReplyItem.tsx - Specific component for replies in individual posts
import React, { useState, useRef, useEffect } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { useAccount, useChainId } from 'wagmi'
import { HiOutlineHeart, HiOutlineEye, HiOutlineChat, HiOutlineCheck } from 'react-icons/hi'
import Recaw from '~/assets/images/recaw.svg?react';
import Pencil from '~/assets/images/pencil.svg?react';
import Bookmark from '~/assets/images/bookmark.svg?react';
import Share from '~/assets/images/share.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { Link } from 'react-router-dom'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { usePendingCawPolling, usePendingLikePolling, usePendingReplyPolling } from '~/hooks/usePendingPolling'
import SwitchChainModal from './modals/SwitchChainModal'
import { chains } from '~/config/chains'

// Helper function to format relative time
function formatTimeAgo(timestamp: string): string {
  const now = new Date()
  const time = new Date(timestamp)
  const diffInMs = now.getTime() - time.getTime()
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60))
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60))
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24))

  if (diffInMinutes < 1) {
    return 'now'
  } else if (diffInMinutes < 60) {
    return `${diffInMinutes}m`
  } else if (diffInHours < 24) {
    return `${diffInHours}h`
  } else if (diffInDays < 7) {
    return `${diffInDays}d`
  } else {
    return time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}

const ReplyItem: React.FC<{ item: CawItem; onLikeStateChange?: (cawId: string, likePending: boolean) => void; onReplyStateChange?: (cawId: string, replyPending: boolean) => void }> = ({ item, onLikeStateChange, onReplyStateChange }) => {
  // Enable polling for pending items
  usePendingCawPolling(parseInt(item.id), item.status === 'PENDING')
  usePendingLikePolling(parseInt(item.id), item.likePending || false)
  const [replyPending, setReplyPending] = useState(item.replyPending || false)
  usePendingReplyPolling(parseInt(item.id), replyPending)

  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })
  const openModal        = useModalStore(s => s.openModal)
  const { isDark } = useTheme()
  const { address } = useAccount()
  const chainId = useChainId()
  const [busyLike, setBusyLike]     = useState(false)
  const [showSwitchChainModal, setShowSwitchChainModal] = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  const [isRecawed, setIsRecawed]   = useState(false)
  const [likePending, setLikePending] = useState(item.likePending || false)
  const [wrongWalletError, setWrongWalletError] = useState(false)
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  // Sync local likePending state with item.likePending from polling
  useEffect(() => {
    setLikePending(item.likePending || false)
  }, [item.likePending])

  // Sync local replyPending state with item.replyPending from polling
  useEffect(() => {
    setReplyPending(item.replyPending || false)
  }, [item.replyPending])

  // Clear wrong wallet error when address changes
  useEffect(() => {
    if (wrongWalletError && activeToken && activeToken.address.toLowerCase() === address?.toLowerCase()) {
      setWrongWalletError(false)
    }
  }, [address, activeToken, wrongWalletError])

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
    // MUST call these first, before any early returns!
    event.preventDefault()
    event.stopPropagation()

    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId || busyLike) {
      return
    }

    // Don't allow interactions with pending or failed caws
    if (item.status === 'PENDING' || item.status === 'FAILED') {
      return
    }

    // Check if connected to wrong chain (need L2 for actions)
    if (chainId !== chains.l2.chainId) {
      setShowSwitchChainModal(true)
      return
    }

    // Check if connected to wrong wallet
    if (activeToken && address && activeToken.address.toLowerCase() !== address.toLowerCase()) {
      setWrongWalletError(true)
      setTimeout(() => setWrongWalletError(false), 5000) // Clear error after 5 seconds
      return
    }

    setBusyLike(true)
    try {
      await signAndSubmit({
        actionType:      item.hasLiked ? 'unlike' : 'like',
        senderId:        effectiveTokenId,
        receiverId:      item.user.id,
        receiverCawonce: item.cawonce ?? 0,
      })

      // Set pending state after successful submission
      setLikePending(true)

      // Notify parent component about like state change
      if (onLikeStateChange) {
        onLikeStateChange(item.id, true)
      }
    } catch (err) {
      console.error('Like failed', err)
    } finally {
      setBusyLike(false)
    }
  }

  const handleRecaw = async (event: React.MouseEvent) => {
    if (!activeTokenId || busyRecaw) return
    event.preventDefault()
    event.stopPropagation() // Prevent navigation to caw page
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
    e.stopPropagation() // Prevent navigation to caw page
    openModal('comment', item, () => {
      setReplyPending(true)
      if (onReplyStateChange) {
        onReplyStateChange(item.id, true)
      }
    })
  }

  return (
    <Link to={`/caws/${item.id}`} className="block">
      <div className={`p-4 transition-all duration-300 hover:bg-gray-500/5 cursor-pointer ${
        (item.status === 'PENDING' || item.status === 'FAILED') ? 'opacity-60' : ''
      }`}>
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
                {item.user.displayName || item.user.username}
              </Link>
              <span className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-400' : 'text-gray-600'
              }`}>
                @{item.user.username}
              </span>
              <span className={`text-sm transition-colors duration-300 ${
                isDark ? 'text-gray-500' : 'text-gray-500'
              }`}>
                · {formatTimeAgo(item.timestamp)}
              </span>
              {item.status === 'PENDING' && (
                <span className="ml-2 px-2 py-0.5 text-xs bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 rounded-full">
                  Pending
                </span>
              )}
            </div>
            
            {/* Post content */}
            <div className={`mb-3 transition-colors duration-300 ${
              isDark ? 'text-gray-200' : 'text-gray-800'
            }`}>
              {item.content}
            </div>
            
            {/* Interaction icons - aligned with user info and content */}
            <div className="flex items-center space-x-6" onClick={(e) => e.stopPropagation()}>
              {/* Comments/Replies */}
              <button
                className={`flex items-center space-x-2 transition-colors duration-300 hover:text-blue-500 cursor-pointer ${
                  (item.hasReplied || replyPending)
                    ? 'text-blue-500'
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleReply}
                title={replyPending ? "Processing reply..." : "Reply"}
              >
                {replyPending ? (
                  <div className="relative w-5 h-5 group">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin"></div>
                    <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-blue-500" />
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs bg-black text-white rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
                      Submitted, pending validation
                    </div>
                  </div>
                ) : (
                  <HiOutlineChat className="w-5 h-5" />
                )}
                <span className={`text-sm ${(item.hasReplied || replyPending) ? 'text-blue-500' : ''}`}>
                  {item.commentCount}
                </span>
              </button>

              {/* Retweets */}
              <div className="relative">
                <button
                  className={`group flex items-center space-x-2 transition-colors duration-300 hover:text-green-500 cursor-pointer ${
                    isRecawed
                      ? 'text-green-500'
                      : isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}
                  onClick={e => { e.preventDefault(); e.stopPropagation(); setShowRecawMenu(show => !show) }}
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
                    className={`absolute z-10 text-bold rounded-lg p-2 space-y-1 shadow-lg transition-all duration-300 ${
                      isDark
                        ? 'text-white bg-black/85 backdrop-blur-sm'
                        : 'text-black bg-white border border-gray-200'
                    }`}
                    style={{ left: '-3px', top: '0' }}
                  >
                    <button
                      className={`flex items-center gap-2 px-3 py-1 cursor-pointer rounded transition-all duration-200 ${
                        isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                      }`}
                      onClick={e => { e.preventDefault(); e.stopPropagation(); setShowRecawMenu(false); handleRecaw(e) }}
                    >
                      <Recaw className={`w-4 h-4 transition-all duration-300 ${
                        isDark ? 'text-white' : 'text-gray-600'
                      }`} /> Repost
                    </button>
                    <button
                      className={`flex items-center gap-2 px-3 py-1 cursor-pointer rounded transition-all duration-200 ${
                        isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                      }`}
                      onClick={e => { e.preventDefault(); e.stopPropagation(); setShowRecawMenu(false); openModal('quote', item) }}
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
                disabled={busyLike || likePending}
                title={likePending ? "Processing like..." : "Like"}
              >
                {(busyLike || likePending) ? (
                  // Spinner with checkmark for pending like
                  <div className="relative w-5 h-5 group">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-red-500 rounded-full animate-spin"></div>
                    <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-red-500" />
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs bg-black text-white rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
                      Submitted, pending validation
                    </div>
                  </div>
                ) : (
                  <HiOutlineHeart className={`w-5 h-5 ${item.hasLiked ? 'fill-current' : ''}`} />
                )}
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
                <span className="text-sm">{item.viewCount || 0}</span>
              </button>
            </div>
          </div>
        </div>

        {/* Wrong wallet error message */}
        {wrongWalletError && (
          <div className="mt-2 rounded-md overflow-hidden bg-black">
            <div className={`px-4 py-2 text-sm rounded-md transition-all duration-300 ${
              isDark
                ? 'bg-red-900/20 text-red-400 border border-red-800'
                : 'bg-red-50 text-red-600 border border-red-200'
            }`}>
              Please switch to the correct wallet
            </div>
          </div>
        )}
      </div>

      {/* Switch Chain Modal */}
      <SwitchChainModal
        isOpen={showSwitchChainModal}
        onClose={() => setShowSwitchChainModal(false)}
      />
    </Link>
  )
}

export default ReplyItem

