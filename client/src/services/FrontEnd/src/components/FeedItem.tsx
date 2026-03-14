// src/components/FeedItem.tsx - UPDATED FOR CONSISTENCY
import React, { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { useSignAndSubmitAction } from '~/api/actions'
import { useAccount, useChainId } from 'wagmi'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import {
  HiOutlineHeart,
  HiOutlineEye,
  HiOutlineChat,
  HiOutlineDotsHorizontal,
  HiOutlineTranslate,
  HiOutlineClipboard,
  HiOutlineVolumeOff,
  HiOutlineFilter,
  HiOutlineEyeOff,
  HiOutlineUserRemove,
  HiOutlineExclamation,
  HiOutlineCheck,
  HiOutlineRefresh
} from 'react-icons/hi'
import Recaw from '~/assets/images/recaw.svg?react';
import Pencil from '~/assets/images/pencil.svg?react';
import Bookmark from '~/assets/images/bookmark.svg?react';
import Share from '~/assets/images/share.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { ShareModal } from './ShareModal'
import { useModalStore } from '~/store/modalStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { useBookmarksStore } from '~/store/bookmarksStore'
import { Link, useNavigate } from 'react-router-dom'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { usePendingPolling, usePendingCawPolling, usePendingLikePolling, usePendingRecawPolling, usePendingReplyPolling } from '~/hooks/usePendingPolling'
import ContentWithHashtags from './ContentWithHashtags'
import { formatEngagementCount } from '~/utils/numberFormat'
import { apiFetch } from '~/api/client'
import MuteWordsModal from './modals/MuteWordsModal'
import MuteConfirmModal, { shouldShowMuteConfirmModal } from './modals/MuteConfirmModal'
import ReportPostModal, { ReportReason } from './modals/ReportPostModal'
import SwitchChainModal from './modals/SwitchChainModal'
import TipModal from './modals/TipModal'
import { HiOutlineCurrencyDollar } from 'react-icons/hi'
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

const FeedItem: React.FC<{ item: CawItem; isMainPost?: boolean; isReply?: boolean; onBookmarkUpdate?: (cawId: number, isBookmarked: boolean) => void; onLikeStateChange?: (cawId: string, likePending: boolean) => void; onRecawStateChange?: (cawId: string, recawPending: boolean) => void; onReplyStateChange?: (cawId: string, replyPending: boolean) => void }> = ({ item, isMainPost = false, isReply = false, onBookmarkUpdate, onLikeStateChange, onRecawStateChange, onReplyStateChange }) => {
  // Local pending states (declared early so polling can use them)
  const [likePending, setLikePending] = useState(item.likePending || false)
  const [recawPending, setRecawPending] = useState(item.recawPending || false)
  const [replyPending, setReplyPending] = useState(item.replyPending || false)

  // Enable polling for pending items - use local state so it works with auto-trigger
  usePendingCawPolling(parseInt(item.id), item.status === 'PENDING')
  usePendingLikePolling(parseInt(item.id), likePending)
  usePendingRecawPolling(parseInt(item.id), recawPending)
  usePendingReplyPolling(parseInt(item.id), replyPending)

  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })
  const openModal        = useModalStore(s => s.openModal)
  const { isConnected, address } = useAccount()
  const chainId = useChainId()
  const { openConnectModal } = useConnectModal()
  const { isDark } = useTheme()
  const [showSwitchChainModal, setShowSwitchChainModal] = useState(false)
  const navigate = useNavigate()
  const [busyLike, setBusyLike]     = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  const [txSubmitted, setTxSubmitted] = useState(false) // Track if tx was submitted during this session only
  const [pendingLikeAction, setPendingLikeAction] = useState<{ receiverId: number, receiverCawonce: number, actionType: 'like' | 'unlike' } | null>(null) // Track pending like data
  const [wrongWalletError, setWrongWalletError] = useState(false) // Track if wrong wallet is connected
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [showTipModal, setShowTipModal] = useState(false)
  const [tipPending, setTipPending] = useState(false)
  const [textCopied, setTextCopied] = useState(false)
  // Bookmarks are browser-only (localStorage)
  const bookmarksStore = useBookmarksStore()
  const isBookmarked = bookmarksStore.isBookmarked(item.id)
  const [translatedText, setTranslatedText] = useState<string | null>(null)
  const [isTranslating, setIsTranslating] = useState(false)
  const [isRetrying, setIsRetrying] = useState(false)
  const [showMuteWordsModal, setShowMuteWordsModal] = useState(false)
  const [showMuteConfirmModal, setShowMuteConfirmModal] = useState(false)
  const [muteConfirmAction, setMuteConfirmAction] = useState<'hide-post' | 'mute-thread' | 'mute-account' | 'block-account' | 'mute-words'>('hide-post')
  const [showReportModal, setShowReportModal] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionsMenuRef = useRef<HTMLDivElement>(null)
  const isSubmittingLikeRef = useRef(false) // Prevent duplicate like submissions

  // Determine which item to use (handle recaws)
  let useItem = item;
  let headline;
  let isRecaw = false;
  let isRecawByCurrentUser = false;
  if (item.content === "" && item.parent) {
    // Check if the recaw is by the current user
    const userId = item.user.id;
    const currentUserId = activeTokenId || activeToken?.tokenId;
    const isCurrentUser = currentUserId && (userId == currentUserId);

    headline = isCurrentUser
      ? 'Recawed by you'
      : 'Recawed by ' + (item.user.displayName || item.user.username);
    useItem = item.parent;
    isRecaw = true;
    isRecawByCurrentUser = !!isCurrentUser;
  }

  // Auto-trigger like after wallet connection
  useEffect(() => {
    // Skip if no pending action, not connected, or already submitting
    if (!pendingLikeAction || !isConnected || !activeTokenId || !activeToken || isSubmittingLikeRef.current) return;

    // Check if connected to correct wallet
    if (activeToken.address.toLowerCase() !== address?.toLowerCase()) {
      setPendingLikeAction(null); // Clear pending action
      setWrongWalletError(true);
      setTimeout(() => setWrongWalletError(false), 5000);
      return;
    }

    // Prevent duplicate submissions
    isSubmittingLikeRef.current = true;

    // Clear pending action FIRST to prevent re-triggers
    const actionData = pendingLikeAction;
    setPendingLikeAction(null);

    // Add optimistic like if liking
    let tempLikeId: string | undefined;
    const addOptimisticLike = useOptimisticLikesStore.getState().addOptimisticLike;
    const updateLikeWithTxQueueId = useOptimisticLikesStore.getState().updateLikeWithTxQueueId;

    if (actionData.actionType === 'like') {
      tempLikeId = addOptimisticLike({
        userId: activeTokenId,
        cawId: useItem.id
      });
    }

    setBusyLike(true);

    // Submit the action
    signAndSubmit({
      actionType: actionData.actionType,
      senderId: activeTokenId,
      receiverId: actionData.receiverId,
      receiverCawonce: actionData.receiverCawonce,
    }).then((response) => {
      // Update optimistic like with txQueue ID if we have both
      if (tempLikeId && response?.txQueueId) {
        updateLikeWithTxQueueId(tempLikeId, response.txQueueId);
      }
      setLikePending(true);
      setTxSubmitted(true);
      // Notify parent component about like state change
      if (onLikeStateChange) {
        onLikeStateChange(useItem.id, true);
      }
    }).catch(err => {
      console.error('Like failed', err);
      setLikePending(false);
      setTxSubmitted(false);
    }).finally(() => {
      setBusyLike(false);
      isSubmittingLikeRef.current = false;
    });
  }, [pendingLikeAction, isConnected, activeTokenId, activeToken, address, signAndSubmit, useItem.id])

  // Sync local likePending state with item.likePending from polling
  useEffect(() => {
    setLikePending(item.likePending || false)
  }, [item.likePending])

  // Sync local recawPending state with item.recawPending from polling
  useEffect(() => {
    setRecawPending(item.recawPending || false)
  }, [item.recawPending])

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
    // MUST call these first, before any early returns!
    event.preventDefault()
    event.stopPropagation()

    // Don't allow interactions with pending or failed caws
    if (item.status === 'PENDING' || item.status === 'FAILED') {
      return
    }

    // If wallet not connected, open connect modal and set pending action
    if (!isConnected) {
      // Reset submitting ref for new action
      isSubmittingLikeRef.current = false;
      setPendingLikeAction({
        receiverId: useItem.user.id,
        receiverCawonce: useItem.cawonce ?? 0,
        actionType: useItem.hasLiked ? 'unlike' : 'like'
      });
      if (openConnectModal) {
        openConnectModal();
      }
      return;
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

    // If no active token selected, return
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId || busyLike || likePending) {
      return
    }

    setBusyLike(true)
    setTxSubmitted(false) // Reset txSubmitted at start of new like action

    // Add optimistic like if liking
    let tempLikeId: string | undefined
    const addOptimisticLike = useOptimisticLikesStore.getState().addOptimisticLike
    const updateLikeWithTxQueueId = useOptimisticLikesStore.getState().updateLikeWithTxQueueId
    if (!useItem.hasLiked) {
      tempLikeId = addOptimisticLike({
        userId: effectiveTokenId,
        cawId: useItem.id
      })
    }

    try {
      const response = await signAndSubmit({
        actionType:      useItem.hasLiked ? 'unlike' : 'like',
        senderId:        effectiveTokenId,
        receiverId:      useItem.user.id,
        receiverCawonce: useItem.cawonce ?? 0,
      })

      // signAndSubmit returns null if insufficient stake (modal shown automatically)
      if (!response) {
        // Remove optimistic like if we added one
        if (tempLikeId) {
          useOptimisticLikesStore.getState().removeOptimisticLike(tempLikeId)
        }
        return
      }

      // Update optimistic like with txQueue ID if we have both
      if (tempLikeId && response?.txQueueId) {
        updateLikeWithTxQueueId(tempLikeId, response.txQueueId)
      }

      // Transaction was successfully submitted to the server
      setLikePending(true)
      setTxSubmitted(true)

      // Notify parent component about like state change
      if (onLikeStateChange) {
        onLikeStateChange(useItem.id, true)
      }
    } catch (err) {
      console.error('Like failed', err)
      // Reset states on error
      setLikePending(false)
      setTxSubmitted(false)
    } finally {
      setBusyLike(false)
    }
  }

  const handleRetry = async (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    if (!activeTokenId || !activeToken || isRetrying) return

    setIsRetrying(true)

    try {
      // Resubmit the caw action
      await signAndSubmit({
        actionType: 'caw',
        senderId: activeTokenId,
        text: useItem.content,
        amounts: [] // You might need to calculate proper amounts for images
      })

      // Optionally update local state to show pending status
      // This would require updating the item's status in the parent component
    } catch (error) {
      console.error('Retry failed:', error)
    } finally {
      setIsRetrying(false)
    }
  }

  const handleRecaw = async (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation() // Prevent navigation to caw page

    // Don't allow interactions with pending or failed caws
    if (item.status === 'PENDING' || item.status === 'FAILED') {
      return
    }

    // If wallet not connected, open connect modal
    if (!isConnected) {
      if (openConnectModal) {
        openConnectModal()
      }
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

    // If no active token selected, return
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId || busyRecaw) {
      return
    }

    setBusyRecaw(true)
    try {
      const result = await signAndSubmit({
        actionType:      'recaw',
        senderId:        effectiveTokenId,
        receiverId:      Number(useItem.user.id ?? 0),
        receiverCawonce: useItem.cawonce ?? 0,
      })

      // signAndSubmit returns null if insufficient stake (modal shown automatically)
      if (!result) return

      // Set pending state - will be cleared when the recaw caw is confirmed
      setRecawPending(true)

      // Notify parent component about recaw state change
      if (onRecawStateChange) {
        onRecawStateChange(useItem.id, true)
      }
    } catch (err) {
      console.error('Recaw failed', err)
      setRecawPending(false)
    } finally {
      setBusyRecaw(false)
    }
  }

  const handleReply = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation() // Prevent navigation to caw page

    // Don't allow interactions with pending or failed caws
    if (item.status === 'PENDING' || item.status === 'FAILED') {
      return
    }

    // Open modal with onSuccess callback to set pending state
    openModal('comment', item, () => {
      setReplyPending(true)
      if (onReplyStateChange) {
        onReplyStateChange(useItem.id, true)
      }
    })
  }

  const handleBookmark = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    // Bookmarks are browser-only (localStorage) - no auth required
    const cawId = useItem.id
    const newState = bookmarksStore.toggleBookmark(cawId)

    if (onBookmarkUpdate) {
      onBookmarkUpdate(parseInt(cawId), newState)
    }
  }

  const handleOptionsClick = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    setShowOptionsMenu(!showOptionsMenu)
  }

  const handleMenuAction = async (action: string) => {
    setShowOptionsMenu(false)
    // Handle different menu actions
    switch (action) {
      case 'translate':
        if (isTranslating || translatedText) {
          // Reset translation if already translated
          setTranslatedText(null)
          return
        }

        setIsTranslating(true)
        try {
          const userLang = navigator.language || 'en'
          const targetLang = userLang.split('-')[0] // Get language code without region

          // Use Google Translate API (free tier)
          const response = await fetch(
            `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${targetLang}&dt=t&q=${encodeURIComponent(useItem.content)}`
          )
          const data = await response.json()
          const translated = data[0]?.[0]?.[0]

          if (translated && translated !== useItem.content) {
            setTranslatedText(translated)
          } else {
            // If translation is the same, try translating to English
            const enResponse = await fetch(
              `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=en&dt=t&q=${encodeURIComponent(useItem.content)}`
            )
            const enData = await enResponse.json()
            const enTranslated = enData[0]?.[0]?.[0]
            if (enTranslated) {
              setTranslatedText(enTranslated)
            }
          }
        } catch (error) {
          console.error('Translation failed:', error)
        } finally {
          setIsTranslating(false)
        }
        break
      case 'copy':
        navigator.clipboard.writeText(useItem.content || '')
        setTextCopied(true)
        setTimeout(() => setTextCopied(false), 2000)
        break
      case 'mute-thread':
        if (shouldShowMuteConfirmModal()) {
          setMuteConfirmAction('mute-thread')
          setShowMuteConfirmModal(true)
        } else {
          // Call API to mute thread (server-side for notifications)
          const effectiveTokenId = activeTokenId || activeToken?.tokenId
          if (effectiveTokenId) {
            apiFetch(`/api/notifications/mute-thread/${useItem.id}`, {
              method: 'POST',
              headers: { 'x-user-id': effectiveTokenId.toString() }
            }).catch(err => console.error('Failed to mute thread:', err))
          }
        }
        break
      case 'mute-words':
        // Open modal for word selection
        setShowMuteWordsModal(true)
        break
      case 'hide-post':
        // Show modal first if needed, then hide on close
        // Use useItem.id (the original post) - for recaws this hides the original, which also hides all recaws
        if (shouldShowMuteConfirmModal()) {
          setMuteConfirmAction('hide-post')
          setShowMuteConfirmModal(true)
          // Don't save yet - will save when modal closes
        } else {
          // No modal needed, save immediately
          const hiddenPosts = JSON.parse(localStorage.getItem('hiddenPosts') || '[]')
          hiddenPosts.push(useItem.id)
          localStorage.setItem('hiddenPosts', JSON.stringify([...new Set(hiddenPosts)]))
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
        }
        break
      case 'mute-account': {
        const effectiveTokenId = activeTokenId || activeToken?.tokenId
        if (shouldShowMuteConfirmModal()) {
          setMuteConfirmAction('mute-account')
          setShowMuteConfirmModal(true)
        } else {
          const mutedAccounts = JSON.parse(localStorage.getItem('mutedAccounts') || '[]')
          mutedAccounts.push(useItem.user.id)
          localStorage.setItem('mutedAccounts', JSON.stringify([...new Set(mutedAccounts)]))
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
          // Sync to server for notification filtering
          if (effectiveTokenId) {
            apiFetch(`/api/notifications/mute-account/${useItem.user.id}`, {
              method: 'POST',
              headers: { 'x-user-id': effectiveTokenId.toString() }
            }).catch(err => console.error('Failed to sync mute to server:', err))
          }
        }
        break
      }
      case 'block-account': {
        if (shouldShowMuteConfirmModal()) {
          setMuteConfirmAction('block-account')
          setShowMuteConfirmModal(true)
        } else {
          // Blocking is browser-only (localStorage)
          const blockedAccounts = JSON.parse(localStorage.getItem('blockedAccounts') || '[]')
          blockedAccounts.push(useItem.user.id)
          localStorage.setItem('blockedAccounts', JSON.stringify([...new Set(blockedAccounts)]))
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
        }
        break
      }
      case 'report':
        setShowReportModal(true)
        break
      default:
        break
    }
  }

  const handleCardClick = (e: React.MouseEvent) => {
    // Don't navigate if clicking on interactive elements (they handle their own navigation)
    const target = e.target as HTMLElement
    if (target.closest('a') || target.closest('button')) {
      return
    }
    // Don't navigate for pending or failed posts (they have tempIds, not real IDs)
    if (item.status === 'PENDING' || item.status === 'FAILED') {
      return
    }
    const url = `/caws/${useItem.id}`
    // Open in new tab if command+click (Mac) or ctrl+click (Windows/Linux)
    if (e.metaKey || e.ctrlKey) {
      window.open(url, '_blank')
    } else {
      navigate(url)
    }
  }

  return (
    <>
      <div onClick={handleCardClick} className="block">
        <div className={`p-4 transition-all duration-300 hover:bg-gray-500/5 cursor-pointer border-b ${
          isDark ? 'border-gray-800' : 'border-gray-200'
        } ${
          (item.status === 'PENDING' || item.status === 'FAILED') ? 'opacity-60' : ''
        }`}>
          {/* Replying to header - left aligned, no extra padding (only for replies, not recaws) */}
          {item.parent && !isRecaw && item.parent.user && (
            <Link to={`/caws/${item.parent.id}`} className={`block text-xs transition-all duration-300 mb-3 truncate md:truncate-none ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              Replying to <span className="underline">@{item.parent.user.username}</span>
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

          {/* Content wrapper with left padding for replies - applies when isReply OR when it has a parent (reply in main feed), but NOT for recaws */}
          <div className={`relative ${(isReply || (item.parent && !isRecaw)) ? 'pl-6' : ''}`}>
            {/* Vertical line for replies */}
            {(isReply || (item.parent && !isRecaw)) && (
              <div
                className="absolute w-px bg-white/20"
                style={{
                  left: '7px',
                  top: '0',
                  height: '100%'
                }}
              ></div>
            )}

          {/* Post Header */}
          <div className={`flex justify-between mb-3 ${isReply ? 'items-start' : 'items-center'}`}>
            <div className="flex items-center space-x-3">
              {/* Avatar */}
              <Link
                to={`/users/${useItem.user.username}`}
                className="w-10 h-10 rounded-full cursor-pointer overflow-hidden"
              >
                <img
                  src={useItem.user.avatarUrl || useItem.user.image || "/images/logo.jpeg"}
                  alt={`${useItem.user.username} avatar`}
                  className="w-full h-full object-cover rounded-full hover:opacity-80 transition-opacity duration-200"
                />
              </Link>
              
              {/* User info */}
              <div className="flex-1">
                <div>
                  {/* First line: Display name and status badges */}
                  <div className="flex items-center space-x-2 mb-0.5">
                    <Link
                      to={`/users/${useItem.user.username}`}
                      className={`font-semibold transition-colors duration-300 cursor-pointer hover:underline ${
                        isDark ? 'text-white' : 'text-black'
                      }`}
                    >
                      {useItem.user.displayName || useItem.user.username}
                    </Link>
                    {item.status === 'PENDING' && (
                      <span className="px-2 py-0.5 text-xs bg-yellow-500/20 text-yellow-600 dark:text-yellow-400 rounded-full">
                        Pending
                      </span>
                    )}
                    {item.status === 'FAILED' && (
                      <>
                        <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-600 dark:text-red-400 rounded-full">
                          Failed
                        </span>
                      <button
                        onClick={handleRetry}
                        disabled={isRetrying}
                        className="ml-2 px-2 py-0.5 text-xs bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded-full hover:bg-blue-500/30 transition-colors flex items-center gap-1"
                      >
                        <HiOutlineRefresh className={`w-3 h-3 ${isRetrying ? 'animate-spin' : ''}`} />
                        {isRetrying ? 'Retrying...' : 'Retry'}
                      </button>
                    </>
                  )}
                  </div>

                  {/* Second line: Username and time */}
                  <div className="flex items-center space-x-2">
                    <span className={`text-sm transition-colors duration-300 ${
                      isDark ? 'text-gray-400' : 'text-gray-600'
                    }`}>
                      @{useItem.user.username}
                    </span>
                    <span className={`text-sm transition-colors duration-300 ${
                      isDark ? 'text-gray-500' : 'text-gray-500'
                    }`}>
                      · {formatTimeAgo(useItem.timestamp)}
                    </span>
                  </div>
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
          {isTranslating ? (
            <div className={`mb-4 pl-2 md:pl-0 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin"></div>
                <span className="text-sm">Translating...</span>
              </div>
            </div>
          ) : translatedText ? (
            <div className="mb-4 pl-2 md:pl-0">
              <ContentWithHashtags
                content={translatedText}
                className={`transition-colors duration-300 ${
                  isDark ? 'text-gray-200' : 'text-gray-800'
                }`}
              />
              <div className={`mt-2 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                <HiOutlineTranslate className="inline-block w-4 h-4 mr-1" />
                Translated from original •{' '}
                <button
                  onClick={() => setTranslatedText(null)}
                  className="underline hover:no-underline"
                >
                  Show original
                </button>
              </div>
            </div>
          ) : (
            <ContentWithHashtags
              content={useItem.content}
              className={`mb-4 transition-colors duration-300 pl-2 md:pl-0 ${
                isDark ? 'text-gray-200' : 'text-gray-800'
              }`}
            />
          )}

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
                      <div className={`${urls.length > 1 ? 'grid grid-cols-2 gap-2 max-w-2xl' : 'inline-block'}`}>
                        {urls.map((url, index) => (
                          <div key={index} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 inline-block">
                            <img
                              src={url}
                              alt={`Caw image ${index + 1}`}
                              className="max-w-full max-h-96 h-auto cursor-pointer hover:opacity-90 transition-opacity"
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
                      <div className={`${images.length > 1 ? 'grid grid-cols-2 gap-2 max-w-2xl' : 'inline-block'}`}>
                        {images.map((imageBase64, index) => (
                          <div key={index} className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 inline-block">
                            <img
                              src={`data:image/jpeg;base64,${imageBase64}`}
                              alt={`Caw image ${index + 1}`}
                              className="max-w-full max-h-96 h-auto cursor-pointer hover:opacity-90 transition-opacity"
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
                    <div className="relative inline-block rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                      <img
                        src={useItem.imageUrl}
                        alt="Caw image"
                        className="max-w-full max-h-96 h-auto cursor-pointer hover:opacity-90 transition-opacity"
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
          <div className="flex items-center justify-between" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center space-x-6">
              {/* Comments/Replies */}
              <button
                className={`flex items-center space-x-2 transition-colors duration-300 ${
                  (item.status === 'PENDING' || item.status === 'FAILED')
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:text-blue-500 cursor-pointer'
                } ${
                  (useItem.hasReplied || replyPending)
                    ? 'text-blue-500'
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleReply}
                disabled={item.status === 'PENDING' || item.status === 'FAILED'}
                title={
                  replyPending ? "Processing reply..." :
                  item.status === 'PENDING' ? "Cannot reply to pending caw" :
                  item.status === 'FAILED' ? "Cannot reply to failed caw" :
                  "Reply"
                }
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
                <span className={`text-sm ${(useItem.hasReplied || replyPending) ? 'text-blue-500' : ''}`}>
                  {formatEngagementCount(useItem.commentCount)}
                </span>
              </button>

              {/* Retweets */}
              <div className="relative">
                <button
                  className={`group flex items-center space-x-2 transition-colors duration-300 ${
                    (item.status === 'PENDING' || item.status === 'FAILED' || recawPending)
                      ? 'cursor-not-allowed opacity-50'
                      : 'hover:text-green-500 cursor-pointer'
                  } ${
                    (useItem.hasRecawed || isRecawByCurrentUser)
                      ? 'text-green-500'
                      : isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (item.status !== 'PENDING' && item.status !== 'FAILED' && !recawPending) {
                      setShowRecawMenu(show => !show)
                    }
                  }}
                  disabled={item.status === 'PENDING' || item.status === 'FAILED' || recawPending}
                  title={
                    recawPending ? "Processing repost..." :
                    item.status === 'PENDING' ? "Cannot recaw pending caw" :
                    item.status === 'FAILED' ? "Cannot recaw failed caw" :
                    "ReCaw"
                  }
                >
                  {(busyRecaw || recawPending) ? (
                    <div className="relative w-5 h-5 group">
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-green-500 rounded-full animate-spin"></div>
                      <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-green-500" />
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs bg-black text-white rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
                        Submitted, pending validation
                      </div>
                    </div>
                  ) : (
                    <Recaw className={`w-5 h-5 transition-all duration-300 ${
                      (useItem.hasRecawed || isRecawByCurrentUser) ? 'text-green-500' : ''
                    }`} />
                  )}
                  <span className={`text-sm transition-colors duration-300 ${
                    (useItem.hasRecawed || isRecawByCurrentUser) ? 'text-green-500' : ''
                  }`}>{formatEngagementCount(useItem.recawCount)}</span>
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
                className={`flex items-center space-x-2 transition-colors duration-300 ${
                  (item.status === 'PENDING' || item.status === 'FAILED')
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:text-red-500 cursor-pointer'
                } ${
                  useItem.hasLiked
                    ? 'text-red-500'
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleLike}
                disabled={busyLike || likePending || item.status === 'PENDING' || item.status === 'FAILED'}
                title={item.status === 'PENDING' ? "Cannot like pending caw" : item.status === 'FAILED' ? "Cannot like failed caw" : likePending ? "Processing like..." : "Like"}
              >
                {(busyLike && !txSubmitted) ? (
                  // Just spinner while signing/submitting transaction
                  <div className="w-5 h-5 border-2 border-gray-400 border-t-red-500 rounded-full animate-spin"></div>
                ) : (likePending || item.likePending) ? (
                  // Spinner with checkmark after transaction is submitted (or if pending from DB)
                  <div className="relative w-5 h-5 group">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-red-500 rounded-full animate-spin"></div>
                    <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-red-500" />
                    {/* Tooltip */}
                    <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs bg-black text-white rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
                      Submitted, pending validation
                    </div>
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
              {/* Bookmark (browser-only, stored in localStorage) */}
              <button
                onClick={handleBookmark}
                className={`transition-colors duration-300 hover:text-yellow-500 cursor-pointer ${
                  isBookmarked
                    ? 'text-yellow-500'
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                title={isBookmarked ? "Remove bookmark" : "Save"}
              >
                <Bookmark className={`w-5 h-5 transition-all duration-300 ${
                  isBookmarked
                    ? 'fill-yellow-500 stroke-yellow-500'
                    : isDark ? 'stroke-white stroke-[1.5]' : 'stroke-gray-600'
                }`} />
              </button>

              {/* Tip */}
              {activeTokenId && activeTokenId !== useItem.user.id && item.status !== 'PENDING' && item.status !== 'FAILED' && (
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    setShowTipModal(true)
                  }}
                  className={`transition-colors duration-300 hover:text-yellow-500 cursor-pointer ${
                    (tipPending || useItem.hasTipped)
                      ? 'text-yellow-500'
                      : isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}
                  title="Tip"
                >
                  {tipPending ? (
                    <div className="relative w-5 h-5 group">
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-yellow-500 rounded-full animate-spin"></div>
                      <svg className="absolute inset-0 w-3 h-3 m-auto text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 text-xs bg-black text-white rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 pointer-events-none whitespace-nowrap">
                        Submitted, pending validation
                      </div>
                    </div>
                  ) : (
                    <HiOutlineCurrencyDollar className={`w-5 h-5 ${useItem.hasTipped ? 'fill-current' : ''}`} />
                  )}
                </button>
              )}

              {/* Share */}
              <button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setShowShareModal(true)
                }}
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
          {/* End content wrapper */}
        </div>
      </div>

      {/* Modal profesional con Portal y positioning calculado */}
      {showOptionsMenu && createPortal(
        <>
          {/* Overlay */}
          <div
            className="fixed inset-0 bg-black/50 z-[40]"
            onClick={() => setShowOptionsMenu(false)}
          />
          
          {/* Menu */}
          <div
            onMouseDown={(e) => e.stopPropagation()}
            className={`fixed z-[50] w-64 rounded-lg shadow-xl border transition-all duration-300 pointer-events-auto ${
              isDark
                ? 'bg-black border-white/20 text-white'
                : 'bg-white border-gray-200 text-black'
            }`}
            style={(() => {
              if (!optionsMenuRef.current) {
                return { top: '20px', right: '16px' }
              }
              const rect = optionsMenuRef.current.getBoundingClientRect()
              const menuHeight = 500 // Approximate menu height
              const viewportHeight = window.innerHeight
              const spaceBelow = viewportHeight - rect.bottom - 8
              const spaceAbove = rect.top - 8

              // If not enough space below, position above the button
              if (spaceBelow < menuHeight && spaceAbove > spaceBelow) {
                return {
                  bottom: `${viewportHeight - rect.top + 8}px`,
                  right: `${window.innerWidth - rect.right}px`,
                  maxHeight: `${Math.min(menuHeight, spaceAbove)}px`,
                  overflowY: 'auto' as const
                }
              }

              // Default: position below with max height if needed
              return {
                top: `${rect.bottom + 8}px`,
                right: `${window.innerWidth - rect.right}px`,
                maxHeight: `${Math.min(menuHeight, spaceBelow)}px`,
                overflowY: 'auto' as const
              }
            })()}
          >
            <div className="py-2">
              <button
                onMouseDown={(e) => {
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
                onMouseDown={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleMenuAction('copy')
                }}
                className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                  isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
                }`}
              >
                {textCopied ? (
                  <>
                    <HiOutlineCheck className="w-5 h-5 text-green-500" />
                    <span className="text-green-500">Copied!</span>
                  </>
                ) : (
                  <>
                    <HiOutlineClipboard className="w-5 h-5" />
                    Copy post text
                  </>
                )}
              </button>

              <div className={`border-t my-1 ${
                isDark ? 'border-white/20' : 'border-gray-200'
              }`}></div>

              <button
                onMouseDown={(e) => {
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
                onMouseDown={(e) => {
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
                onMouseDown={(e) => {
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
                onMouseDown={(e) => {
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
                onMouseDown={(e) => {
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
                onMouseDown={(e) => {
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

      {/* Share Modal */}
      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        url={`/caws/${useItem.id}`}
        title={`${useItem.user?.displayName || '@' + useItem.user?.username}'s caw`}
        text={useItem.content}
      />

      {/* Tip Modal */}
      {showTipModal && (
        <TipModal
          recipientTokenId={useItem.user.id}
          recipientUsername={useItem.user.username}
          cawUserId={useItem.user.id}
          cawCawonce={useItem.cawonce}
          onClose={() => setShowTipModal(false)}
          onTipSubmitted={() => {
            setTipPending(true)
            setTimeout(() => setTipPending(false), 15000)
          }}
        />
      )}

      {/* Switch Chain Modal */}
      <SwitchChainModal
        isOpen={showSwitchChainModal}
        onClose={() => setShowSwitchChainModal(false)}
      />

      {/* Mute Words Modal */}
      <MuteWordsModal
        isOpen={showMuteWordsModal}
        onClose={() => setShowMuteWordsModal(false)}
        postContent={useItem.content}
        existingMutedWords={JSON.parse(localStorage.getItem('mutedWords') || '[]')}
        onMute={(words) => {
          const mutedWords = JSON.parse(localStorage.getItem('mutedWords') || '[]')
          mutedWords.push(...words)
          localStorage.setItem('mutedWords', JSON.stringify([...new Set(mutedWords)]))
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
          if (shouldShowMuteConfirmModal()) {
            setMuteConfirmAction('mute-words')
            setShowMuteConfirmModal(true)
          }
        }}
      />

      {/* Mute Confirmation Modal */}
      <MuteConfirmModal
        isOpen={showMuteConfirmModal}
        onClose={() => setShowMuteConfirmModal(false)}
        actionType={muteConfirmAction}
        targetName={muteConfirmAction === 'mute-account' || muteConfirmAction === 'block-account' ? useItem.user.username : undefined}
        onConfirm={() => {
          // When modal closes, save the action
          switch (muteConfirmAction) {
            case 'hide-post': {
              // Use useItem.id (the original post) - for recaws this hides the original, which also hides all recaws
              const hiddenPosts = JSON.parse(localStorage.getItem('hiddenPosts') || '[]')
              hiddenPosts.push(useItem.id)
              localStorage.setItem('hiddenPosts', JSON.stringify([...new Set(hiddenPosts)]))
              window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
              break
            }
            case 'mute-thread': {
              // Call API to mute thread (server-side for notifications)
              const effectiveTokenId = activeTokenId || activeToken?.tokenId
              if (effectiveTokenId) {
                apiFetch(`/api/notifications/mute-thread/${useItem.id}`, {
                  method: 'POST',
                  headers: { 'x-user-id': effectiveTokenId.toString() }
                }).catch(err => console.error('Failed to mute thread:', err))
              }
              break
            }
            case 'mute-account': {
              const mutedAccounts = JSON.parse(localStorage.getItem('mutedAccounts') || '[]')
              mutedAccounts.push(useItem.user.id)
              localStorage.setItem('mutedAccounts', JSON.stringify([...new Set(mutedAccounts)]))
              window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
              // Sync to server for notification filtering
              const muteTokenId = activeTokenId || activeToken?.tokenId
              if (muteTokenId) {
                apiFetch(`/api/notifications/mute-account/${useItem.user.id}`, {
                  method: 'POST',
                  headers: { 'x-user-id': muteTokenId.toString() }
                }).catch(err => console.error('Failed to sync mute to server:', err))
              }
              break
            }
            case 'block-account': {
              // Blocking is browser-only (localStorage)
              const blockedAccounts = JSON.parse(localStorage.getItem('blockedAccounts') || '[]')
              blockedAccounts.push(useItem.user.id)
              localStorage.setItem('blockedAccounts', JSON.stringify([...new Set(blockedAccounts)]))
              window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
              break
            }
          }
        }}
      />

      {/* Report Post Modal */}
      <ReportPostModal
        isOpen={showReportModal}
        onClose={() => setShowReportModal(false)}
        postId={parseInt(useItem.id)}
        postAuthorId={useItem.user.id}
        postAuthorUsername={useItem.user.username}
        onSubmit={async (reason: ReportReason, details: string) => {
          const reporterId = activeTokenId || activeToken?.tokenId

          // Submit report to API
          await apiFetch('/api/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              reporterId,
              postId: parseInt(useItem.id),
              postAuthorId: useItem.user.id,
              reason,
              details: details || undefined
            })
          })

          // Also store locally so we can hide it from the user's feed
          const reportedPosts = JSON.parse(localStorage.getItem('reportedPosts') || '[]')
          reportedPosts.push({
            postId: useItem.id,
            userId: useItem.user.id,
            reason,
            timestamp: new Date().toISOString()
          })
          localStorage.setItem('reportedPosts', JSON.stringify(reportedPosts))
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
        }}
      />
    </>
  )
}

export default FeedItem
