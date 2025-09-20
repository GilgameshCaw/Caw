// src/components/FeedItem.tsx - UPDATED FOR CONSISTENCY
import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSignAndSubmitAction } from '~/api/actions'
import { useAccount } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
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
  HiOutlineExclamation,
  HiOutlineCheck
} from 'react-icons/hi'
import Recaw from '~/assets/images/recaw.svg?react';
import Pencil from '~/assets/images/pencil.svg?react';
import Bookmark from '~/assets/images/bookmark.svg?react';
import Share from '~/assets/images/share.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useModalStore } from '~/store/modalStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { Link } from 'react-router-dom'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import ContentWithHashtags from './ContentWithHashtags'
import { formatEngagementCount } from '~/utils/numberFormat'

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

const FeedItem: React.FC<{ item: CawItem; isMainPost?: boolean; isReply?: boolean }> = ({ item, isMainPost = false, isReply = false }) => {
  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })
  const openModal        = useModalStore(s => s.openModal)
  const { isConnected, address } = useAccount()
  const { openConnectModal } = useConnectModal()
  const { isDark } = useTheme()
  const [busyLike, setBusyLike]     = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  const [isRecawed, setIsRecawed]   = useState(false)
  const [likePending, setLikePending] = useState(item.likePending || false)
  const [txSubmitted, setTxSubmitted] = useState(false) // Track if tx was submitted during this session only
  const [pendingLikeAction, setPendingLikeAction] = useState(false) // Track if we're waiting to like after connection
  const [wrongWalletError, setWrongWalletError] = useState(false) // Track if wrong wallet is connected
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionsMenuRef = useRef<HTMLDivElement>(null)

  // Determine which item to use (handle recaws)
  let useItem = item;
  let headline;
  if (item.content === "" && item.parent) {
    headline = 'Recawed by ' + item.user.username
    useItem = item.parent;
  }

  // Auto-trigger like after wallet connection
  useEffect(() => {
    if (pendingLikeAction && isConnected && activeTokenId && activeToken) {
      // Wait a bit for cawonce to load if needed
      const checkAndTriggerLike = async () => {
        let attempts = 0;
        while (attempts < 20 && activeToken.cawonce === undefined) {
          await new Promise(resolve => setTimeout(resolve, 100));
          attempts++;
        }

        if (activeToken.cawonce === undefined) {
          console.error('Token data not loaded after waiting');
          return;
        }

        // Immediately clear the pending action to prevent re-triggers
        setPendingLikeAction(false)

        // Check if connected to correct wallet
        if (activeToken.address.toLowerCase() === address?.toLowerCase()) {
        // Add optimistic like if liking
        let tempLikeId: string | undefined
        const addOptimisticLike = useOptimisticLikesStore.getState().addOptimisticLike
        const updateLikeWithTxQueueId = useOptimisticLikesStore.getState().updateLikeWithTxQueueId
        if (!useItem.hasLiked) {
          tempLikeId = addOptimisticLike({
            userId: activeTokenId,
            cawId: useItem.id
          })
        }

        // Directly call the sign and submit without recursion
        signAndSubmit({
          actionType: useItem.hasLiked ? 'unlike' : 'like',
          senderId: activeTokenId,
          receiverId: useItem.user.tokenId,
          receiverCawonce: useItem.cawonce ?? 0,
        }).then((response) => {
          // Update optimistic like with txQueue ID if we have both
          if (tempLikeId && response?.txQueueId) {
            updateLikeWithTxQueueId(tempLikeId, response.txQueueId)
          }
          setLikePending(true)
          setTxSubmitted(true)
        }).catch(err => {
          console.error('Like failed', err)
          setLikePending(false)
          setTxSubmitted(false)
        })
      } else {
        setWrongWalletError(true)
        setTimeout(() => setWrongWalletError(false), 5000) // Clear error after 5 seconds
      }
      }

      checkAndTriggerLike()
    }
    // Remove signAndSubmit from dependencies to prevent re-triggers
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected, activeTokenId, pendingLikeAction, address, activeToken, activeToken?.cawonce, useItem.hasLiked, useItem.user.tokenId, useItem.cawonce])

  // Clear wrong wallet error when address changes
  useEffect(() => {
    if (wrongWalletError && activeToken && activeToken.address.toLowerCase() === address?.toLowerCase()) {
      setWrongWalletError(false)
    }
  }, [address, activeToken, wrongWalletError])

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

  const handleLike = async (event: React.MouseEvent) => {
    event.preventDefault()

    // If wallet not connected, open connect modal and set pending action
    if (!isConnected) {
      setPendingLikeAction(true)
      if (openConnectModal) {
        openConnectModal()
      }
      return
    }

    // Check if connected to wrong wallet
    if (activeToken && address && activeToken.address.toLowerCase() !== address.toLowerCase()) {
      setWrongWalletError(true)
      setTimeout(() => setWrongWalletError(false), 5000) // Clear error after 5 seconds
      return
    }

    // If no active token selected, return
    if (!activeTokenId || busyLike || likePending) return

    setBusyLike(true)
    setTxSubmitted(false) // Reset txSubmitted at start of new like action

    // Add optimistic like if liking
    let tempLikeId: string | undefined
    const addOptimisticLike = useOptimisticLikesStore.getState().addOptimisticLike
    const updateLikeWithTxQueueId = useOptimisticLikesStore.getState().updateLikeWithTxQueueId
    if (!useItem.hasLiked) {
      tempLikeId = addOptimisticLike({
        userId: activeTokenId,
        cawId: useItem.id
      })
    }

    try {
      const response = await signAndSubmit({
        actionType:      useItem.hasLiked ? 'unlike' : 'like',
        senderId:        activeTokenId,
        receiverId:      useItem.user.tokenId,
        receiverCawonce: useItem.cawonce ?? 0,
      })

      // Update optimistic like with txQueue ID if we have both
      if (tempLikeId && response?.txQueueId) {
        updateLikeWithTxQueueId(tempLikeId, response.txQueueId)
      }

      // Transaction was successfully submitted to the server
      setLikePending(true)
      setTxSubmitted(true)
    } catch (err) {
      console.error('Like failed', err)
      // Reset states on error
      setLikePending(false)
      setTxSubmitted(false)
    } finally {
      setBusyLike(false)
    }
  }

  const handleRecaw = async (event: React.MouseEvent) => {
    event.preventDefault()

    // If wallet not connected, open connect modal
    if (!isConnected) {
      if (openConnectModal) {
        openConnectModal()
      }
      return
    }

    // If no active token selected, return
    if (!activeTokenId || busyRecaw) return

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
                    · {formatTimeAgo(useItem.timestamp)}
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
          <ContentWithHashtags
            content={useItem.content}
            className={`mb-4 transition-colors duration-300 pl-2 md:pl-0 ${
              isDark ? 'text-gray-200' : 'text-gray-800'
            }`}
          />

          {/* Video Display */}
          {useItem.hasVideo && (
            <div className="mb-4 pl-2 md:pl-0">
              {(() => {
                // Check if videoData contains URLs
                if (useItem.videoData) {
                  // Videos stored as URLs (always off-chain)
                  const videoUrls = useItem.videoData.split('|||')
                  return (
                    <div className={`grid grid-cols-1 gap-2 max-w-2xl`}>
                      {videoUrls.map((url, index) => (
                        <div key={index} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-black">
                          <video
                            controls
                            className="w-full h-auto max-h-96"
                            preload="metadata"
                            onClick={(e) => {
                              e.stopPropagation()
                            }}
                            onError={(e) => {
                              console.error('Failed to load video from URL:', url)
                              e.currentTarget.style.display = 'none'
                            }}
                          >
                            <source src={url} type="video/mp4" />
                            <source src={url} type="video/webm" />
                            Your browser does not support the video tag.
                          </video>
                        </div>
                      ))}
                    </div>
                  )
                }
                return null
              })()}
            </div>
          )}

          {/* Image Display */}
          {useItem.hasImage && (
            <div className="mb-4 pl-2 md:pl-0">
              {(() => {
                // Check if imageData contains URLs or base64 data
                if (useItem.imageData) {
                  if (useItem.imageData.startsWith('urls:')) {
                    // Off-chain images stored as URLs
                    const urls = useItem.imageData.replace('urls:', '').split('|||')
                    return (
                      <div className={`grid ${urls.length > 1 ? 'grid-cols-2 gap-2' : 'grid-cols-1'} max-w-2xl`}>
                        {urls.map((url, index) => (
                          <div key={index} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                            <img
                              src={url}
                              alt={`Caw image ${index + 1}`}
                              className="w-full h-auto cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                // TODO: Open image in modal
                              }}
                              onError={(e) => {
                                console.error('Failed to load image from URL:', url)
                                e.currentTarget.style.display = 'none'
                              }}
                            />
                          </div>
                        ))}
                      </div>
                    )
                  } else {
                    // On-chain images stored as base64
                    const images = useItem.imageData.split('|||')
                    return (
                      <div className={`grid ${images.length > 1 ? 'grid-cols-2 gap-2' : 'grid-cols-1'} max-w-2xl`}>
                        {images.map((imageBase64, index) => (
                          <div key={index} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                            <img
                              src={`data:image/jpeg;base64,${imageBase64}`}
                              alt={`Caw image ${index + 1}`}
                              className="w-full h-auto cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={(e) => {
                                e.preventDefault()
                                e.stopPropagation()
                                // TODO: Open image in modal
                              }}
                              onError={(e) => {
                                console.error('Failed to load on-chain image')
                                e.currentTarget.style.display = 'none'
                              }}
                            />
                            <div className="absolute top-2 right-2 px-2 py-1 bg-black/70 text-white text-xs rounded-full">
                              On-chain
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  }
                } else if (useItem.imageUrl) {
                  // Legacy single image URL
                  return (
                    <div className="relative max-w-md rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                      <img
                        src={useItem.imageUrl}
                        alt="Caw image"
                        className="w-full h-auto cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          // TODO: Open image in modal
                        }}
                        onError={(e) => {
                          console.error('Failed to load image')
                          e.currentTarget.style.display = 'none'
                        }}
                      />
                    </div>
                  )
                }
                return null
              })()}
            </div>
          )}

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
                <span className="text-sm">{formatEngagementCount(useItem.commentCount)}</span>
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
                  }`}>{formatEngagementCount(useItem.recawCount)}</span>
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
                disabled={busyLike || likePending}
                title={likePending ? "Processing like..." : "Like"}
              >
                {(busyLike && !txSubmitted) ? (
                  // Just spinner while signing/submitting transaction
                  <div className="w-5 h-5 border-2 border-gray-400 border-t-red-500 rounded-full animate-spin"></div>
                ) : (likePending || item.likePending) ? (
                  // Spinner with checkmark after transaction is submitted (or if pending from DB)
                  <div className="relative w-5 h-5">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-red-500 rounded-full animate-spin"></div>
                    <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-red-500" />
                  </div>
                ) : (
                  <HiOutlineHeart className={`w-5 h-5 ${useItem.hasLiked ? 'fill-current' : ''}`} />
                )}
                <span className="text-sm">{formatEngagementCount(useItem.likeCount)}</span>
              </button>

              {/* Views */}
              <button
                className={`flex items-center space-x-2 transition-colors duration-300 cursor-pointer ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                title="Views"
              >
                <HiOutlineEye className="w-5 h-5" />
                <span className="text-sm">{formatEngagementCount(useItem.viewCount || 0)}</span>
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

          {/* Wrong wallet error message */}
          {wrongWalletError && (
            <div className={`mt-2 px-4 py-2 text-sm rounded-md transition-all duration-300 ${
              isDark
                ? 'bg-red-900/20 text-red-400 border border-red-800'
                : 'bg-red-50 text-red-600 border border-red-200'
            }`}>
              Please switch to the wallet that owns this profile
            </div>
          )}
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
                `${optionsMenuRef.current.getBoundingClientRect().bottom + 8}px` : '20px',
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
