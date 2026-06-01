import { getUserAvatar, getDefaultAvatarForUser } from "~/utils/defaultAvatar"
import Avatar from "~/components/Avatar"
import { ThumbtackIcon } from "~/components/icons/ThumbtackIcon"
import { getJSON, setJSON } from "~/utils/safeStorage"
// src/components/FeedItem.tsx - UPDATED FOR CONSISTENCY
import React, { useState, useRef, useEffect } from 'react'
import { useQueryClient } from '@tanstack/react-query'
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
  HiOutlineTrash,
  HiOutlineUserRemove,
  HiOutlineExclamation,
  HiOutlineCheck,
  HiOutlineRefresh,
  HiOutlineX,
  HiOutlineShieldCheck,
} from 'react-icons/hi'
import PostVideo from './PostVideo'
import Recaw from '~/assets/images/recaw.svg?react';
import UserHoverCard from './UserHoverCard';
import Pencil from '~/assets/images/pencil.svg?react';
import Bookmark from '~/assets/images/bookmark.svg?react';
import Share from '~/assets/images/share.svg?react';
import { useTokenDataStore } from '~/store/tokenDataStore'
import { translateTextDetailed, detectScript } from '~/utils/translate'
import { useViewerLanguage } from '~/hooks/useViewerLanguage'
import { useMyRole } from '~/hooks/useMyRole'
import { languageName } from '~/constants/languages'
import { useT } from '~/i18n/I18nProvider'
import { cawUrl } from '~/utils/cawUrl'
import { useBlockedUsersStore } from '~/store/blockedUsersStore'
import { ShareModal } from './ShareModal'
import { useModalStore } from '~/store/modalStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { useBalanceChangeStore } from '~/store/balanceChangeStore'
import { useHiddenCawsStore } from '~/store/hiddenCawsStore'
import { useBookmarksStore } from '~/store/bookmarksStore'
import { useLocation } from 'react-router-dom'
import { Link, useNavigate } from '~/utils/localizedRouter'
import { User, CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import ContentWithHashtags from './ContentWithHashtags'
import PollDisplay from './PollDisplay'
import PollMiniResults from './PollMiniResults'
import { stripPollMarker } from '~/../../../tools/pollMarker'
import { formatEngagementCount } from '~/utils/numberFormat'
import { apiFetch } from '~/api/client'
import ConfirmModal from '~/components/modals/ConfirmModal'
import ModalWrapper from '~/components/modals/ModalWrapper'
import MuteWordsModal from './modals/MuteWordsModal'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import Tooltip from '~/components/Tooltip'
import XBadge from '~/components/XBadge'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useUserByToken } from '~/hooks/useUserData'
import { useSignInModalStore } from '~/store/signInModalStore'
import MuteConfirmModal, { shouldShowMuteConfirmModal } from './modals/MuteConfirmModal'
import ReportPostModal, { ReportReason } from './modals/ReportPostModal'
import TipModal from './modals/TipModal'
import { HiOutlineCurrencyDollar } from 'react-icons/hi'
import { chains } from '~/config/chains'

import { formatTimeAgo } from '~/utils/formatTimeAgo'
import { CawThumbnail, pickCawThumbnail, type CawThumbnailSource } from '~/utils/cawThumbnail'


