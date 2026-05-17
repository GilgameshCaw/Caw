import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate, Link } from '~/utils/localizedRouter'
import { apiFetch } from '~/api/client'
import { useVerifyWalletStore } from '~/store/verifyWalletStore'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'
import { useMarketplaceStore } from '~/store/marketplaceStore'
import { formatEther, formatUnits } from 'viem'
import {
  HiHeart,
  HiUserAdd,
  HiReply,
  HiRefresh,
  HiAtSymbol,
  HiBell,
  HiCheck,
  HiCurrencyDollar,
  HiTag,
  HiChartBar,
  HiOutlineBell,
  HiOutlineAtSymbol
} from 'react-icons/hi'
import Tooltip from '~/components/Tooltip'
import { useNotificationUnreadStore } from '~/store/notificationUnreadStore'
import { useSignAndSubmitAction, decompressSignedText, type ActionTypeKey } from '~/api/actions'
import { useAutoRetryStore } from '~/store/autoRetryStore'
import { useT } from '~/i18n/I18nProvider'
import { getUserAvatar } from '~/utils/defaultAvatar'
import Avatar from '~/components/Avatar'
import { LoadingSpinner } from '~/components/Skeleton'
import UserHoverCard from '~/components/UserHoverCard'
import { CawThumbnail, pickCawThumbnail } from '~/utils/cawThumbnail'
import { stripPollMarker } from '~/../../../tools/pollMarker'
import { useModalStore } from '~/store/modalStore'

interface Actor {
  tokenId: number
  username: string
  displayName?: string
  avatarUrl?: string
  defaultAvatarId?: number
}

interface Notification {
  id: number
  type: 'FOLLOW' | 'LIKE' | 'REPLY' | 'REPOST' | 'QUOTE' | 'MENTION' | 'TIP' | 'OFFER' | 'OUTBID' | 'AUCTION_WON' | 'SALE_SOLD' | 'SALE_BOUGHT' | 'ACTION_FAILED' | 'VOTE'
  actor: Actor
  additionalActors?: Actor[]
  caw?: {
    id: number
    content: string
    createdAt: string
    // Media bits used to render a thumbnail and scrub the lifted GIF
    // URL out of the content snippet.
    hasImage?: boolean
    hasVideo?: boolean
    imageData?: string | null
    videoData?: string | null
  }
  offer?: {
    id: number
    offerId: number
    tokenId: number
    offerer: string
    amount: string
    paymentToken: string
    username: string
    expiry: string
    status: string
  }
  // Populated for ACTION_FAILED notifications — carries enough of the
  // original action payload for the retry UI to reconstruct params.
  // receiverUsername and targetCaw are enriched server-side in the
  // notifications route so the UI can render human-readable labels
  // without extra client lookups.
  actionPayload?: {
    actionType?: number
    receiverId?: number | null
    receiverCawonce?: number | null
    text?: string | null
    recipients?: number[] | null
    amounts?: (string | number)[] | null
    originalTxQueueId?: number
    reason?: string
    receiverUsername?: string
    tipAmount?: string
    targetCaw?: {
      content: string
      authorUsername: string
    }
    // Marketplace auction notifications (OUTBID / AUCTION_WON)
    listingId?: number
    username?: string
    tokenId?: number
    newBidAmount?: string
    previousBidAmount?: string
    winningBid?: string
    paymentToken?: string
    // Marketplace sale notifications (SALE_SOLD / SALE_BOUGHT)
    saleId?: number
    price?: string
  } | null
  isRead: boolean
  createdAt: string
  count?: number
  groupKey?: string
  notificationIds: number[]
}

interface NotificationsResponse {
  notifications: Notification[]
  unreadCount: number
  hasMore: boolean
}

type TabType = 'all' | 'mentions'

// Module-level cache so notifications survive navigation
let notifCache: { items: Notification[]; tokenId: number; tab: TabType; unread: number; ts: number } | null = null

// Helper function to format relative time
function formatRelativeTime(timestamp: string): string {
  const now = new Date()
  const time = new Date(timestamp)

  // Check for invalid date
  if (isNaN(time.getTime())) {
    console.error('Invalid timestamp:', timestamp)
    return 'unknown'
  }

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

// Format the full date/time for tooltip
function formatFullDateTime(timestamp: string): string {
  const time = new Date(timestamp)
  if (isNaN(time.getTime())) {
    return 'Invalid date'
  }
  return time.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  })
}

const Notifications: React.FC = () => {
  const navigate = useNavigate()
  const { isDark } = useTheme()
  const t = useT()
  const activeToken = useActiveToken()
  const signAndSubmit = useSignAndSubmitAction()
  const ethPrice = usePriceStore(s => s.priceMap['ethereum'] ?? 0)
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const [activeTab, setActiveTab] = useState<TabType>('all')
  const hasCached = notifCache !== null && notifCache.tokenId === activeToken?.tokenId && notifCache.tab === activeTab
  const [notifications, setNotifications] = useState<Notification[]>(hasCached ? notifCache!.items : [])
  const [loading, setLoading] = useState(!hasCached)
  const [error, setError] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(hasCached ? notifCache!.unread : 0)
  // Tracks which ACTION_FAILED notifications are mid-manual-retry so the
  // button can show a spinner state and block double-taps. Keyed by
  // notification.id.
  const [retrying, setRetrying] = useState<Set<number>>(new Set())
  // Subscription to the auto-retry store (cawonce-collision recovery run by
  // useTxQueueMonitor). When a notification's originalTxQueueId is in this
  // set, the button shows "Retrying…" and disables manual retry. The monitor
  // also calls the hide-by-original-tx endpoint on success, so this state is
  // normally short-lived — the notification disappears from the list.
  const autoRetryingTxIds = useAutoRetryStore(s => s.retryingTxIds)
  const setGlobalUnreadCount = useNotificationUnreadStore(s => s.setUnreadCount)
  const openModal = useModalStore(s => s.openModal)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const fetchNotifications = useCallback(async (reset = false) => {
    if (!activeToken) return

    try {
      setLoading(true)
      setError(null)

      const currentOffset = reset ? 0 : offset
      const type = activeTab === 'mentions' ? 'mentions' : 'all'

      const data = await apiFetch<NotificationsResponse>(
        `/api/notifications?userId=${activeToken.tokenId}&type=${type}&limit=50&offset=${currentOffset}`
      )

      if (reset) {
        setNotifications(data.notifications)
      } else {
        setNotifications(prev => [...prev, ...data.notifications])
      }

      setUnreadCount(data.unreadCount)
      setHasMore(data.hasMore)
      setOffset(currentOffset + data.notifications.length)

      // Update cache
      if (reset && activeToken) {
        notifCache = { items: data.notifications, tokenId: activeToken.tokenId, tab: activeTab, unread: data.unreadCount, ts: Date.now() }
      }

      // Mark ALL notifications as read on the initial fetch — the user
      // landed on the notifications page, so the bell badge should clear
      // even if there are more unread notifications beyond the first page.
      // Subsequent pages (loadMore) only mark their own visible IDs.
      if (data.notifications.length > 0) {
        if (reset) {
          await markAsRead()
        } else {
          const unreadIds = data.notifications
            .filter(n => !n.isRead)
            .flatMap(n => n.notificationIds)
          if (unreadIds.length > 0) {
            await markAsRead(unreadIds)
          }
        }
      }
    } catch (err: any) {
      console.error('Failed to fetch notifications:', err)
      const isAuth = err?.name === 'AuthError' || err?.message?.includes('401')
      setError(isAuth ? 'auth' : t('notifications.error.could_not_load'))
    } finally {
      setLoading(false)
    }
  }, [activeToken, activeTab, offset])

  const markAsRead = async (notificationIds?: number[]) => {
    if (!activeToken) return

    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({
          userId: activeToken.tokenId,
          notificationIds
        })
      })
      // Clear the sidebar badge immediately
      setGlobalUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark notifications as read:', err)
    }
  }

  const markAllAsRead = async () => {
    if (!activeToken) return

    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ userId: activeToken.tokenId })
      })

      // Update UI to reflect all notifications as read
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })))
      setUnreadCount(0)
      setGlobalUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark all as read:', err)
    }
  }

  const hideNotification = async (notificationId: number) => {
    if (!activeToken) return

    try {
      await apiFetch(`/api/notifications/${notificationId}/hide`, {
        method: 'PATCH',
        body: JSON.stringify({ userId: activeToken.tokenId })
      })

      // Remove from UI
      setNotifications(prev => prev.filter(n => n.id !== notificationId))
    } catch (err) {
      console.error('Failed to hide notification:', err)
    }
  }

  const getNotificationIcon = (type: Notification['type']) => {
    switch (type) {
      case 'FOLLOW':
        return <HiUserAdd className="w-6 h-6 text-blue-500" />
      case 'LIKE':
        return <HiHeart className="w-6 h-6 text-red-500" />
      case 'REPLY':
        return <HiReply className="w-6 h-6 text-green-500" />
      case 'REPOST':
        return <HiRefresh className="w-6 h-6 text-purple-500" />
      case 'QUOTE':
        return <HiReply className="w-6 h-6 text-indigo-500" />
      case 'MENTION':
        return <HiAtSymbol className="w-6 h-6 text-orange-500" />
      case 'TIP':
        return <HiCurrencyDollar className="w-6 h-6 text-yellow-500" />
      case 'OFFER':
        return <HiTag className="w-6 h-6 text-yellow-500" />
      case 'OUTBID':
        return <HiTag className="w-6 h-6 text-orange-500" />
      case 'AUCTION_WON':
        return <HiTag className="w-6 h-6 text-green-500" />
      case 'SALE_SOLD':
        return <HiCurrencyDollar className="w-6 h-6 text-green-500" />
      case 'SALE_BOUGHT':
        return <HiTag className="w-6 h-6 text-blue-500" />
      case 'ACTION_FAILED':
        return <HiBell className="w-6 h-6 text-red-400" />
      case 'VOTE':
        return <HiChartBar className="w-6 h-6 text-yellow-500" />
      default:
        return <HiBell className="w-6 h-6 text-gray-500" />
    }
  }

  // Human-readable label for a failed action given its payload actionType.
  // Numeric codes from ActionTypeMap in api/actions.ts:
  // 0=caw, 1=like, 2=unlike, 3=recaw, 4=follow, 5=unfollow, 6=withdraw, 7=other
  //
  // Returns a structured piece with a `title` (the headline) and optional
  // `snippet` (the content the user tried to post, or a quote of the target
  // caw they tried to interact with). The render layer can style these
  // differently — title bold, snippet italic and muted.
  const describeFailedAction = (payload: NonNullable<Notification['actionPayload']>): { title: string; snippet?: string; snippetLabel?: string } => {
    const { actionType, receiverUsername, targetCaw } = payload
    // payload.text is smltxt-compressed hex from the signed action — decompress
    // to plaintext for display. Falls back to empty string on decode failure.
    const plaintext = payload.text ? decompressSignedText(payload.text) : ''
    const userTextTrim = plaintext.trim()
    const userSnippet = userTextTrim
      ? (userTextTrim.length > 140 ? userTextTrim.slice(0, 140) + '…' : userTextTrim)
      : ''
    const targetSnippet = targetCaw
      ? `@${targetCaw.authorUsername}: "${targetCaw.content.length > 100 ? targetCaw.content.slice(0, 100) + '…' : targetCaw.content}"`
      : ''

    switch (actionType) {
      case 0: // caw (post or reply)
        if (payload.receiverId && payload.receiverCawonce) {
          return {
            title: targetCaw ? `Reply to @${targetCaw.authorUsername} failed` : 'Reply failed',
            snippet: userSnippet || undefined,
            snippetLabel: userSnippet ? 'You tried to post' : undefined,
          }
        }
        return {
          title: 'Posting failed',
          snippet: userSnippet || undefined,
          snippetLabel: userSnippet ? 'You tried to post' : undefined,
        }
      case 1: // like
        return {
          title: targetCaw ? `Like on @${targetCaw.authorUsername}'s caw failed` : 'Like failed',
          snippet: targetSnippet ? `"${targetCaw!.content.length > 100 ? targetCaw!.content.slice(0, 100) + '…' : targetCaw!.content}"` : undefined,
        }
      case 3: {
        // recaw (plain) vs quote (has text)
        const isQuote = userTextTrim.length > 0
        if (isQuote) {
          return {
            title: targetCaw ? `Quote of @${targetCaw.authorUsername}'s caw failed` : 'Quote failed',
            snippet: userSnippet || undefined,
            snippetLabel: 'You tried to post',
          }
        }
        return {
          title: targetCaw ? `Recaw of @${targetCaw.authorUsername}'s caw failed` : 'Recaw failed',
          snippet: targetCaw ? `"${targetCaw.content.length > 100 ? targetCaw.content.slice(0, 100) + '…' : targetCaw.content}"` : undefined,
        }
      }
      case 4: // follow
        return {
          title: receiverUsername ? `Following @${receiverUsername} failed` : 'Follow failed',
        }
      case 7: // other — tip, vote, image upload, profile update
        if (plaintext.startsWith('tip:')) {
          return {
            title: receiverUsername ? `Tip to @${receiverUsername} failed` : 'Tip failed',
          }
        }
        if (plaintext.startsWith('vote:')) {
          // vote:N (N missing → unvote). Same target-caw idea as tip — the
          // poll lives on @receiverUsername's caw.
          const isUnvote = plaintext === 'vote:'
          if (isUnvote) {
            return {
              title: receiverUsername ? `Unvote on @${receiverUsername}'s poll failed` : 'Unvote failed',
            }
          }
          return {
            title: receiverUsername ? `Vote on @${receiverUsername}'s poll failed` : 'Vote failed',
          }
        }
        if (plaintext.startsWith('p:') || plaintext.startsWith('profile-update:')) return { title: 'Profile update failed' }
        return { title: 'Action failed' }
      default:
        return { title: 'Action failed' }
    }
  }

  // Human-readable reason from the raw validator error text. Keep the user
  // out of on-chain implementation details and lean on plainspoken language
  // for anything they don't need to understand to take a useful next step.
  const describeFailedReason = (raw: string): string => {
    // Strip ethers' CALL_EXCEPTION wrapper down to the contract revert string.
    // Matches the `reason="..."` field that ethers serializes into the message.
    // Falls back to the full raw input if no reason is found, so we still
    // pattern-match against it below.
    const reasonMatch = (raw || '').match(/reason="([^"]+)"/)
    const cleaned = reasonMatch ? reasonMatch[1] : (raw || '')

    const lower = cleaned.toLowerCase()
    if (lower.includes('insufficient')) return "You don't have enough deposited CAW for this action."
    if (lower.includes('not authenticated')) return 'Account not yet authenticated with this client.'
    if (lower.includes('cawonce') || lower.includes('conflict')) {
      return 'Something went wrong while processing this action on-chain.'
    }
    if (lower.includes('deposit did not arrive')) return 'Your pending deposit did not arrive from L1 in time.'
    if (lower.includes('text exceeds')) return 'The post text was too long.'
    if (lower.includes('cannot follow yourself')) return "You can't follow your own account."
    if (lower.includes('sigs length mismatch') || lower.includes('invalid signature') || lower.includes('signature')) {
      return 'Signature validation failed on-chain.'
    }
    // The contract's "Session expired or not found" revert is a fallback —
    // it fires whenever ecrecover returns an address that isn't the owner
    // and isn't a registered session. The literal message is misleading
    // (your session might be perfectly fine) so we soften it to a generic
    // "couldn't verify" rather than implying the user's Quick Sign is bad.
    if (lower.includes('session expired') || lower.includes('session not found')) {
      return 'Couldn\'t verify the action signature on-chain. Try again.'
    }
    if (lower.includes('simulation') || lower.includes('internal error') || lower.includes('rpc')) {
      return 'Something went wrong while processing this action on-chain.'
    }
    // Catch raw JS/engine errors that aren't user-friendly
    if (lower.includes('cannot read properties') || lower.includes('typeerror') || lower.includes('referenceerror') || lower.includes('undefined')) {
      return 'Something went wrong.'
    }
    // Anything still wrapped in an ethers stack trace at this point is too
    // verbose to show — fall back to a generic message rather than dumping
    // calldata, addresses, or invocation blobs into the notification card.
    if (cleaned.includes('CALL_EXCEPTION') || cleaned.includes('action="call"') || cleaned.length > 140) {
      return 'Something went wrong while processing this action on-chain.'
    }
    return cleaned || 'Something went wrong.'
  }

  const getNotificationText = (notification: Notification): React.ReactNode => {
    const { type, actor, additionalActors, count = 1, groupKey } = notification

    // Style: actor is the visual anchor; action should be readable (less gray).
    const actionClass = isDark ? 'text-white/85 font-normal' : 'text-gray-800 font-normal'
    const Actor = (node: React.ReactNode) => <span className="font-bold">{node}</span>
    const Action = (node: React.ReactNode) => <span className={actionClass}>{node}</span>

    const actorLabel = actor.displayName || actor.username
    const hasRealUsername = !!actor.username && actor.username !== `#${actor.tokenId}`
    const actorSpan = (
      <span
        onClick={e => {
          // Actor name sits inside an <a> notification row for most types.
          // stopPropagation prevents the row's SPA handler, so we MUST also
          // preventDefault or the browser will follow the row href.
          e.preventDefault()
          e.stopPropagation()
          const uname = hasRealUsername ? actor.username : (actor.displayName || actor.username)
          navigate(`/users/${uname}`)
        }}
        className="hover:underline cursor-pointer"
      >
        {actorLabel}
      </span>
    )
    const actorLink = hasRealUsername
      ? <UserHoverCard username={actor.username!}>{actorSpan}</UserHoverCard>
      : actorSpan
    const grouped = count > 1 && additionalActors && additionalActors.length > 0
    const othersCount = grouped ? count - 1 : 0
    // For grouped notifications the "X others" portion becomes a clickable
    // button that opens the full actor list modal. We use the plural i18n
    // keys and reconstruct the label around actorLink + a <button>.
    const actorNode: React.ReactNode = grouped
      ? (() => {
          // Pass `count` but intentionally NOT `name` so the `{{name}}`
          // placeholder stays literal in the returned string. We then
          // split on the placeholder position to extract:
          //   - `connector`: whitespace/punctuation between the name
          //                   and the count phrase ("y", "and", "und",
          //                   "et", etc. plus surrounding spaces)
          //   - `suffix`:    the count phrase itself ("3 más", "and
          //                   3 others", "外 3名")
          // This is locale-agnostic — every translation in every locale
          // file follows the `{{name}} <connector> <count phrase>`
          // shape, so the {{name}} marker is the only stable anchor.
          // The previous lastIndexOf(' and ') only worked in English.
          const rawTemplate = othersCount === 1
            ? t('notifications.actor_grouped_one', { count: othersCount })
            : t('notifications.actor_grouped_other', { count: othersCount })
          const NAME_TOKEN = '{{name}}'
          const tokenIdx = rawTemplate.indexOf(NAME_TOKEN)
          let connector = ' '
          let suffix = rawTemplate
          if (tokenIdx >= 0) {
            const afterName = rawTemplate.slice(tokenIdx + NAME_TOKEN.length)
            // Split on the FIRST run of non-whitespace text after the
            // name marker — that's the count phrase. Whitespace +
            // connector word(s) before it become `connector`. e.g.
            //   " y 3 más"      → connector=" y ",   suffix="3 más"
            //   " and 3 others" → connector=" and ", suffix="3 others"
            //   " 外 3名"        → connector=" 外 ",   suffix="3名"
            const m = afterName.match(/^(\s*\S+\s*)(.*)$/)
            if (m && m[2]) {
              connector = m[1]
              suffix = m[2]
            } else {
              // Single-word remainder — no clear split. Render as-is
              // (the whole remainder becomes the button text and the
              // connector falls back to a single space).
              suffix = afterName.trimStart()
            }
          }
          const notificationType = type as 'FOLLOW' | 'LIKE' | 'REPOST' | 'TIP'
          const othersButton = (
            <button
              type="button"
              onClick={e => {
                e.preventDefault()
                e.stopPropagation()
                openModal('notificationActors', {
                  groupKey: groupKey ?? `${type}:${actor.tokenId}`,
                  userId: activeToken?.tokenId ?? 0,
                  notificationType,
                })
              }}
              className={`underline cursor-pointer font-bold ${isDark ? 'text-white/85' : 'text-gray-800'} hover:opacity-70`}
            >
              {suffix}
            </button>
          )
          return <>{actorLink}{connector}{othersButton}</>
        })()
      : actorLink

    switch (type) {
      case 'ACTION_FAILED': {
        const payload = notification.actionPayload
        if (!payload) return 'An action failed. Please try again.'
        const { title, snippet, snippetLabel } = describeFailedAction(payload)
        const reason = describeFailedReason(payload.reason ?? '')
        return (
          <>
            <span>{title}</span>
            <span className={`block text-xs mt-0.5 font-normal ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {reason}
            </span>
            {snippet && (
              <span className={`block text-xs mt-1.5 italic font-normal border-l-2 pl-2 ${
                isDark ? 'text-white/70 border-white/20' : 'text-gray-700 border-gray-300'
              }`}>
                {snippetLabel && <span className="not-italic opacity-60">{snippetLabel}: </span>}
                "{snippet}"
              </span>
            )}
          </>
        )
      }
      case 'FOLLOW':
        return <>{Actor(actorNode)} {Action(t('notifications.message.followed', { count }))}</>
      case 'LIKE':
        return <>{Actor(actorNode)} {Action(t('notifications.message.liked', { count }))}</>
      case 'REPLY':
        return <>{Actor(actorNode)} {Action(t('notifications.message.replied', { count }))}</>
      case 'REPOST':
        return <>{Actor(actorNode)} {Action(t('notifications.message.recawed', { count }))}</>
      case 'QUOTE':
        return <>{Actor(actorNode)} {Action(t('notifications.message.quoted', { count }))}</>
      case 'MENTION':
        return <>{Actor(actorNode)} {Action(t('notifications.message.mentioned', { count }))}</>
      case 'VOTE':
        return <>{Actor(actorNode)} {Action(t('notifications.message.voted', { count }))}</>
      case 'TIP': {
        const tipAmt = notification.actionPayload?.tipAmount
        let tipLabel = ''
        if (tipAmt) {
          const cawNum = Number(tipAmt)
          const formatted = cawNum >= 1_000_000 ? `${(cawNum / 1_000_000).toFixed(1)}M`
            : cawNum >= 1_000 ? `${(cawNum / 1_000).toFixed(1)}K`
            : cawNum.toFixed(0)
          const usd = cawPrice > 0 ? ` (~$${(cawNum * cawPrice).toFixed(2)})` : ''
          tipLabel = ` ${formatted} CAW${usd}`
        }
        return notification.caw
          ? <>{Actor(actorNode)} {Action(<>tipped your caw{tipLabel}</>)}</>
          : <>{Actor(actorNode)} {Action(<>tipped you{tipLabel}</>)}</>
      }
      case 'OFFER': {
        // Build USD display
        let offerUsd = ''
        if (notification.offer) {
          const token = notification.offer.paymentToken
          const decimals = (token === 'USDC' || token === 'USDT') ? 6 : 18
          const num = parseFloat(decimals === 18 ? formatEther(BigInt(notification.offer.amount)) : formatUnits(BigInt(notification.offer.amount), decimals))
          let rate = 0
          if (token === 'USDC' || token === 'USDT') rate = 1
          else if (token === 'ETH' || token === 'WETH') rate = ethPrice
          else if (token === 'CAW') rate = cawPrice
          if (rate > 0) {
            const usd = num * rate
            offerUsd = ` for $${usd.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
          }
        }
        // Show actor username if they have one, otherwise fall back to address with etherscan link
        const addr = notification.offer?.offerer
        if (actor.username && actor.username !== `#${actor.tokenId}`) {
          return <>{Actor(actorNode)} {Action(<>made an offer on your profile{offerUsd}</>)}</>
        }
        if (addr) {
          const addrDisplay = `${addr.slice(0, 6)}...${addr.slice(-4)}`
          return (
            <>
              <Link
                to={`/address/${addr.toLowerCase()}`}
                className="text-yellow-500 hover:underline"
                onClick={e => e.stopPropagation()}
              >
                {addrDisplay}
              </Link>
              {Action(` made an offer on your profile${offerUsd}`)}
            </>
          )
        }
        return <>{Actor(actorNode)} {Action(<>made an offer on your profile{offerUsd}</>)}</>
      }
      case 'OUTBID': {
        const payload = notification.actionPayload
        const username = payload?.username ?? 'a profile'
        return Action(`You've been outbid on @${username}`)
      }
      case 'AUCTION_WON': {
        const payload = notification.actionPayload
        const username = payload?.username ?? 'a profile'
        return Action(`You won the auction for @${username}! Settle it to claim the username.`)
      }
      case 'SALE_SOLD':
      case 'SALE_BOUGHT': {
        const payload = notification.actionPayload
        const username = payload?.username ?? 'a profile'
        const token = payload?.paymentToken
        const raw = payload?.price
        let priceLabel = ''
        if (raw && token) {
          const decimals = (token === 'USDC' || token === 'USDT') ? 6 : 18
          const num = parseFloat(decimals === 18 ? formatEther(BigInt(raw)) : formatUnits(BigInt(raw), decimals))
          let rate = 0
          if (token === 'USDC' || token === 'USDT') rate = 1
          else if (token === 'ETH' || token === 'WETH') rate = ethPrice
          else if (token === 'CAW') rate = cawPrice
          const usd = rate > 0 ? ` (~$${(num * rate).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : ''
          const formatted = token === 'CAW'
            ? num.toLocaleString(undefined, { maximumFractionDigits: 0 })
            : num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 })
          priceLabel = ` for ${formatted} ${token}${usd}`
        }
        return notification.type === 'SALE_SOLD'
          ? Action(`You sold @${username}${priceLabel}`)
          : Action(`You bought @${username}${priceLabel}`)
      }
      default:
        return Actor(actorNode)
    }
  }

  // Retry a failed action from its notification. Reconstructs the action
  // params from the stored actionPayload, then re-submits via the normal
  // signAndSubmit pipeline — which allocates a fresh cawonce, re-signs,
  // and queues the new action. On success we hide the notification so the
  // list stays clean; on failure a new ACTION_FAILED notification will be
  // created server-side for the new attempt, so the user has a history.
  const handleRetryFailedAction = async (notification: Notification, e: React.MouseEvent) => {
    e.stopPropagation()
    const payload = notification.actionPayload
    if (!payload || !activeToken?.tokenId) return
    if (retrying.has(notification.id)) return

    // Map the numeric actionType back to the string key signAndSubmit expects.
    // Matches the ActionTypeMap in api/actions.ts.
    const codeToKey: Record<number, ActionTypeKey> = {
      0: 'caw',
      1: 'like',
      2: 'unlike',
      3: 'recaw',
      4: 'follow',
      5: 'unfollow',
      6: 'withdraw',
      7: 'other',
    }
    if (payload.actionType == null) {
      console.warn('[Notifications] Cannot retry — missing action type')
      return
    }
    const actionTypeKey = codeToKey[payload.actionType]
    if (!actionTypeKey) {
      console.warn('[Notifications] Cannot retry unknown action type', payload.actionType)
      return
    }

    setRetrying(prev => new Set(prev).add(notification.id))
    try {
      // Build ActionParams. Do NOT pass cawonce — signAndSubmit will allocate
      // a fresh one from the store, which is exactly what we want since the
      // original cawonce is the reason some of these failed in the first
      // place.
      // Do NOT pass amounts for standard actions — buildTypedData adds the
      // validator tip automatically, and the original amounts already included
      // it, so passing them through would double the tip and cause a
      // "recipients/amounts mismatch" error. Only pass amounts for 'other'
      // and 'withdraw' where they carry user-specified values (tips to other
      // users, withdrawal amounts); buildTypedData skips adding a tip for
      // 'other' actions that already have amounts.
      const hasUserAmounts = actionTypeKey === 'other' || actionTypeKey === 'withdraw'
      const result = await signAndSubmit({
        actionType: actionTypeKey,
        senderId: activeToken.tokenId,
        ...(payload.receiverId != null ? { receiverId: payload.receiverId } : {}),
        ...(payload.receiverCawonce != null ? { receiverCawonce: payload.receiverCawonce } : {}),
        ...(payload.text != null ? { text: decompressSignedText(payload.text) } : {}),
        ...(payload.recipients != null ? { recipients: payload.recipients } : {}),
        ...(hasUserAmounts && payload.amounts != null ? { amounts: payload.amounts.map(a => BigInt(a)) as any } : {}),
        retriedTxQueueId: payload.originalTxQueueId,
      })
      if (result) {
        // Hide the old failed notification so the list reflects the retry.
        hideNotification(notification.id)
      }
    } catch (err: any) {
      console.error('[Notifications] Retry failed:', err)
    } finally {
      setRetrying(prev => {
        const next = new Set(prev)
        next.delete(notification.id)
        return next
      })
    }
  }

  /**
   * Resolve a notification to its target URL (or null for types that
   * don't navigate at all, e.g. OFFER opens a modal). Pure function so
   * we can use it both for the in-tab click handler and for `href`
   * (which lets cmd/ctrl/middle-click open in a new tab natively).
   */
  const getNotificationHref = (notification: Notification): string | null => {
    if (notification.type === 'FOLLOW') return `/users/${notification.actor.username}`
    if (notification.type === 'OFFER') return null // modal-only
    if (notification.type === 'OUTBID' || notification.type === 'AUCTION_WON') return '/usernames'
    if (notification.type === 'SALE_SOLD' || notification.type === 'SALE_BOUGHT') {
      const u = notification.actionPayload?.username
      return u ? `/users/${u}` : '/usernames'
    }
    if (notification.type === 'TIP' && !notification.caw) return `/users/${notification.actor.username}`
    if (notification.type === 'ACTION_FAILED') {
      const payload = notification.actionPayload
      if (!payload) return null
      if (payload.receiverId && payload.receiverCawonce && payload.receiverUsername) {
        return `/users/${payload.receiverUsername}`
      }
      if (payload.receiverId && payload.receiverCawonce) {
        return `/users/${payload.receiverId}`
      }
      return null
    }
    if (notification.caw) return `/caws/${notification.caw.id}`
    return null
  }

  const handleNotificationClick = (notification: Notification) => {
    if (notification.type === 'OFFER') {
      // Open view offers modal for this token — no navigation.
      if (notification.offer) {
        useMarketplaceStore.getState().openViewOffers(notification.offer.tokenId, notification.offer.username)
      }
      return
    }
    const href = getNotificationHref(notification)
    if (href) navigate(href)
  }

  useEffect(() => {
    // Restore from cache if available, background refresh if stale
    const c = notifCache
    if (c && c.tokenId === activeToken?.tokenId && c.tab === activeTab && c.items.length > 0) {
      setNotifications(c.items)
      setUnreadCount(c.unread)
      setLoading(false)
      if (Date.now() - c.ts > 60_000) {
        fetchNotifications(true)
      }
      return
    }
    // No cache hit — drop whatever's on screen before fetching so the
    // loader gate (`loading && notifications.length === 0`) trips and the
    // user sees a spinner instead of stale notifications from the
    // previous profile / tab while the new fetch is in flight.
    setNotifications([])
    setUnreadCount(0)
    setHasMore(false)
    setOffset(0)
    setLoading(true)
    fetchNotifications(true)
  }, [activeTab, activeToken?.tokenId])

  useEffect(() => {
    // Set up polling for new notifications
    const interval = setInterval(() => {
      if (activeToken) {
        apiFetch<{ unreadCount: number }>(
          `/api/notifications/unread-count?userId=${activeToken.tokenId}`
        ).then(data => {
          if (data.unreadCount > unreadCount) {
            // New notifications available, refresh
            fetchNotifications(true)
          }
        }).catch(console.error)
      }
    }, 30000) // Poll every 30 seconds

    return () => clearInterval(interval)
  }, [activeToken, unreadCount])

  if (!activeToken) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-8 text-center">
        <p className={isDark ? 'text-white/60' : 'text-gray-600'}>
          Please sign in to view notifications
        </p>
      </div>
    )
  }

  return (
    <div
      className="max-w-2xl mx-auto px-6 py-4"
      // Reserve space below the list so the trailing "Load more" button
      // (and any final notification row) clears the mobile bottom nav.
      // Resolves to 0 on desktop / when the nav isn't rendered.
      style={{ paddingBottom: 'calc(1rem + var(--bottom-nav-h, 0px))' }}
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-6">
        {/* min-w-0 + truncate so the title doesn't push the
            mark-all-read button off-screen in long-label locales
            (e.g. ja: "通知" is short but ru/de/pl run long). */}
        <h1 className={`text-2xl font-bold min-w-0 truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
          {t('notifications.title')}
        </h1>
        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg transition flex-shrink-0 ${
              isDark
                ? 'bg-white/10 hover:bg-white/20 text-white'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
            }`}
          >
            <HiCheck className="w-4 h-4 flex-shrink-0" />
            {/* whitespace-nowrap keeps the label on one line in locales
                where it would otherwise wrap (Spanish/Polish/Russian
                run noticeably longer than English). The flex-shrink-0
                above prevents the button itself from squeezing into
                the title column on narrow viewports. */}
            <span className="text-sm whitespace-nowrap">{t('notifications.mark_all_read')}</span>
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className={`flex border-b mb-3 ${isDark ? 'border-white/20' : 'border-gray-300'}`}>
        <button
          onClick={() => setActiveTab('all')}
          className={`py-4 px-8 flex-1 text-center font-medium text-lg transition-all duration-200 cursor-pointer ${
            activeTab === 'all'
              ? isDark
                ? 'border-b-2 border-white text-white'
                : 'border-b-2 border-black text-black'
              : isDark
                ? 'text-gray-400 hover:text-white hover:bg-white/5'
                : 'text-gray-600 hover:text-black hover:bg-gray-100'
          }`}
        >
          {t('notifications.tab.all')}
          {unreadCount > 0 && activeTab !== 'all' && (
            <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-red-500 text-white">
              {unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('mentions')}
          className={`py-4 px-8 flex-1 text-center font-medium text-lg transition-all duration-200 cursor-pointer flex items-center justify-center space-x-2 ${
            activeTab === 'mentions'
              ? isDark
                ? 'border-b-2 border-white text-white'
                : 'border-b-2 border-black text-black'
              : isDark
                ? 'text-gray-400 hover:text-white hover:bg-white/5'
                : 'text-gray-600 hover:text-black hover:bg-gray-100'
          }`}
        >
          <HiAtSymbol className="w-4 h-4" />
          <span>{t('notifications.tab.mentions')}</span>
        </button>
      </div>

      {/* Notifications List */}
      {loading && notifications.length === 0 ? (
        <LoadingSpinner />
      ) : error ? (
        <div className="text-center py-8">
          {error === 'auth' ? (
            <>
              <p className={`mb-3 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
                {t('notifications.signin_prompt')}
              </p>
              <button
                onClick={() => useVerifyWalletStore.getState().show()}
                className="px-4 py-2 rounded-lg bg-yellow-500 text-black text-sm font-medium hover:bg-yellow-400 cursor-pointer"
              >
                {t('notifications.verify_wallet')}
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center justify-center py-8 px-6 text-center">
              <div className="w-12 h-12 mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
                <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                </svg>
              </div>
              <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{error}</p>
              <button
                onClick={() => fetchNotifications(true)}
                className={`px-5 py-2 text-sm font-medium rounded-full transition cursor-pointer ${
                  isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-900 hover:bg-gray-300'
                }`}
              >
                {t('common.try_again')}
              </button>
            </div>
          )}
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-12">
          {activeTab === 'mentions' ? (
            <HiOutlineAtSymbol className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
              isDark ? 'text-white' : 'text-black'
            }`} />
          ) : (
            <HiOutlineBell className={`w-12 h-12 mx-auto mb-4 opacity-30 ${
              isDark ? 'text-white' : 'text-black'
            }`} />
          )}
          <h3 className={`text-lg font-semibold mb-2 transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {activeTab === 'mentions' ? t('notifications.empty.mentions') : t('notifications.empty.all')}
          </h3>
          <p className={`transition-colors duration-300 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            {activeTab === 'mentions'
              ? t('notifications.empty.mentions_hint')
              : t('notifications.empty.all_hint')}
          </p>
        </div>
      ) : (
        <div className="w-full">
          {notifications.map((notification, idx) => {
            // Render as <a href> when the notification has a real
            // destination so cmd/ctrl/middle-click open it in a new tab
            // the way the browser already does for links. Plain left-
            // click is intercepted for SPA navigation. Non-navigating
            // types (OFFER opens a modal) fall back to a plain div.
            const href = getNotificationHref(notification)
            // Flat rows (no cards). Only a horizontal divider between rows.
            const divider = idx < notifications.length - 1
              ? (isDark ? 'border-b border-white/15' : 'border-b border-gray-200')
              : ''
            // Subtle yellow tint on unread rows so new notifications stand
            // out from already-seen ones at a glance (X-style; brand accent
            // at low alpha so it sits behind the row content rather than
            // shouting). Falls back to plain hover-only background once the
            // row is marked read.
            // Age-graded tint for unread rows: brand accent fades as the
            // notification gets older, so the freshest items stand out
            // most (X-style). Read rows drop the tint entirely.
            const ageHours = (Date.now() - new Date(notification.createdAt).getTime()) / 3600000
            const unreadTint = ageHours < 24
              ? 'bg-yellow-500/10 hover:bg-yellow-500/15'
              : ageHours < 72
                ? 'bg-yellow-500/5 hover:bg-yellow-500/10'
                : (isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50')
            const rowClass = `block px-4 py-4 transition cursor-pointer no-underline ${
              !notification.isRead
                ? unreadTint
                : isDark ? 'hover:bg-white/5' : 'hover:bg-gray-50'
            } ${divider}`
            const RowTag: any = href ? 'a' : 'div'
            const rowProps: any = href
              ? {
                  href,
                  onClick: (e: React.MouseEvent) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
                    e.preventDefault()
                    handleNotificationClick(notification)
                  },
                }
              : { onClick: () => handleNotificationClick(notification) }
            return (
            <RowTag
              key={notification.id}
              className={rowClass}
              {...rowProps}
            >
              <div className="flex items-start space-x-3">
                <div className="mt-1">
                  {getNotificationIcon(notification.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className={`min-w-0 text-sm md:text-base leading-snug ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    {notification.actor && notification.type !== 'ACTION_FAILED' && (
                      notification.actor.username ? (
                        <Link
                          to={`/users/${notification.actor.username}`}
                          onClick={e => e.stopPropagation()}
                          className="inline-block align-middle mr-1.5"
                        >
                          <Avatar
                            src={getUserAvatar(notification.actor)}
                            className="w-7 h-7 rounded-full flex-shrink-0"
                            size="small"
                          />
                        </Link>
                      ) : (
                        <Avatar
                          src={getUserAvatar(notification.actor)}
                          className="w-7 h-7 rounded-full flex-shrink-0 inline-block align-middle mr-1.5"
                          size="small"
                        />
                      )
                    )}
                    {getNotificationText(notification)}
                    <Tooltip text={formatFullDateTime(notification.createdAt)} className="inline-block">
                      <span
                        className={`ml-2 whitespace-nowrap text-sm ${isDark ? 'text-white/55' : 'text-gray-500'}`}
                      >
                        · {formatRelativeTime(notification.createdAt)}
                      </span>
                    </Tooltip>
                  </div>
                  {notification.caw && (() => {
                    // Pick a thumbnail (if any) AND scrub any lifted GIF
                    // URL out of the snippet so we don't render the URL
                    // text twice when the same media is shown as the
                    // thumb on the right. stripPollMarker hides the raw
                    // ::poll:opt1:opt2:: sidecar so it doesn't leak into
                    // the notification body.
                    const picked = pickCawThumbnail(notification.caw, stripPollMarker(notification.caw.content || ''))
                    return picked.body ? (
                      <p className={`text-sm mt-1 truncate ${
                        isDark ? 'text-white/60' : 'text-gray-600'
                      }`}>
                        {picked.body}
                      </p>
                    ) : null
                  })()}
                </div>
                {notification.caw && (() => {
                  // Same picker call as above for the thumb itself — cheap
                  // enough to run twice (regex match + a couple of string
                  // splits, no fetch) that the alternative of hoisting it
                  // up isn't worth restructuring the JSX flow for.
                  const { thumb } = pickCawThumbnail(notification.caw, stripPollMarker(notification.caw.content || ''))
                  if (!thumb) return null
                  return (
                    <CawThumbnail
                      thumb={thumb}
                      wrapperClass="relative flex-shrink-0 self-start mt-1 w-12 h-12 rounded overflow-hidden"
                      showPlayOverlay={thumb.kind !== 'image'}
                    />
                  )
                })()}
                {notification.type === 'ACTION_FAILED' && notification.actionPayload && (() => {
                  // Manual retry in progress (user tapped the button on this
                  // notification) OR auto-retry in progress (useTxQueueMonitor
                  // is recovering from a cawonce collision on the original
                  // TxQueue row). Both paths disable the button and show the
                  // "Retrying…" label.
                  const origTxId = notification.actionPayload.originalTxQueueId
                  const isAutoRetrying = origTxId != null && autoRetryingTxIds.has(origTxId)
                  const isManualRetrying = retrying.has(notification.id)
                  const isBusy = isAutoRetrying || isManualRetrying
                  return (
                    <button
                      onClick={(e) => handleRetryFailedAction(notification, e)}
                      disabled={isBusy}
                      className={`flex-shrink-0 self-start mt-1 px-3 py-1 text-xs font-semibold rounded-full transition ${
                        isBusy
                          ? 'bg-gray-600 text-white/50 cursor-not-allowed'
                          : 'bg-yellow-500 hover:bg-yellow-600 text-black cursor-pointer'
                      }`}
                    >
                      {isBusy ? 'Retrying…' : 'Retry'}
                    </button>
                  )
                })()}
                <button
                  onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    hideNotification(notification.id)
                  }}
                  className={`p-1 rounded transition ${
                    isDark
                      ? 'hover:bg-white/10 text-white/40 hover:text-white'
                      : 'hover:bg-gray-200 text-gray-400 hover:text-gray-600'
                  }`}
                >
                  ×
                </button>
              </div>
            </RowTag>
            )
          })}

          {hasMore && (
            <button
              onClick={() => fetchNotifications()}
              className={`w-full py-4 text-center transition ${
                isDark
                  ? 'hover:bg-white/5 text-white/80'
                  : 'hover:bg-gray-50 text-gray-800'
              }`}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default Notifications