const FeedItem: React.FC<{ item: CawItem; isMainPost?: boolean; isReply?: boolean; hideParentPreview?: boolean; hideMedia?: boolean; contentClassName?: string; uiDensity?: 'normal' | 'compact'; showReplyRail?: boolean; hideBottomBorder?: boolean; inThread?: boolean; onBookmarkUpdate?: (cawId: number, isBookmarked: boolean) => void; onLikeStateChange?: (cawId: string, likePending: boolean) => void; onRecawStateChange?: (cawId: string, recawPending: boolean) => void; onReplyStateChange?: (cawId: string, replyPending: boolean) => void; onTipStateChange?: (cawId: string, tipPending: boolean) => void; onPinUpdate?: (cawId: string, isPinned: boolean) => void }> = ({ item, isMainPost = false, isReply = false, hideParentPreview = false, hideMedia = false, contentClassName, uiDensity = 'normal', showReplyRail = true, hideBottomBorder = false, inThread = false, onBookmarkUpdate, onLikeStateChange, onRecawStateChange, onReplyStateChange, onTipStateChange, onPinUpdate }) => {
  // For plain recaws, pending states and counts should reflect the original post (parent),
  // not the recaw wrapper. useItem is set to item.parent for recaws further below, but
  // we need the right source for initial state here. Quotes act as their own posts.
  const isPlainRecaw = item.content === "" && item.parent && !item.isQuote
  const stateSource = isPlainRecaw ? item.parent : item

  // Local pending states (declared early so polling can use them)
  const [likePending, setLikePending] = useState(stateSource.likePending || false)
  const [likeOverride, setLikeOverride] = useState<boolean | null>(null)
  const [recawPending, setRecawPending] = useState(stateSource.recawPending || false)
  const [replyPending, setReplyPending] = useState(stateSource.replyPending || false)
  const [tipPending, setTipPending] = useState(stateSource.tipPending || false)

  // Optimistic count adjustments (added when pending, removed on failure).
  // We also track the "base" server count at the moment the optimistic adj was applied,
  // so we can detect when the server has caught up and stop adding the adjustment.
  const [likeCountAdj, setLikeCountAdj] = useState(0)
  const [recawCountAdj, setRecawCountAdj] = useState(0)
  const [replyCountAdj, setReplyCountAdj] = useState(0)
  const [likeCountBase, setLikeCountBase] = useState<number | null>(null)
  const [recawCountBase, setRecawCountBase] = useState<number | null>(null)
  const [replyCountBase, setReplyCountBase] = useState<number | null>(null)

  // Polling for pending items is handled centrally by Feed.tsx (unified polling interval).
  // No per-item polling hooks needed here — avoids 5 timers × N items = cascading jank.

  const activeTokenId     = useTokenDataStore(s => s.activeTokenId)
  const blockUser = useBlockedUsersStore(s => s.blockUser)
  const isCaptive = !useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return (tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0])?.username
  })
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })
  // Active user's by-token data, used by the pin menu to read
  // pinnedCawCount for the 3/3 cap UX. React Query coalesces all
  // FeedItem instances onto a single request per active tokenId.
  const { data: currentUserData } = useUserByToken(activeTokenId || activeToken?.tokenId)
  const openModal        = useModalStore(s => s.openModal)
  const { isConnected, address } = useAccount()
  const chainId = useChainId()
  const { openConnectModal } = useConnectModal()
  const hasActiveSession = useHasActiveSession()
  const { isDark } = useTheme()
  const qc = useQueryClient()
  const navigate = useNavigate()
  const location = useLocation()

  const openPostMedia = (postOrId: CawItem | string, mediaIndex: number) => {
    // Caller may pass either a full caw (preferred — gets canonical URL)
    // or just a string id (back-compat for callsites that don't have the
    // post in scope; the modal still resolves it from `:id`).
    const path = typeof postOrId === 'string' ? `/caws/${postOrId}` : cawUrl(postOrId)
    navigate(`${path}?media=${mediaIndex}&source=imageData`, {
      state: { backgroundLocation: location }
    })
  }
  const [busyLike, setBusyLike]     = useState(false)
  const [busyRecaw, setBusyRecaw]   = useState(false)
  // Cleared when the optimistic-like row is removed (success or fail).
  // Used to drive the in-flight cancel UX: while non-null, the heart
  // tap calls /api/txqueue/:id/cancel instead of being inert.
  const [pendingLikeTxQueueId, setPendingLikeTxQueueId] = useState<number | null>(null)
  const [pendingLikeAction, setPendingLikeAction] = useState<{ receiverId: number, receiverCawonce: number, actionType: 'like' | 'unlike' } | null>(null) // Track pending like data
  // Recaw counterpart. Lets the "Undo repost" menu cancel a still-pending
  // recaw via /api/txqueue/:id/cancel instead of firing a second on-chain
  // hide:recaw action that would double-spend.
  const [pendingRecawTxQueueId, setPendingRecawTxQueueId] = useState<number | null>(null)
  const [wrongWalletError, setWrongWalletError] = useState(false) // Track if wrong wallet is connected
  const signAndSubmit     = useSignAndSubmitAction()
  const [showRecawMenu, setShowRecawMenu]   = useState(false)
  const [showOptionsMenu, setShowOptionsMenu] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  // Pin/unpin: when QuickSign + scope-7 is active we submit silently;
  // otherwise this state opens a confirmation modal letting the user
  // choose between an on-chain pin (free apart from the OTHER-action
  // cost) and an off-chain-only pin.
  const [showPinChoice, setShowPinChoice] = useState(false)
  const [showShareModal, setShowShareModal] = useState(false)
  const [showTipModal, setShowTipModal] = useState(false)
  // NOTE: Media collapse UI removed — posts should show attached media
  // consistently without extra toggles in the feed.
  const [textCopied, setTextCopied] = useState(false)
  const bookmarksStore = useBookmarksStore()
  // Sync server-provided bookmark state into store on mount
  useEffect(() => {
    if (item.isBookmarked === true) bookmarksStore.markBookmarked(item.id)
    else if (item.isBookmarked === false) bookmarksStore.markNotBookmarked(item.id)
  }, [item.id, item.isBookmarked])
  const isBookmarked = bookmarksStore.isBookmarked(item.id)
  const [localBookmarkCount, setLocalBookmarkCount] = useState(item.bookmarkCount ?? 0)
  // Brief slide-in + flash whenever this row becomes the pinned one.
  // Driven by `item.isPinned` (set by the parent feed's optimistic
  // reorder) so it fires whether the pin came from this client or a
  // background refetch surfaced one. We track the previous value with a
  // ref to detect the false→true transition.
  const wasPinnedRef = useRef(false)
  const [pinAnimating, setPinAnimating] = useState(false)
  useEffect(() => {
    if (item.isPinned && !wasPinnedRef.current) {
      setPinAnimating(true)
      const t = setTimeout(() => setPinAnimating(false), 700)
      wasPinnedRef.current = true
      return () => clearTimeout(t)
    }
    wasPinnedRef.current = !!item.isPinned
  }, [item.isPinned])
  const [translatedText, setTranslatedText] = useState<string | null>(null)
  const [translatedPollOptions, setTranslatedPollOptions] = useState<string[] | null>(null)
  const [isTranslating, setIsTranslating] = useState(false)
  // Tracks the source language we've discovered for this caw — either
  // from item.sourceLanguage on first render, or from a successful
  // translate that returned a detected source. Used to label the
  // "Translated from <name>" header and to avoid POST'ing the same
  // language back to the server twice. Initialized lazily inside an
  // effect below to react to feed refetches that surface a freshly-
  // detected sourceLanguage.
  const [knownSourceLanguage, setKnownSourceLanguage] = useState<string | null>(null)
  const viewerLang = useViewerLanguage()
  const t = useT()
  const [isRetrying, setIsRetrying] = useState(false)
  const [showMuteWordsModal, setShowMuteWordsModal] = useState(false)
  const [showMuteConfirmModal, setShowMuteConfirmModal] = useState(false)
  const [muteConfirmAction, setMuteConfirmAction] = useState<'hide-post' | 'mute-thread' | 'mute-account' | 'block-account' | 'mute-words'>('hide-post')
  const [showReportModal, setShowReportModal] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const optionsMenuRef = useRef<HTMLDivElement>(null)
  const isSubmittingLikeRef = useRef(false) // Prevent duplicate like submissions
  const pinInFlightRef = useRef(false) // Prevent rapid-fire pin/unpin submissions that inflate count
  // Guards the auto-translate effect — without it, every render that
  // produces a fresh runTranslation closure (or refetch that bumps
  // useItem) would queue another translate call. We only want one
  // auto-pass per (caw, viewer language) pair.
  const autoTranslatedRef = useRef<string | null>(null)

  // Determine which item to use (handle recaws)
  let useItem = item;
  let headline;
  let isRecaw = false;
  let isRecawByCurrentUser = false;
  // A quote is a RECAW with content (isQuote=true from API).
  // A pure recaw is a RECAW with empty content (handled below).
  // A reply is a CAW with a parent.
  const isQuote = !!item.isQuote;
  if (item.content === "" && item.parent) {
    // Check if the recaw is by the current user
    const userId = item.user.tokenId;
    const currentUserId = activeTokenId || activeToken?.tokenId;
    const isCurrentUser = currentUserId && (userId == currentUserId);

    const recawWho = isCurrentUser
      ? t('post.recawed_by_you')
      : t('post.recawed_by', { name: item.user.displayName || item.user.username });
    headline = item.timestamp
      ? `${recawWho} · ${formatTimeAgo(item.timestamp)}`
      : recawWho;
    useItem = item.parent;
    isRecaw = true;
    isRecawByCurrentUser = !!isCurrentUser;
  }

  // True if the viewer just deleted this post (or its parent, for recaws).
  // Subscribed to the store so unhide events re-render. Checked before the
  // main render returns so the component renders nothing.
  const isHiddenForViewer = useHiddenCawsStore(s =>
    (useItem.cawonce != null && useItem.user?.tokenId != null &&
      !!s.hiddenCawonces[`${useItem.user.tokenId}:${Number(useItem.cawonce)}`]) ||
    (item.cawonce != null && item.user?.tokenId != null &&
      !!s.hiddenCawonces[`${item.user.tokenId}:${Number(item.cawonce)}`])
  )

  // Compute effective count adjustments: if the server count has moved past
  // the base snapshot (taken when the optimistic adj was applied), the server
  // has caught up and we should stop adding the adjustment to avoid double-
  // counting. Direction-aware: a positive adj resolves when the server
  // counter has climbed at or past base+adj; a negative adj resolves when
  // the server counter has fallen at or past base+adj. Unlike now writes
  // a server-side decrement immediately (matching the local -1), so we
  // need symmetry — the previous `> base` check only caught upward catch-up.
  const settled = (adj: number, server: number, base: number | null): boolean => {
    if (adj === 0 || base === null) return false
    return adj > 0 ? server >= base + adj : server <= base + adj
  }
  const effectiveReplyAdj = settled(replyCountAdj, useItem.commentCount, replyCountBase) ? 0 : replyCountAdj
  const effectiveRecawAdj = settled(recawCountAdj, useItem.recawCount, recawCountBase) ? 0 : recawCountAdj
  const effectiveLikeAdj  = settled(likeCountAdj,  useItem.likeCount,    likeCountBase)  ? 0 : likeCountAdj

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
      if (response?.txQueueId) setPendingLikeTxQueueId(response.txQueueId)
      setLikePending(true);

      // Notify parent component about like state change
      if (onLikeStateChange) {
        onLikeStateChange(useItem.id, true);
      }
    }).catch(err => {
      console.error('Like failed', err);
      setLikePending(false);
    }).finally(() => {
      setBusyLike(false);
      isSubmittingLikeRef.current = false;
    });
  }, [pendingLikeAction, isConnected, activeTokenId, activeToken, address, signAndSubmit, useItem.id])

  // Sync local pending states with item from polling — reset adjustments when server confirms.
  // For plain recaws, sync from the parent (stateSource) since actions target the original post.
  useEffect(() => {
    setLikePending(stateSource.likePending || false)
    if (!stateSource.likePending) {
      setLikeCountAdj(0)
      setLikeCountBase(null)
      setPendingLikeTxQueueId(null)
    }
  }, [stateSource.likePending])

  useEffect(() => {
    setRecawPending(stateSource.recawPending || false)
    if (!stateSource.recawPending) {
      setRecawCountAdj(0)
      setRecawCountBase(null)
      setPendingRecawTxQueueId(null)
    }
  }, [stateSource.recawPending])

  useEffect(() => {
    setReplyPending(stateSource.replyPending || false)
    if (!stateSource.replyPending) { setReplyCountAdj(0); setReplyCountBase(null) }
  }, [stateSource.replyPending])

  // Sync local tipPending state from polling
  useEffect(() => {
    setTipPending(stateSource.tipPending || false)
  }, [stateSource.tipPending])

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
    event.stopPropagation()

    if (isCaptive) { useSignInModalStore.getState().show(t('post.signin.like')); return }

    // Don't allow interactions with pending or failed caws
    if (item.status === 'FAILED') {
      return
    }

    // If wallet not connected and no session key, open connect modal
    if (!isConnected && !hasActiveSession) {
      // Reset submitting ref for new action
      isSubmittingLikeRef.current = false;
      setPendingLikeAction({
        receiverId: useItem.user.tokenId,
        receiverCawonce: useItem.cawonce ?? 0,
        actionType: useItem.hasLiked ? 'unlike' : 'like'
      });
      if (openConnectModal) {
        openConnectModal();
      }
      return;
    }

    if (!hasActiveSession) {
      // signAndSubmit handles wallet connection and chain switching
      // automatically. We only need a pre-flight check for the wrong-wallet
      // case here so the user sees an immediate hint instead of a generic
      // "wrong wallet" error mid-sign.
      if (activeToken && address && activeToken.address.toLowerCase() !== address.toLowerCase()) {
        setWrongWalletError(true)
        setTimeout(() => setWrongWalletError(false), 5000) // Clear error after 5 seconds
        return
      }
    }

    // If no active token selected, return
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId || busyLike || likePending) {
      return
    }

    setBusyLike(true)

    let tempLikeId: string | undefined
    const addOptimisticLike = useOptimisticLikesStore.getState().addOptimisticLike
    const updateLikeWithTxQueueId = useOptimisticLikesStore.getState().updateLikeWithTxQueueId

    const isLiking = !useItem.hasLiked
    setLikeCountAdj(isLiking ? 1 : -1)
    setLikeCountBase(useItem.likeCount)
    setLikePending(true)
    setLikeOverride(isLiking)
    if (isLiking) {
      tempLikeId = addOptimisticLike({ userId: effectiveTokenId, cawId: useItem.id })
    }
    if (onLikeStateChange) onLikeStateChange(useItem.id, true)

    try {
      const response = await signAndSubmit({
        actionType:      useItem.hasLiked ? 'unlike' : 'like',
        senderId:        effectiveTokenId,
        receiverId:      useItem.user.tokenId,
        receiverCawonce: useItem.cawonce ?? 0,
      })

      if (!response) {
        setLikePending(false)
        setLikeCountAdj(0)
        setLikeCountBase(null)
        setLikeOverride(null)
        if (tempLikeId) useOptimisticLikesStore.getState().removeOptimisticLike(tempLikeId)
        if (onLikeStateChange) onLikeStateChange(useItem.id, false)
        return
      }

      if (tempLikeId && response?.txQueueId) updateLikeWithTxQueueId(tempLikeId, response.txQueueId)
      if (response?.txQueueId) setPendingLikeTxQueueId(response.txQueueId)
    } catch (err) {
      console.error('Like failed', err)
      setLikePending(false)
      setLikeCountAdj(0)
      setLikeCountBase(null)
      setLikeOverride(null)
      if (tempLikeId) useOptimisticLikesStore.getState().removeOptimisticLike(tempLikeId)
      if (onLikeStateChange) onLikeStateChange(useItem.id, false)
    } finally {
      setBusyLike(false)
    }
  }

  // Cancel an in-flight like before the validator picks it up. Server
  // returns 409 when we lose the race (validator already grabbed the
  // batch), in which case we leave the optimistic state alone — the
  // action will go through and surface as a confirmed like shortly.
  const handleCancelLike = async () => {
    if (!pendingLikeTxQueueId) return
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    setBusyLike(true)
    // Snapshot the spend amount before we drop it so we can restore on a
    // 409 (validator already picked it up). Optimistically tear down the
    // pending UI right now — the ProfileChooser "−X CAW pending" line
    // updates instantly instead of after the cancel POST roundtrip.
    const cancelledTxQueueId = pendingLikeTxQueueId
    const snapshotSpend = usePendingSpendStore.getState().pendingByTxQueue[cancelledTxQueueId]
    // If we're cancelling an UNLIKE (server already decremented likeCount and
    // shows hasLiked=false), the cancel will eventually restore the row to
    // LIKE/SUCCESS. Hold an optimistic +1 / liked override until the refetch
    // catches up so the UI doesn't briefly show the unliked state.
    const cancellingUnlike = !useItem.hasLiked && likeOverride === false
    setLikePending(false)
    if (cancellingUnlike) {
      setLikeCountAdj(1)
      setLikeCountBase(useItem.likeCount)
      setLikeOverride(true)
    } else {
      setLikeCountAdj(0)
      setLikeCountBase(null)
      setLikeOverride(null)
    }
    useOptimisticLikesStore.getState().removeOptimisticLikeByTxQueueId(cancelledTxQueueId)
    usePendingSpendStore.getState().removePendingSpend(cancelledTxQueueId)
    useBalanceChangeStore.getState().dropPendingWindow(`txq:${cancelledTxQueueId}`)
    setPendingLikeTxQueueId(null)
    if (onLikeStateChange) onLikeStateChange(useItem.id, false)
    try {
      await apiFetch(`/api/txqueue/${cancelledTxQueueId}/cancel`, { method: 'POST' })
    } catch (err: any) {
      // 409 = too late, validator already picked it up. Restore the
      // pending spend so the user's "−X CAW pending" reflects reality.
      // The action will confirm via the polling effect and clear normally.
      if (String(err?.message || '').includes('409')) {
        if (snapshotSpend && snapshotSpend > 0n) {
          usePendingSpendStore.getState().addPendingSpend(cancelledTxQueueId, snapshotSpend, effectiveTokenId)
        }
        // The action landed on chain — our optimistic restore was wrong.
        // Snap back to the pre-cancel pending state so the UI matches.
        if (cancellingUnlike) {
          setLikeCountAdj(-1)
          setLikeCountBase(useItem.likeCount)
          setLikeOverride(false)
        }
      } else {
        console.error('Cancel like failed', err)
      }
    } finally {
      setBusyLike(false)
    }
  }

  const [retrySucceeded, setRetrySucceeded] = useState(false)

  const handleRetry = async (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    console.log('[FeedItem] Retry clicked:', { effectiveTokenId, isRetrying, content: useItem.content?.substring(0, 50) })

    if (!effectiveTokenId || !activeToken || isRetrying) {
      console.log('[FeedItem] Retry blocked:', { effectiveTokenId, hasActiveToken: !!activeToken, isRetrying })
      return
    }

    setIsRetrying(true)

    try {
      // Resubmit the caw action, preserving reply context if present
      const retryParams: any = {
        actionType: 'caw',
        senderId: effectiveTokenId,
        text: useItem.content,
      }

      // If this was a reply, include the parent's info
      if (item.parent?.user?.tokenId != null && item.parent?.cawonce != null) {
        retryParams.receiverId = item.parent.user.tokenId
        retryParams.receiverCawonce = item.parent.cawonce
      }

      const result = await signAndSubmit(retryParams)

      console.log('[FeedItem] Retry result:', result)

      if (result) {
        // Add a pending post to the feed so the user sees it immediately.
        // parent + replyToId carry the reply context forward so a *second*
        // failure (e.g. cawonce-collision retry that itself fails) doesn't
        // strand a reply as a top-level caw on the next retry click.
        const { addPendingPost, updatePostWithTxQueueId } = usePendingPostsStore.getState()
        const tempId = addPendingPost({
          content: useItem.content || '',
          username: item.user?.username || '',
          tokenId: effectiveTokenId,
          displayName: item.user?.displayName,
          image: item.user?.image,
          avatarUrl: getUserAvatar(item.user),
          cawonce: result.cawonce,
          parent: item.parent,
          replyToId: item.parent?.id,
        })
        if (result.txQueueId) {
          updatePostWithTxQueueId(tempId, result.txQueueId)
        }

        // Hide this failed caw — the retry created a new pending caw
        setRetrySucceeded(true)
      }
    } catch (error) {
      console.error('[FeedItem] Retry failed:', error)
    } finally {
      setIsRetrying(false)
    }
  }

  const handleRecaw = async (event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()

    if (isCaptive) { useSignInModalStore.getState().show(t('post.signin.repost')); return }

    // Don't allow interactions with pending or failed caws
    if (item.status === 'FAILED') {
      return
    }

    // If wallet not connected and no session key, open connect modal
    if (!isConnected && !hasActiveSession) {
      if (openConnectModal) {
        openConnectModal()
      }
      return
    }

    if (!hasActiveSession) {
      // signAndSubmit handles wallet connection and chain switching
      // automatically. We only need a pre-flight check for the wrong-wallet
      // case here so the user sees an immediate hint instead of a generic
      // "wrong wallet" error mid-sign.
      if (activeToken && address && activeToken.address.toLowerCase() !== address.toLowerCase()) {
        setWrongWalletError(true)
        setTimeout(() => setWrongWalletError(false), 5000) // Clear error after 5 seconds
        return
      }
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
        receiverId:      Number(useItem.user.tokenId ?? 0),
        receiverCawonce: useItem.cawonce ?? 0,
      })

      // signAndSubmit returns null if insufficient stake (modal shown automatically)
      if (!result) return

      // Set pending state and increment count optimistically
      setRecawPending(true)
      setRecawCountAdj(1)
      setRecawCountBase(useItem.recawCount)
      if (result.txQueueId) setPendingRecawTxQueueId(result.txQueueId)

      if (onRecawStateChange) {
        onRecawStateChange(useItem.id, true)
      }

      // Add a pending recaw to the feed so it shows immediately on the user's profile
      const { addPendingPost, updatePostWithTxQueueId } = usePendingPostsStore.getState()
      // Read display name from react-query cache (already fetched by ProfileChooser)
      const cachedUser = qc.getQueryData<any>(['user', activeToken?.username])
      const tempId = addPendingPost({
        content: '',
        username: activeToken?.username || '',
        displayName: cachedUser?.displayName,
        tokenId: effectiveTokenId,
        avatarUrl: getUserAvatar({ tokenId: effectiveTokenId }),
        parent: useItem as CawItem,
        cawonce: result.cawonce,
      })
      if (result.txQueueId) updatePostWithTxQueueId(tempId, result.txQueueId)
    } catch (err) {
      console.error('Recaw failed', err)
      setRecawPending(false)
      setRecawCountAdj(0)
      setRecawCountBase(null)
    } finally {
      setBusyRecaw(false)
    }
  }

  const handleReply = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    if (isCaptive) { useSignInModalStore.getState().show(t('post.signin.reply')); return }

    // Don't allow interactions with pending or failed caws
    if (item.status === 'FAILED') {
      return
    }

    // For plain recaws, reply to the original post (useItem), not the recaw wrapper.
    // Quotes act as their own posts, so reply to the quote itself (item).
    const replyTarget = (isRecaw && !isQuote) ? useItem : item

    // Refuse to navigate to a still-pending caw's reply page — the URL
    // would carry the temp `pending-…` id and CawPage couldn't load any
    // replies until the real id surfaces. Fall through to the mobile-
    // modal flow which doesn't need a route at all.
    if (typeof window !== 'undefined'
        && window.matchMedia('(min-width: 768px)').matches
        && !String(replyTarget.id).startsWith('pending-')) {
      // Desktop UX: navigate to the post page to reply inline.
      // Same in-memory seed as handleCardClick so the post renders
      // without a full-page spinner.
      navigate(`${cawUrl(replyTarget)}?reply=1`, { state: { caw: replyTarget } })
      return
    }

    // Mobile: open modal with onSuccess callback to set pending state.
    openModal('comment', replyTarget, () => {
      setReplyPending(true)
      setReplyCountAdj(1)
      setReplyCountBase(useItem.commentCount)
      if (onReplyStateChange) {
        onReplyStateChange(useItem.id, true)
      }
    })
  }

  const handleBookmark = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const cawId = useItem.id
    const wasBookmarked = bookmarksStore.isBookmarked(cawId)
    const newState = bookmarksStore.toggleBookmark(cawId)

    // Only adjust count if the state actually changed
    if (newState !== wasBookmarked) {
      setLocalBookmarkCount(prev => Math.max(0, prev + (newState ? 1 : -1)))
    }

    if (onBookmarkUpdate) {
      onBookmarkUpdate(parseInt(cawId), newState)
    }
  }

  // Submit the pin/unpin action. The actual lifecycle (pending → confirmed
  // / failed) is server-tracked via the PinnedCaw row + tx-queue, mirroring
  // exactly how Like.pending works. We only do an in-memory optimistic
  // reorder via onPinUpdate so the feed visibly responds before the next
  // refetch lands.
  //
  //   onChain=true  → OTHER action text "pi:{cawId}" / "xpi:{cawId}".
  //   onChain=false → POST/DELETE /api/pins/:cawId, no chain involvement.
  const submitPinAction = async (target: 'pin' | 'unpin', onChain: boolean) => {
    // Reentrancy guard: rapid-fire clicks (especially while an on-chain
    // submit is awaiting the wallet) were producing duplicate server-side
    // pin rows, inflating the user's pinnedCawCount past the cap (e.g.
    // 4/3). One in-flight pin/unpin at a time.
    if (pinInFlightRef.current) return
    const effectiveTokenId = activeTokenId || activeToken?.tokenId
    if (!effectiveTokenId) return
    const cawId = parseInt(useItem.id)
    const willBePinned = target === 'pin'

    pinInFlightRef.current = true
    // Snappy in-memory reorder. The server-side optimistic write makes
    // the result survive a refresh; this is purely the visual feedback
    // before any round-trip completes.
    onPinUpdate?.(useItem.id, willBePinned)

    try {
      if (onChain) {
        try {
          await signAndSubmit({
            actionType: 'other',
            senderId: effectiveTokenId,
            receiverId: 0,
            receiverCawonce: 0,
            text: willBePinned ? `pi:${cawId}` : `xpi:${cawId}`,
          })
        } catch (err) {
          console.error('[Pin] on-chain submit failed:', err)
          // Roll back the in-memory reorder. The server-side optimistic
          // row was never written (signAndSubmit failed before /api/actions
          // returned), so there's nothing to clean up server-side.
          onPinUpdate?.(useItem.id, !willBePinned)
        }
      } else {
        try {
          await apiFetch(`/api/pins/${cawId}`, {
            method: willBePinned ? 'POST' : 'DELETE',
            headers: { 'x-user-id': String(effectiveTokenId) },
          })
        } catch (err) {
          console.error('[Pin] off-chain submit failed:', err)
          onPinUpdate?.(useItem.id, !willBePinned)
        }
      }
    } finally {
      pinInFlightRef.current = false
    }
  }

  // Click handler for the pin/unpin menu item. Reads QuickSign session
  // state — if active and scope-7 (OTHER) is set, just submits on chain
  // silently. Otherwise opens the choice modal.
  const handlePinClick = async () => {
    setShowOptionsMenu(false)
    const target: 'pin' | 'unpin' = item.isPinned ? 'unpin' : 'pin'

    const { useSessionKeyStore } = await import('~/store/sessionKeyStore')
    const tokenOwner = activeToken?.owner
    const session = tokenOwner
      ? useSessionKeyStore.getState().getActiveSessionForAddress(tokenOwner)
      : useSessionKeyStore.getState().getActiveSession()
    const otherActionBit = 7
    const canUseSession = !!session && (session.scopeBitmap & (1 << otherActionBit)) !== 0

    if (canUseSession) {
      submitPinAction(target, true)
    } else {
      // Unpin defaults to off-chain to avoid a wallet popup for a cosmetic
      // toggle. If the original pin was on-chain, the row exists locally
      // (off-chain delete just deletes the cached row); the on-chain pin
      // is independent — but since reads come from the DB only, this is
      // effectively the same outcome from the user's perspective.
      if (target === 'unpin') {
        submitPinAction('unpin', false)
      } else {
        setShowPinChoice(true)
      }
    }
  }

  const handleOptionsClick = (e?: React.MouseEvent) => {
    if (e) {
      e.preventDefault()
      e.stopPropagation()
    }
    setShowOptionsMenu(!showOptionsMenu)
  }

  // Moderator hide. Hits the audit-logged moderation endpoint and
  // updates the local item so it renders the "removed by poster" stub
  // shape (same path as on-chain HIDDEN). Best-effort optimism — if
  // the request fails we surface a small alert and the UI snaps back.
  const { isModerator } = useMyRole()
  const handleModHide = async () => {
    const reason = window.prompt(
      `Hide @${useItem.user?.username}'s caw as a moderator?\n\nOptional: reason for the audit log.`,
      ''
    )
    // null === user cancelled. Empty string === confirmed without a reason.
    if (reason === null) return
    try {
      await apiFetch(`/api/moderation/caws/${useItem.id}/hide`, {
        method: 'POST',
        body: JSON.stringify({ reason: reason || null }),
      })
      // Optimistic local hide so the post visibly disappears without a
      // refetch. The next feed render will reflect status='HIDDEN' from
      // the server too.
      ;(useItem as any).status = 'HIDDEN'
      // Force a re-render of the parent list. We don't have a dedicated
      // signal, so a window event is fine — Feed listens to it.
      window.dispatchEvent(new CustomEvent('caw-hidden', { detail: { id: useItem.id } }))
    } catch (err: any) {
      console.error('[Moderation] hide failed:', err)
      window.alert('Failed to hide caw. ' + (err?.message ?? ''))
    }
  }

  // Mirror useItem.sourceLanguage into local state so a feed refetch that
  // newly-populates the column (because some other viewer just translated
  // it) gates the inline button correctly without a remount. This effect
  // never overwrites a tighter guess we already have from a successful
  // local translation.
  //
  // Fallback: if the caw has no detected sourceLanguage yet (older posts
  // never translated by anyone), use the AUTHOR's preferredLanguage as a
  // best guess. Authors who set their own UI language to e.g. Japanese
  // overwhelmingly write in Japanese. This is a presumption — the user
  // can still hit the inline Translate button to force a real gtx detect,
  // which writes back to Caw.sourceLanguage and corrects the guess for
  // future viewers.
  useEffect(() => {
    if (knownSourceLanguage) return
    if (useItem.sourceLanguage) {
      setKnownSourceLanguage(useItem.sourceLanguage)
    } else if (useItem.user?.preferredLanguage) {
      setKnownSourceLanguage(useItem.user.preferredLanguage)
    } else {
      // Cheap script-based fallback: catches ja/ko/zh/ru/he/ar/hi/th
      // posts whose author never set their preferredLanguage. Returns
      // null for Latin-script content (mostly English / European
      // languages share the script too closely to disambiguate without
      // gtx), in which case the inline Translate button still works.
      const scriptGuess = detectScript(useItem.content)
      if (scriptGuess) setKnownSourceLanguage(scriptGuess)
    }
  }, [useItem.sourceLanguage, useItem.user?.preferredLanguage, useItem.content, knownSourceLanguage])

  // Translate the post and (if gtx returned a confident detection) cache
  // the source language back to the server. The 2nd parameter to
  // translateTextDetailed is the viewer's preferred language. Errors
  // are swallowed by the helper itself.
  const runTranslation = React.useCallback(async () => {
    if (!useItem.content) return
    setIsTranslating(true)
    try {
      const pollOpts = useItem.poll?.options
      const hasPoll = Array.isArray(pollOpts) && pollOpts.length > 0
      const sourceText = hasPoll
        ? `${useItem.content}\n\n${pollOpts!.join('\n')}`
        : useItem.content
      const result = await translateTextDetailed(sourceText, viewerLang.preferredLanguage)
      if (!result) return
      if (hasPoll) {
        const lines = result.text.replace(/\s+$/, '').split('\n')
        const nonEmptyTrailing: string[] = []
        let i = lines.length - 1
        while (i >= 0 && nonEmptyTrailing.length < pollOpts!.length) {
          if (lines[i].trim().length > 0) nonEmptyTrailing.unshift(lines[i])
          i--
        }
        if (nonEmptyTrailing.length === pollOpts!.length) {
          const bodyLines = lines.slice(0, i + 1)
          while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1].trim() === '') bodyLines.pop()
          setTranslatedText(bodyLines.join('\n'))
          setTranslatedPollOptions(nonEmptyTrailing)
        } else {
          console.warn('[FeedItem] poll translation line-count mismatch; showing originals')
          setTranslatedText(result.text)
          setTranslatedPollOptions(null)
        }
      } else {
        setTranslatedText(result.text)
        setTranslatedPollOptions(null)
      }
      const detected = result.sourceLanguage
      // gtx returns "auto" when it couldn't decide — only persist real
      // codes, and only the first time we discover one for this caw.
      if (detected && detected !== 'auto' && detected !== knownSourceLanguage) {
        setKnownSourceLanguage(detected)
        if (!useItem.sourceLanguage) {
          // Fire-and-forget; server-side updateMany is write-once so a
          // race between two viewers naturally collapses to one row update.
          apiFetch(`/api/caws/${useItem.id}/source-language`, {
            method: 'POST',
            body: JSON.stringify({ language: detected }),
          }).catch(() => { /* non-essential, ignore */ })
        }
      }
    } finally {
      setIsTranslating(false)
    }
  }, [useItem.id, useItem.content, useItem.sourceLanguage, useItem.poll?.options, viewerLang.preferredLanguage, knownSourceLanguage])

  // Auto-translate when the viewer enabled it AND we know the post's
  // source differs from the viewer's language. We require knownSourceLanguage
  // to be set — without it we can't tell whether translation is needed,
  // and silently translating every post would defeat the whole point of
  // the source-language cache (it would translate English-to-English etc).
  useEffect(() => {
    if (!viewerLang.autoTranslate) return
    if (!knownSourceLanguage) return
    if (knownSourceLanguage === viewerLang.preferredLanguage) return
    if (translatedText || isTranslating) return
    // Guard against re-running the auto-pass for the same caw if the
    // closure rebuilds. The key includes the target so a Settings change
    // does retrigger.
    const key = `${useItem.id}|${viewerLang.preferredLanguage}`
    if (autoTranslatedRef.current === key) return
    autoTranslatedRef.current = key
    void runTranslation()
  }, [viewerLang.autoTranslate, viewerLang.preferredLanguage, knownSourceLanguage, translatedText, isTranslating, useItem.id, runTranslation])

  // Show the inline Translate affordance only when it's actually useful:
  //   - we don't yet know the source language (let the user help us cache it), OR
  //   - we know it AND it differs from the viewer's language.
  // Unauthenticated viewers fall back to browser locale via useViewerLanguage.
  const shouldShowInlineTranslate = !knownSourceLanguage ||
    knownSourceLanguage !== viewerLang.preferredLanguage

  const handleMenuAction = async (action: string) => {
    setShowOptionsMenu(false)
    // Handle different menu actions
    switch (action) {
      case 'translate':
        if (isTranslating || translatedText) {
          // Toggle off — second click on Translate clears the translation.
          setTranslatedText(null)
          setTranslatedPollOptions(null)
          return
        }
        await runTranslation()
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
          const hiddenPosts = getJSON<string[]>('hiddenPosts', [])
          hiddenPosts.push(useItem.id)
          setJSON('hiddenPosts', [...new Set(hiddenPosts)])
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
        }
        break
      case 'mute-account': {
        const effectiveTokenId = activeTokenId || activeToken?.tokenId
        if (shouldShowMuteConfirmModal()) {
          setMuteConfirmAction('mute-account')
          setShowMuteConfirmModal(true)
        } else {
          const mutedAccounts = getJSON<number[]>('mutedAccounts', [])
          mutedAccounts.push(useItem.user.tokenId)
          setJSON('mutedAccounts', [...new Set(mutedAccounts)])
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
          // Sync to server for notification filtering
          if (effectiveTokenId) {
            apiFetch(`/api/notifications/mute-account/${useItem.user.tokenId}`, {
              method: 'POST',
              headers: { 'x-user-id': effectiveTokenId.toString() }
            }).catch(err => console.error('Failed to sync mute to server:', err))
          }
        }
        break
      }
      case 'block-account': {
        const effectiveBlockerId = activeTokenId || activeToken?.tokenId
        if (effectiveBlockerId) {
          blockUser(effectiveBlockerId, useItem.user.tokenId, useItem.user.username)
        }
        if (shouldShowMuteConfirmModal()) {
          setMuteConfirmAction('block-account')
          setShowMuteConfirmModal(true)
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
    // Don't navigate if user is selecting text
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) {
      return
    }
    // Don't navigate if clicking on interactive elements (they handle their own navigation)
    const target = e.target as HTMLElement
    if (target.closest('a') || target.closest('button')) {
      return
    }
    // Don't navigate for failed posts — there's nothing useful to render at
    // the dedicated page (no replies, can't be linked to).
    if (item.status === 'FAILED') {
      return
    }
    // Don't navigate while the id is still pending. We render the pending
    // row in the feed (so the user sees their post immediately) but the
    // detail page has nothing to show until the real id lands. Feed.tsx
    // already swaps pending→real at render time when items has caught up
    // — if useItem.id still starts with `pending-` here, the server-side
    // row hasn't surfaced yet and a click would land on /caws/pending-…
    // which leaks the temp id into the URL bar.
    if (String(useItem.id).startsWith('pending-')) {
      return
    }
    const url = cawUrl(useItem)
    // Open in new tab if command+click (Mac) or ctrl+click (Windows/Linux)
    if (e.metaKey || e.ctrlKey) {
      window.open(url, '_blank')
    } else {
      // Pass the post we already have in memory as location state so
      // CawPage can render it instantly while the API fills in replies/
      // recaws/tips in the background. Without this seed, every click
      // through from the feed shows a full-page "Loading…" even though
      // the post data was sitting right there in the FeedItem prop.
      navigate(url, { state: { caw: useItem } })
    }
  }

  // Hide the failed caw after a successful retry
  if (retrySucceeded) return null

  // Hide posts the user just deleted (optimistic — server-side hide takes
  // 5–60s to land via the indexer). Covers Feed lists AND the single-post
  // page (CawPage), where Feed.tsx's filter doesn't run.
  if (isHiddenForViewer) return null

  return (
    <>
      <div onClick={handleCardClick} className="block" data-caw-id={item.id}>
        <div className={`p-4 transition-all duration-300 feed-item-hover cursor-pointer ${hideBottomBorder ? 'feed-item-no-divider' : 'border-b'} ${
          isDark ? 'border-gray-800' : 'border-gray-200'
        } ${
          item.status === 'FAILED' ? 'opacity-60' : ''
        } ${pinAnimating ? 'feed-pin-flash' : ''}`}>
          {/* "Pinned" badge — only present on the profile-feed prepended
              post (the API stamps `isPinned: true` on it). Never shown
              on the regular feed even though a PinnedCaw row may exist. */}
          {item.isPinned && (
            <div className={`flex items-center gap-1.5 text-xs font-medium mb-2 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              <ThumbtackIcon className="w-3.5 h-3.5" />
              Pinned
            </div>
          )}

          {/* Replying to header - only for actual replies (not quotes or recaws) */}
          {item.parent && !isRecaw && !isQuote && item.parent.user && !hideParentPreview && (
            item.parent.status === 'HIDDEN' ? (
              <div className={`block text-xs mb-3 italic ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                {t('post.replying_to_removed')}
              </div>
            ) : (() => {
              // Strip the poll marker out of the snippet so the user doesn't
              // see raw `::poll:...::` text. The PollMiniResults block below
              // shows the same poll's results in a compact form.
              let parentBody = stripPollMarker(item.parent.content || '')
              // Pick the parent's first piece of media for a thumbnail
              // preview, in priority: image → video poster → Giphy still
              // (resolved via short URL when needed). The picker also
              // scrubs the lifted GIF URL out of parentBody so the snippet
              // doesn't render the raw URL alongside the thumbnail.
              const picked = pickCawThumbnail(item.parent as CawThumbnailSource, parentBody)
              const parentThumb = picked.thumb
              parentBody = picked.body
              return (
                <Link to={cawUrl(item.parent)} state={{ caw: item.parent }} className={`block text-xs transition-all duration-300 mb-3 ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  <span className="truncate md:truncate-none">{t('post.replying_to')} <span className="underline">@{item.parent.user.username}</span></span>
                  {(parentBody || parentThumb || item.parent.poll) && (
                    <span className="flex items-start gap-2 mt-1">
                      {parentThumb && (
                        <CawThumbnail
                          thumb={parentThumb}
                          wrapperClass={`relative flex-shrink-0 mt-1 rounded overflow-hidden ${item.parent!.poll ? 'w-20 h-20' : 'w-16 h-16'}`}
                        />
                      )}
                      <span className="flex-1 min-w-0 flex flex-col gap-1.5">
                        {parentBody && (
                          <span className={`text-[11px] leading-snug line-clamp-2 ${
                            isDark ? 'text-white/25' : 'text-gray-400'
                          }`}>
                            {parentBody}
                          </span>
                        )}
                        {item.parent.poll && (
                          <span className="block">
                            <PollMiniResults poll={item.parent.poll} />
                          </span>
                        )}
                      </span>
                    </span>
                  )}
                </Link>
              )
            })()
          )}

          {/* Recawed header */}
          {headline && (
            <div className="text-xs font-medium mb-3 transition-all duration-300 text-yellow-500 inline-flex items-center gap-1.5">
              <Recaw className="w-3.5 h-3.5" />
              <span>{headline}</span>
            </div>
          )}

          {/* Content wrapper with left padding for replies - applies when isReply OR when it has a parent (reply in main feed), but NOT for recaws or quotes */}
          <div className={`relative ${(isReply || (item.parent && !isRecaw && !isQuote) || inThread) ? 'pl-6' : ''}`}>
            {/* Vertical line for replies */}
            {showReplyRail && (isReply || (item.parent && !isRecaw && !isQuote)) && (
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
          <div className={`flex justify-between mb-3 ${isReply ? 'items-start' : 'items-center'} ${inThread ? 'max-md:-ml-4 -ml-2' : ''}`}>
            <div className="flex items-center space-x-3">
              {/* Avatar */}
              <Link
                to={`/users/${useItem.user.username}`}
                className={`relative z-10 w-10 h-10 rounded-full cursor-pointer overflow-hidden border border-gray-700 ${inThread ? (isDark ? 'bg-black' : 'bg-white') : ''}`}
              >
                <Avatar
                  src={getUserAvatar(useItem.user)}
                  fallbackSrc={getDefaultAvatarForUser(useItem.user)}
                  alt={`${useItem.user.username} avatar`}
                  className="w-full h-full rounded-full hover:opacity-80 transition-opacity duration-200"
                  size="small"
                />
              </Link>
              
              {/* User info */}
              <div className="flex-1">
                <div>
                  {/* Inline translate / translated status (same spot).
                      Hidden when we know the source matches the viewer's
                      language (no value to user); shown otherwise so the
                      first viewer can populate the source-language cache. */}
                  {!isTranslating && useItem.content?.trim() && (translatedText || shouldShowInlineTranslate) && (
                    translatedText ? (
                      <div className="mb-1 flex items-center justify-between gap-2 min-w-0">
                        <span className={`min-w-0 truncate text-xs ${isDark ? 'text-gray-500' : 'text-gray-500'}`}>
                          {knownSourceLanguage && knownSourceLanguage !== 'auto'
                            ? t('post.translated_from', { language: languageName(knownSourceLanguage) })
                            : t('post.translated_from_original')}
                        </span>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setTranslatedText(null)
                          }}
                          className="inline-flex shrink-0 items-center gap-1 text-xs text-yellow-500/80 hover:text-yellow-500 transition-colors cursor-pointer"
                        >
                          <HiOutlineTranslate className="w-3.5 h-3.5" />
                          {t('post.show_original')}
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          void handleMenuAction('translate')
                        }}
                        className="mb-1 inline-flex items-center gap-1 text-xs text-yellow-500/80 hover:text-yellow-500 transition-colors cursor-pointer"
                      >
                        <HiOutlineTranslate className="w-3.5 h-3.5" />
                        {t('post.translate')}
                      </button>
                    )
                  )}

                  {/* First line: Display name, username, time, and status badges */}
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-0.5">
                    <UserHoverCard username={useItem.user.username}>
                      <Link
                        to={`/users/${useItem.user.username}`}
                        className={`font-semibold transition-colors duration-300 cursor-pointer hover:underline ${
                          isDark ? 'text-white' : 'text-black'
                        }`}
                      >
                        {useItem.user.displayName || useItem.user.username}
                      </Link>
                    </UserHoverCard>
                    <XBadge xHandle={useItem.user.xHandle} xFollowerBucket={useItem.user.xFollowerBucket} />

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
                    {item.status === 'FAILED' && (
                      <div className="flex flex-wrap items-center gap-1">
                        <span className="relative group">
                          <span className="px-2 py-0.5 text-xs bg-red-500/20 text-red-600 dark:text-red-400 rounded-full cursor-help">
                            {t('post.failed')}
                          </span>
                          <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-50 bg-white text-black dark:bg-white dark:text-black">
                            {t('post.failed_tooltip')}
                            <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-white"></span>
                          </span>
                        </span>
                      <button
                        onClick={handleRetry}
                        disabled={isRetrying}
                        className="px-2 py-0.5 text-xs bg-blue-500/20 text-blue-600 dark:text-blue-400 rounded-full hover:bg-blue-500/30 transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <HiOutlineRefresh className={`w-3 h-3 ${isRetrying ? 'animate-spin' : ''}`} />
                        {isRetrying ? t('post.retrying') : t('post.retry')}
                      </button>
                      <button
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          setRetrySucceeded(true)
                          apiFetch(`/api/caws/${item.id}/dismiss`, { method: 'POST' }).catch(() => {})
                        }}
                        className="px-2 py-0.5 text-xs bg-gray-500/20 text-gray-500 dark:text-gray-400 rounded-full hover:bg-gray-500/30 transition-colors flex items-center gap-1 cursor-pointer"
                      >
                        <HiOutlineX className="w-3 h-3" />
                        {t('post.hide')}
                      </button>
                    </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Three dots menu */}
            <div className="relative" ref={optionsMenuRef}>
              <Tooltip text={t('post.more_options')}><button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  handleOptionsClick(e)
                }}
                className={`p-2 rounded-full transition-all duration-200 hover:bg-gray-500/10 cursor-pointer ${
                  isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
                }`}
              >
                <HiOutlineDotsHorizontal className="w-5 h-5" />
              </button></Tooltip>
            </div>
          </div>

          {/* Post Content */}
          {isTranslating ? (
            <div className={`mb-4 ${inThread ? 'pl-10' : 'pl-2 md:pl-0'} ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 border-2 border-gray-400 border-t-blue-500 rounded-full animate-spin"></div>
                <span className="text-sm">{t('post.translating')}</span>
              </div>
            </div>
          ) : translatedText ? (
            <div className={`mb-4 ${inThread ? "pl-10" : "pl-2 md:pl-0"}`}>
              <ContentWithHashtags
                content={stripPollMarker(translatedText)}
                postId={useItem.id}
                renderMedia={!hideMedia}
                className={`transition-colors duration-300 ${
                  isDark ? 'text-gray-200' : 'text-gray-800'
                } ${contentClassName || ''}`}
              />
            </div>
          ) : (
            <div className={`mb-4 ${inThread ? "pl-10" : "pl-2 md:pl-0"}`}>
              <ContentWithHashtags
                content={stripPollMarker(useItem.content)}
                postId={useItem.id}
                renderMedia={!hideMedia}
                className={`transition-colors duration-300 ${
                  isDark ? 'text-gray-200' : 'text-gray-800'
                } ${contentClassName || ''}`}
              />
            </div>
          )}

          {/* Poll widget — renders only when the API returned poll data,
              which only happens when a ::poll:...:: marker survived the
              indexer round-trip and got promoted into a Poll row. */}
          {useItem.poll && (
            <div className={`mb-4 ${inThread ? "pl-10" : "pl-2 md:pl-0"}`}>
              <PollDisplay caw={useItem} optionLabelsOverride={translatedText ? translatedPollOptions : null} />
            </div>
          )}

          {/* Video Display */}
          {!hideMedia && useItem.hasVideo && (
            <div className={`mb-4 ${inThread ? "pl-10" : "pl-2 md:pl-0"}`}>
              {(() => {
                // Check if videoData contains URLs
                if (useItem.videoData) {
                  // Videos stored as URLs (always off-chain)
                  const videoUrls = useItem.videoData.split('|||')
                  return (
                    <div className="grid grid-cols-1 gap-2 w-full">
                      {videoUrls.map((url, index) => (
                        <div key={index} className="relative rounded-lg overflow-hidden">
                          <PostVideo url={url} />
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
          {!hideMedia && useItem.hasImage && (
            <div className={`mb-4 ${inThread ? "pl-10" : "pl-2 md:pl-0"}`}>
              {(() => {
                // Check if imageData contains URLs or base64 data
                if (useItem.imageData) {
                  if (useItem.imageData.startsWith('urls:')) {
                    // Off-chain images stored as URLs
                    const urls = useItem.imageData.replace('urls:', '').split('|||')
                    return (
                      <div>
                        {(() => {
                          const count = urls.length
                          if (count <= 0) return null

                          if (count === 1) {
                            const url = urls[0]
                            return (
                              <div className="relative rounded-lg overflow-hidden w-full">
                                <img
                                  src={url}
                                  alt="Caw image"
                                  className="block max-w-full max-h-96 w-auto h-auto mx-auto cursor-pointer hover:opacity-90 transition-opacity"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    openPostMedia(useItem, 0)
                                  }}
                                  onError={(e) => {
                                    console.error('Failed to load image from URL:', url)
                                    e.currentTarget.style.display = 'none'
                                  }}
                                />
                              </div>
                            )
                          }

                          const gridClass =
                            count === 2
                                ? 'grid grid-cols-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
                                : count === 3
                                  ? 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
                                  : 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'

                          const cellClass = (i: number) =>
                            count === 3 && i === 0 ? 'row-span-2 w-full h-full' : 'w-full h-full'

                          return (
                            <div className={gridClass}>
                              {urls.slice(0, 4).map((url, index) => (
                                <div key={index} className={`relative w-full h-full overflow-hidden ${cellClass(index)}`}>
                                  <img
                                    src={url}
                                    alt={`Caw image ${index + 1}`}
                                    className="block w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                    onClick={(e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      openPostMedia(useItem, index)
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
                        })()}
                      </div>
                    )
                  } else {
                    // On-chain images stored as base64
                    const images = useItem.imageData.split('|||')
                    return (
                      <div>
                        {(() => {
                          const count = images.length
                          if (count <= 0) return null

                          if (count === 1) {
                            const imageBase64 = images[0]
                            return (
                              <div className="relative rounded-lg overflow-hidden w-full">
                                <img
                                  src={`data:image/jpeg;base64,${imageBase64}`}
                                  alt="Caw image"
                                  className="block max-w-full max-h-96 w-auto h-auto mx-auto cursor-pointer hover:opacity-90 transition-opacity"
                                  onClick={(e) => {
                                    e.preventDefault()
                                    e.stopPropagation()
                                    openPostMedia(useItem, 0)
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
                            )
                          }

                          const gridClass =
                            count === 2
                                ? 'grid grid-cols-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
                                : count === 3
                                  ? 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'
                                  : 'grid grid-cols-2 grid-rows-2 gap-1.5 aspect-video rounded-lg overflow-hidden'

                          const cellClass = (i: number) =>
                            count === 3 && i === 0 ? 'row-span-2 w-full h-full' : 'w-full h-full'

                          return (
                            <div className={gridClass}>
                              {images.slice(0, 4).map((imageBase64, index) => (
                                <div key={index} className={`relative w-full h-full overflow-hidden ${cellClass(index)}`}>
                                  <img
                                    src={`data:image/jpeg;base64,${imageBase64}`}
                                    alt={`Caw image ${index + 1}`}
                                    className="block w-full h-full object-cover cursor-pointer hover:opacity-90 transition-opacity"
                                    onClick={(e) => {
                                      e.preventDefault()
                                      e.stopPropagation()
                                      openPostMedia(useItem, index)
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
                        })()}
                      </div>
                    )
                  }
                } else if (useItem.imageUrl) {
                  // Legacy single image URL
                  return (
                    <div className="w-full rounded-lg overflow-hidden">
                      <img
                        src={useItem.imageUrl}
                        alt="Caw image"
                        className="block max-w-full max-h-96 w-auto h-auto mx-auto cursor-pointer hover:opacity-90 transition-opacity"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          openPostMedia(useItem, 0)
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

          {/* Quoted post embed */}
          {isQuote && item.parent && item.parent.user && (() => {
            const isHidden = item.parent.status === 'HIDDEN'
            const Wrapper: any = isHidden ? 'div' : Link
            const wrapperProps: any = isHidden
              ? { onClick: (e: React.MouseEvent) => e.stopPropagation() }
              : { to: cawUrl(item.parent), onClick: (e: React.MouseEvent) => e.stopPropagation() }
            return (
              <Wrapper
                {...wrapperProps}
                className={`block mt-3 mb-3 rounded-xl border p-3 transition-colors ${
                  isHidden
                    ? isDark ? 'border-white/10 bg-white/[0.02]' : 'border-gray-200 bg-gray-50'
                    : isDark ? 'border-white/10 bg-white/[0.02] hover:bg-white/[0.04]' : 'border-gray-200 bg-gray-50 hover:bg-gray-100'
                }`}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <Avatar
                    src={getUserAvatar(item.parent.user)}
                    fallbackSrc={getDefaultAvatarForUser(item.parent.user)}
                    className="w-5 h-5 rounded-full border border-gray-700"
                    size="small"
                  />
                  <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {item.parent.user.displayName || item.parent.user.username}
                  </span>
                  <XBadge xHandle={item.parent.user.xHandle} xFollowerBucket={item.parent.user.xFollowerBucket} />
                  <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    @{item.parent.user.username}
                  </span>
                </div>
                {isHidden ? (
                  <div className={`text-sm italic ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    The content of this post has been removed by the poster
                  </div>
                ) : (() => {
                  const parentBody = stripPollMarker(item.parent!.content || '')
                  return (
                    <>
                      {parentBody && (
                        <div className={`text-sm line-clamp-3 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                          <ContentWithHashtags content={parentBody} />
                        </div>
                      )}
                      {item.parent!.poll && (
                        <div className="mt-2">
                          <PollMiniResults poll={item.parent!.poll} />
                        </div>
                      )}
                    </>
                  )
                })()}
              </Wrapper>
            )
          })()}

          {/* Post Actions */}
          <div className={`flex items-center justify-between ${inThread ? 'max-md:pl-4 pl-10' : ''}`} onClick={(e) => e.stopPropagation()}>
            <div className={`flex items-center ${uiDensity === 'compact' ? 'gap-4' : 'space-x-6'}`}>
              {/* Comments/Replies */}
              <Tooltip text={replyPending ? t('post.processing') : t('post.reply')} disabled={item.status === 'FAILED'}><button
                className={`flex items-center space-x-2 transition-colors duration-300 ${
                  (item.status === 'FAILED')
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:text-blue-500 cursor-pointer'
                } ${
                  (useItem.hasReplied || replyPending)
                    ? `text-blue-500 ${replyPending ? 'opacity-90' : ''}`
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={handleReply}
                disabled={item.status === 'FAILED'}
              >
                <HiOutlineChat className={uiDensity === 'compact' ? 'w-4 h-4' : 'w-5 h-5'} />
                <span className={`${uiDensity === 'compact' ? 'text-xs' : 'text-sm'} ${(useItem.hasReplied || replyPending) ? 'text-blue-500' : ''}`}>
                  {formatEngagementCount(useItem.commentCount + effectiveReplyAdj)}
                </span>
              </button></Tooltip>

              {/* Retweets */}
              <div className="relative">
                <Tooltip text={recawPending ? t('post.processing') : t('post.recaw')} disabled={item.status === 'FAILED'}><button
                  className={`group flex items-center space-x-2 transition-colors duration-300 ${
                    (item.status === 'FAILED')
                      ? 'cursor-not-allowed opacity-50'
                      : 'hover:text-green-500 cursor-pointer'
                  } ${
                    (useItem.hasRecawed || isRecawByCurrentUser || recawPending)
                      ? `text-green-500 ${recawPending ? 'opacity-90' : ''}`
                      : isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}
                  onClick={e => {
                    e.preventDefault();
                    e.stopPropagation();
                    // Recaws of a PENDING parent are valid — the on-chain
                    // action keys off (receiverId, receiverCawonce), both
                    // known at sign-time, so it doesn't matter that the
                    // parent isn't mined yet.
                    if (item.status !== 'FAILED') {
                      setShowRecawMenu(show => !show)
                    }
                  }}
                  disabled={item.status === 'FAILED'}
                >
                  {busyRecaw ? (
                    <div className="relative w-5 h-5">
                      <div className="w-5 h-5 border-2 border-gray-400 border-t-green-500 rounded-full animate-spin"></div>
                      <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-green-500" />
                    </div>
                  ) : (
                    <Recaw className={`${uiDensity === 'compact' ? 'w-4 h-4 translate-y-[3px]' : 'w-5 h-5 translate-y-1'} transition-all duration-300 ${
                      (useItem.hasRecawed || isRecawByCurrentUser || recawPending) ? 'text-green-500' : ''
                    }`} />
                  )}
                  <span className={`${uiDensity === 'compact' ? 'text-xs translate-y-0.5' : 'text-sm translate-y-1'} transition-colors duration-300 ${
                    (useItem.hasRecawed || isRecawByCurrentUser) ? 'text-green-500' : ''
                  }`}>{formatEngagementCount(useItem.recawCount + effectiveRecawAdj)}</span>
                </button></Tooltip>

                {showRecawMenu && (
                  <div
                    ref={menuRef}
                    className={`absolute z-30 text-bold rounded-xl p-3 space-y-1 whitespace-nowrap ${
                      isDark
                        ? 'text-white border border-white/10 shadow-[0_4px_24px_rgba(255,255,255,0.12)]'
                        : 'text-black border border-gray-200 shadow-lg'
                    }`}
                    style={{ left: '-3px', bottom: 'calc(100% + 4px)', backgroundColor: isDark ? '#000' : '#fff', opacity: 1 }}
                  >
                    {(useItem.hasRecawed || isRecawByCurrentUser || recawPending) ? (
                      <button
                        className={`flex items-center gap-2 px-3 py-2 cursor-pointer rounded-lg transition-all duration-200 ${
                          isDark ? 'hover:bg-gray-800 text-red-400' : 'hover:bg-red-50 text-red-600'
                        }`}
                        onClick={async e => {
                          e.preventDefault(); e.stopPropagation(); setShowRecawMenu(false)
                          const effectiveTokenId = activeTokenId || activeToken?.tokenId
                          if (!effectiveTokenId) return

                          // Fast-path: the recaw is still pending (validator
                          // hasn't picked it up). Cancel the original tx queue
                          // entry instead of firing a second on-chain hide:recaw
                          // that would double-spend. On 409 (lost the race) we
                          // fall through to the hide-action path below.
                          //
                          // Tear down the pending UI synchronously so the
                          // "−X CAW pending" line snaps back at click time;
                          // restore it on a 409.
                          if (pendingRecawTxQueueId) {
                            setBusyRecaw(true)
                            const cancelledTxQueueId = pendingRecawTxQueueId
                            const snapshotSpend = usePendingSpendStore.getState().pendingByTxQueue[cancelledTxQueueId]
                            setRecawPending(false)
                            setRecawCountAdj(0)
                            setRecawCountBase(null)
                            usePendingSpendStore.getState().removePendingSpend(cancelledTxQueueId)
                            useBalanceChangeStore.getState().dropPendingWindow(`txq:${cancelledTxQueueId}`)
                            setPendingRecawTxQueueId(null)
                            if (onRecawStateChange) onRecawStateChange(useItem.id, false)
                            try {
                              await apiFetch(`/api/txqueue/${cancelledTxQueueId}/cancel`, { method: 'POST' })
                              setBusyRecaw(false)
                              return
                            } catch (err: any) {
                              if (!String(err?.message || '').includes('409')) {
                                console.error('Cancel recaw failed', err)
                                setBusyRecaw(false)
                                return
                              }
                              // 409: validator already picked it up. Restore
                              // the pending spend (the action will confirm),
                              // and continue into the hide-action branch
                              // below — the recaw will land and we need to
                              // undo it on-chain.
                              if (snapshotSpend && snapshotSpend > 0n) {
                                usePendingSpendStore.getState().addPendingSpend(cancelledTxQueueId, snapshotSpend, effectiveTokenId)
                              }
                            }
                          }

                          // Optimistically hide the viewer's own recaw row in any
                          // feed they're currently looking at (their profile is
                          // the obvious one). Indexer deletes the recaw row in
                          // 5–60s; without this it lingers on the profile until
                          // refresh. Mirrors the delete-post optimistic hide.
                          if (useItem.user?.tokenId != null && useItem.cawonce != null) {
                            useHiddenCawsStore.getState().hideRecaw(
                              Number(effectiveTokenId),
                              Number(useItem.user.tokenId),
                              Number(useItem.cawonce),
                            )
                          }
                          try {
                            setBusyRecaw(true)
                            await signAndSubmit({
                              actionType: 'other',
                              senderId: effectiveTokenId,
                              receiverId: 0,
                              receiverCawonce: 0,
                              text: `hide:recaw:${useItem.user.tokenId}:${useItem.cawonce}`,
                            })
                          } catch (err) {
                            console.warn('Undo recaw failed:', err)
                          } finally {
                            setRecawPending(false)
                            setRecawCountAdj(-1)
                            setRecawCountBase(useItem.recawCount)
                            if (onRecawStateChange) onRecawStateChange(useItem.id, false)
                            setBusyRecaw(false)
                          }
                        }}
                      >
                        <Recaw className="w-5 h-5 translate-y-0.5" /> {t('post.undo_repost')}
                      </button>
                    ) : (
                      <button
                        className={`flex items-center gap-2 px-3 py-2 cursor-pointer rounded-lg transition-all duration-200 ${
                          isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                        }`}
                        onClick={e => { e.preventDefault(); e.stopPropagation(); setShowRecawMenu(false); handleRecaw(e) }}
                      >
                        <Recaw className={`w-5 h-5 translate-y-0.5 transition-all duration-300 ${
                          isDark ? 'text-white' : 'text-gray-600'
                        }`} /> {t('post.repost')}
                      </button>
                    )}
                    <button
                      className={`flex items-center gap-2 px-3 py-2 cursor-pointer rounded-lg transition-all duration-200 ${
                        isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'
                      }`}
                      onClick={e => {
                        e.preventDefault(); e.stopPropagation(); setShowRecawMenu(false);
                        openModal('quote', useItem, () => {
                          setRecawPending(true)
                          if (onRecawStateChange) onRecawStateChange(useItem.id, true)
                        })
                      }}
                    >
                      <Pencil className={`w-5 h-5 transition-all duration-300 ${
                        isDark ? 'fill-white' : 'fill-gray-600'
                      }`}/> {t('post.quote')}
                    </button>
                  </div>
                )}
              </div>

              {/* Likes */}
              {(() => {
                // Resolution order for the heart-fill:
                //  1. In-component override (just-clicked, no server response yet)
                //  2. Server's confirmed hasLiked
                //  3. Server's likePendingAction — if a like/unlike is in flight
                //     (e.g. after a refresh, when the override is gone) we should
                //     still render the optimistic direction. Without this, the
                //     heart un-fills on every refresh until the action confirms.
                let effectiveHasLiked: boolean
                if (likeOverride !== null && likeOverride !== useItem.hasLiked) {
                  effectiveHasLiked = likeOverride
                } else if (useItem.likePending && useItem.likePendingAction) {
                  effectiveHasLiked = useItem.likePendingAction === 'LIKE'
                } else {
                  effectiveHasLiked = useItem.hasLiked
                }
                return (
              <Tooltip
                text={
                  (likePending || stateSource.likePending)
                    ? (pendingLikeTxQueueId
                        ? (useItem.hasLiked ? t('post.cancel_unlike') : t('post.cancel_like'))
                        : t('post.processing'))
                    : t('post.like')
                }
                disabled={item.status === 'FAILED'}
              ><button
                className={`flex items-center space-x-2 transition-colors duration-300 ${
                  (item.status === 'FAILED')
                    ? 'cursor-not-allowed opacity-50'
                    : 'hover:text-red-500 cursor-pointer'
                } ${
                  effectiveHasLiked
                    ? `text-red-500 ${(likePending || stateSource.likePending) ? 'opacity-90' : ''}`
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
                onClick={(e) => {
                  // While a like is in-flight (we still hold its
                  // txQueueId), tapping the heart cancels instead of
                  // being inert. Useful for accidental likes — the
                  // validator polls every couple of seconds, so the
                  // window is generous.
                  if (likePending && pendingLikeTxQueueId) {
                    e.preventDefault()
                    e.stopPropagation()
                    handleCancelLike()
                    return
                  }
                  handleLike(e)
                }}
                disabled={busyLike || (likePending && !pendingLikeTxQueueId) || item.status === 'FAILED'}
              >
                {busyLike ? (
                  <div className="relative w-5 h-5">
                    <div className="w-5 h-5 border-2 border-gray-400 border-t-red-500 rounded-full animate-spin"></div>
                    <HiOutlineCheck className="absolute inset-0 w-3 h-3 m-auto text-red-500" />
                  </div>
                ) : (
                  <HiOutlineHeart className={`${uiDensity === 'compact' ? 'w-4 h-4' : 'w-5 h-5'} ${effectiveHasLiked ? 'fill-current' : ''}`} />
                )}
                <span className={uiDensity === 'compact' ? 'text-xs' : 'text-sm'}>{formatEngagementCount(useItem.likeCount + effectiveLikeAdj)}</span>
              </button></Tooltip>
                )
              })()}

              {/* Views */}
              <Tooltip text={t('post.views')}><button
                className={`flex items-center space-x-2 transition-colors duration-300 cursor-pointer ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
              >
                <HiOutlineEye className={uiDensity === 'compact' ? 'w-4 h-4' : 'w-5 h-5'} />
                <span className={uiDensity === 'compact' ? 'text-xs' : 'text-sm'}>{formatEngagementCount(useItem.viewCount || 0)}</span>
              </button></Tooltip>
            </div>

            <div className={`flex items-center ${uiDensity === 'compact' ? 'gap-3' : 'space-x-4'}`}>
              {/* Bookmark */}
              <Tooltip text={isBookmarked ? t('post.remove_bookmark') : t('post.save')} disabled={item.status === 'FAILED'}><button
                onClick={handleBookmark}
                disabled={item.status === 'FAILED'}
                className={`flex items-center gap-1 transition-colors duration-300 ${
                  (item.status === 'FAILED')
                    ? 'opacity-50 cursor-default'
                    : 'hover:text-yellow-500 cursor-pointer'
                } ${
                  isBookmarked
                    ? 'text-yellow-500'
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
              >
                <Bookmark className={`${uiDensity === 'compact' ? 'w-4 h-4 -translate-y-[2px]' : 'w-5 h-5 -translate-y-[3px]'} transition-all duration-300 ${
                  isBookmarked
                    ? 'fill-yellow-500 stroke-yellow-500'
                    : isDark ? 'stroke-white stroke-[1.5]' : 'stroke-gray-600'
                }`} />
                {localBookmarkCount > 0 && (
                  <span className={`${uiDensity === 'compact' ? 'text-[11px] -translate-y-[2px]' : 'text-xs -translate-y-[3px]'}`}>{localBookmarkCount}</span>
                )}
              </button></Tooltip>

              {/* Tip — hidden when the post author is the signed-in user,
                  since tipping yourself is a no-op. */}
              {useItem.user.tokenId !== (activeTokenId || activeToken?.tokenId) && (
              <Tooltip text={tipPending ? t('post.processing') : useItem.totalTipAmount ? t('post.tipped', { amount: (useItem.totalTipAmount).toLocaleString() }) : t('post.tip')} disabled={item.status === 'FAILED'}><button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setShowTipModal(true)
                }}
                disabled={item.status === 'FAILED'}
                className={`flex items-center gap-1 transition-colors duration-300 ${
                  (item.status === 'FAILED')
                    ? 'opacity-50 cursor-default'
                    : 'hover:text-yellow-500 cursor-pointer'
                } ${
                  (tipPending || useItem.hasTipped)
                    ? `text-yellow-500 ${tipPending ? 'opacity-90' : ''}`
                    : isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
              >
                <HiOutlineCurrencyDollar className={`${uiDensity === 'compact' ? 'w-4 h-4 mb-[4px]' : 'w-5 h-5 mb-[5px]'}`} />
                {(useItem.tipCount ?? 0) > 0 && (
                  <span className={`${uiDensity === 'compact' ? 'text-[11px] -translate-y-[2px]' : 'text-xs -translate-y-[3px]'}`}>{useItem.tipCount}</span>
                )}
              </button></Tooltip>
              )}

              {/* Share */}
              <Tooltip text={t('post.share')} disabled={item.status === 'FAILED'}><button
                onClick={(e) => {
                  e.preventDefault()
                  e.stopPropagation()
                  setShowShareModal(true)
                }}
                disabled={item.status === 'FAILED'}
                className={`transition-colors duration-300 ${
                  (item.status === 'FAILED')
                    ? 'opacity-50 cursor-default'
                    : 'hover:text-blue-500 cursor-pointer'
                } ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}
              >
                <Share className={`${uiDensity === 'compact' ? 'w-4 h-4' : 'w-5 h-5'} transition-all duration-300 ${
                  isDark ? 'stroke-white stroke-[1.5]' : 'stroke-gray-600'
                }`} />
              </button></Tooltip>
            </div>
          </div>

          {/* Wrong wallet error message */}
          {wrongWalletError && (
            <div className="mt-2 rounded-md overflow-hidden bg-black">
              <div className={`px-4 py-2 text-sm rounded-md transition-all duration-300 text-error-dim ${
                isDark
                  ? 'bg-red-900/20 border border-red-800'
                  : 'bg-red-50 border border-red-200'
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
                {t('post.translate')}
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
                    <span className="text-green-500">{t('post.copied')}</span>
                  </>
                ) : (
                  <>
                    <HiOutlineClipboard className="w-5 h-5" />
                    {t('post.copy_text')}
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
                {t('post.menu.mute_thread')}
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
                {t('post.menu.mute_words')}
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
                {t('post.menu.hide_post')}
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
                {t('post.menu.mute_account')}
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
                {t('post.menu.block_account')}
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
                {t('post.menu.report')}
              </button>

              {/* Moderator-only actions: hide-as-mod. Visible to anyone
                  with role MODERATOR or ADMIN, on caws they don't own
                  (owners use the regular delete affordance below). */}
              {isModerator && useItem.user.tokenId !== (activeTokenId || activeToken?.tokenId) && useItem.status !== 'HIDDEN' && (
                <>
                  <div className={`border-t my-1 ${
                    isDark ? 'border-white/20' : 'border-gray-200'
                  }`}></div>
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setShowOptionsMenu(false)
                      handleModHide()
                    }}
                    className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                      isDark ? 'hover:bg-white/10 text-amber-400' : 'hover:bg-amber-50 text-amber-700'
                    }`}
                  >
                    <HiOutlineShieldCheck className="w-5 h-5" />
                    Hide as moderator
                  </button>
                </>
              )}

              {/* Owner-only actions: pin and delete. Top-level posts only
                  (no recaws / replies) — Twitter parity, plus pinning a
                  recaw is awkward semantically. */}
              {useItem.user.tokenId === (activeTokenId || activeToken?.tokenId) && useItem.cawonce != null && (
                <>
                  <div className={`border-t my-1 ${
                    isDark ? 'border-white/20' : 'border-gray-200'
                  }`}></div>
                  {useItem.action !== 'RECAW' && !useItem.parent && (() => {
                    // Cap UX: greyed out at 3/3 unless this post is one of
                    // the pinned (in which case the menu shows "Unpin").
                    // Read pinnedCawCount from the active user's by-token
                    // payload — server-maintained, so it stays accurate
                    // across sessions and refreshes.
                    const PIN_CAP = 3
                    const myPinCount = (currentUserData as any)?.pinnedCawCount ?? 0
                    const isThisPinned = !!item.isPinned
                    const atCap = !isThisPinned && myPinCount >= PIN_CAP
                    return (
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          if (atCap) return
                          handlePinClick()
                        }}
                        disabled={atCap}
                        className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 ${
                          atCap
                            ? `cursor-not-allowed ${isDark ? 'text-white/30' : 'text-gray-400'}`
                            : `cursor-pointer ${isDark ? 'hover:bg-white/10 text-white' : 'hover:bg-gray-100 text-black'}`
                        }`}
                      >
                        <ThumbtackIcon className="w-5 h-5" />
                        <span className="flex-1">
                          {isThisPinned ? t('post.menu.unpin') : t('post.menu.pin')}
                        </span>
                        {!isThisPinned && (
                          <span className={`text-xs ${atCap ? '' : isDark ? 'text-white/40' : 'text-gray-400'}`}>
                            {myPinCount}/{PIN_CAP}
                          </span>
                        )}
                      </button>
                    )
                  })()}
                  <button
                    onMouseDown={(e) => {
                      e.preventDefault()
                      e.stopPropagation()
                      setShowOptionsMenu(false)
                      setShowDeleteConfirm(true)
                    }}
                    className={`w-full px-4 py-3 text-left text-sm transition-colors duration-200 flex items-center gap-3 cursor-pointer ${
                      isDark ? 'hover:bg-white/10 text-red-400' : 'hover:bg-red-50 text-red-600'
                    }`}
                  >
                    <HiOutlineTrash className="w-5 h-5" />
                    {t('post.menu.delete')}
                  </button>
                </>
              )}
            </div>
          </div>
        </>,
        document.body
      )}

      {/* Share Modal */}
      <ShareModal
        isOpen={showShareModal}
        onClose={() => setShowShareModal(false)}
        url={cawUrl(useItem)}
        title={`${useItem.user?.displayName || '@' + useItem.user?.username}'s caw`}
        text={useItem.content}
      />

      {/* Tip Modal */}
      <TipModal
        isOpen={showTipModal}
        recipientTokenId={useItem.user.tokenId}
        recipientUsername={useItem.user.username}
        cawUserId={useItem.user.tokenId}
        cawCawonce={useItem.cawonce}
        onClose={() => setShowTipModal(false)}
        onTipSubmitted={() => {
          setTipPending(true)
          onTipStateChange?.(item.id, true)
        }}
      />

      {/* Mute Words Modal */}
      <MuteWordsModal
        isOpen={showMuteWordsModal}
        onClose={() => setShowMuteWordsModal(false)}
        postContent={useItem.content}
        existingMutedWords={getJSON<string[]>('mutedWords', [])}
        onMute={(words) => {
          const mutedWords = getJSON<string[]>('mutedWords', [])
          mutedWords.push(...words)
          setJSON('mutedWords', [...new Set(mutedWords)])
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
              const hiddenPosts = getJSON<string[]>('hiddenPosts', [])
              hiddenPosts.push(useItem.id)
              setJSON('hiddenPosts', [...new Set(hiddenPosts)])
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
              const mutedAccounts = getJSON<number[]>('mutedAccounts', [])
              mutedAccounts.push(useItem.user.tokenId)
              setJSON('mutedAccounts', [...new Set(mutedAccounts)])
              window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
              // Sync to server for notification filtering
              const muteTokenId = activeTokenId || activeToken?.tokenId
              if (muteTokenId) {
                apiFetch(`/api/notifications/mute-account/${useItem.user.tokenId}`, {
                  method: 'POST',
                  headers: { 'x-user-id': muteTokenId.toString() }
                }).catch(err => console.error('Failed to sync mute to server:', err))
              }
              break
            }
            case 'block-account': {
              // Block already executed in handleMenuAction — modal is just confirmation
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
        postAuthorId={useItem.user.tokenId}
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
              postAuthorId: useItem.user.tokenId,
              reason,
              details: details || undefined
            })
          })

          // Also store locally so we can hide it from the user's feed
          const reportedPosts = getJSON<Array<{postId: string; userId: number; reason: string; timestamp: string}>>('reportedPosts', [])
          reportedPosts.push({
            postId: useItem.id,
            userId: useItem.user.tokenId,
            reason,
            timestamp: new Date().toISOString()
          })
          setJSON('reportedPosts', reportedPosts)
          window.dispatchEvent(new CustomEvent('mutePreferencesChanged'))
        }}
      />

      {/* Delete Post Confirmation */}
      <ConfirmModal
        isOpen={showDeleteConfirm}
        onClose={() => setShowDeleteConfirm(false)}
        title={t('post.delete_confirm.title')}
        message={t('post.delete_confirm.message')}
        confirmText={t('post.delete_confirm.confirm')}
        destructive
        onConfirm={async () => {
          const effectiveTokenId = activeTokenId || activeToken?.tokenId
          if (!effectiveTokenId || !useItem.cawonce) return
          // Optimistically hide before submitting so the deleter sees the
          // post disappear immediately. The on-chain hide takes 5–60s to
          // index; without this, the post stays visible to them in that
          // window. Indexer-side hide eventually filters server responses
          // too, so the optimistic entry becomes redundant.
          useHiddenCawsStore.getState().hideCaw(Number(effectiveTokenId), Number(useItem.cawonce))
          try {
            await signAndSubmit({
              actionType: 'other',
              senderId: effectiveTokenId,
              receiverId: 0,
              receiverCawonce: 0,
              text: `hide:caw:${useItem.cawonce}`,
            })
          } catch (err) {
            console.error('Delete post failed:', err)
          }
        }}
      />

      {/* Pin choice modal — only shown when QuickSign isn't active for
          OTHER. Two buttons: "Pin on chain" (mints an OTHER action and
          pays the OTHER cost, same as profile updates) or "Pin off chain
          only" (DB-only, no wallet popup). */}
      <ModalWrapper
        isOpen={showPinChoice}
        onClose={() => setShowPinChoice(false)}
        maxWidth="max-w-sm"
        zIndex={80}
        usePortal
        backdropClass="bg-black/60"
      >
        <div className="p-5">
          <h3 className={`text-lg font-semibold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('post.pin_choice.title')}
          </h3>
          <p className={`text-sm mb-4 ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
            {t('post.pin_choice.description')}
          </p>
          <div className="flex flex-col gap-2">
            <button
              onClick={() => {
                setShowPinChoice(false)
                submitPinAction('pin', true)
              }}
              className="w-full py-2 rounded-lg bg-yellow-500 hover:bg-yellow-600 text-black font-semibold text-sm cursor-pointer"
            >
              {t('post.pin_choice.on_chain')}
            </button>
            <button
              onClick={() => {
                setShowPinChoice(false)
                submitPinAction('pin', false)
              }}
              className={`w-full py-2 rounded-lg text-sm cursor-pointer ${
                isDark ? 'bg-white/10 hover:bg-white/15 text-white' : 'bg-gray-100 hover:bg-gray-200 text-black'
              }`}
            >
              {t('post.pin_choice.off_chain')}
            </button>
            <button
              onClick={() => setShowPinChoice(false)}
              className={`w-full py-2 rounded-lg text-sm cursor-pointer ${
                isDark ? 'text-white/50 hover:text-white/70' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      </ModalWrapper>
    </>
  )
}

export default React.memo(FeedItem, (prev, next) => {
  // Re-render only when the item data or key props actually change
  return (
    prev.item === next.item &&
    prev.isMainPost === next.isMainPost &&
    prev.isReply === next.isReply &&
    prev.hideParentPreview === next.hideParentPreview &&
    prev.hideBottomBorder === next.hideBottomBorder &&
    prev.inThread === next.inThread
  )
})
