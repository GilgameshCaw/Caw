import React, { useEffect, useMemo, useState } from 'react'
import { useParams, Link, useSearchParams } from 'react-router-dom'
import PostForm from "~/components/PostForm";
import MainLayout from '~/layouts/MainLayout'
import FeedItem from '~/components/FeedItem'
import Avatar from '~/components/Avatar'
import { apiFetch } from '~/api/client'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore, useActiveToken } from '~/store/tokenDataStore'
import { HiArrowLeft, HiOutlineCurrencyDollar } from 'react-icons/hi'
import SignInModal from '~/components/modals/SignInModal'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { getUserAvatar } from '~/utils/defaultAvatar'
import Recaw from '~/assets/images/recaw.svg?react'

type IndicatorUser = {
  tokenId?: number
  username: string
  displayName?: string | null
  avatarUrl?: string | null
  image?: string | null
  defaultAvatarId?: number | null
}

type RecawIndicator = {
  id: string
  timestamp: string
  user: IndicatorUser
}

type TipIndicator = {
  id: string
  timestamp: string
  amount: number
  user: IndicatorUser
}

export const CawPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const [searchParams] = useSearchParams()
  const [caw, setCaw]           = useState<CawItem | null>(null)
  const [comments, setComments] = useState<CawItem[]>([])
  const [recaws, setRecaws]     = useState<RecawIndicator[]>([])
  const [tips, setTips]         = useState<TipIndicator[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const [initialLoadDone, setInitialLoadDone] = useState(false)
  const [hasMoreComments, setHasMoreComments] = useState(false)
  const [commentCursor, setCommentCursor] = useState<number | undefined>(undefined)
  const [loadingMore, setLoadingMore] = useState(false)
  const { isDark } = useTheme()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useActiveToken()
  const isAuthenticated = !!activeToken?.username
  const allPendingPosts = usePendingPostsStore(s => s.pendingPosts)
  // Pending posts targeted at this caw, excluding quotes — quotes are
  // standalone posts, not replies, so they don't belong in the reply
  // pending list. They'll appear in the page's quote section once confirmed.
  const pendingReplies = useMemo(
    () => allPendingPosts.filter(p =>
      p.replyToId === id && !(p.isQuote || (p.action === 'recaw' && p.content !== ''))
    ),
    [allPendingPosts, id]
  )

  // Interleave replies, plain recaws, and tips by timestamp (ascending), so
  // the post page reads chronologically as a single conversation. Quotes
  // (RECAW with content) are excluded from this sort — they're standalone
  // posts that just happen to reference this one, and slotting them
  // chronologically into the reply thread reads as if they were replies.
  // Pending replies still render separately above this list.
  // Quotes (RECAW with non-empty content) are standalone posts that just
  // happen to reference this one. They don't belong in the chronological
  // reply thread — slotting them by timestamp reads as if they were replies.
  // Detect them defensively: prefer the API-shaped isQuote flag, but fall
  // back to action+content in case isQuote isn't populated (optimistic
  // local items, future API shape drift).
  const isQuoteItem = (c: CawItem) =>
    c.isQuote === true || (c.action === 'RECAW' && !!c.content && c.content !== '')

  const feedItems = useMemo(() => {
    const replyItems = comments
      .filter(comm => {
        if (isQuoteItem(comm)) return false
        if (comm.status !== 'PENDING') return true
        const sig = `${comm.user.tokenId}:${comm.content?.trim()}`
        return !pendingReplies.some(p => `${p.user?.tokenId}:${p.content?.trim()}` === sig)
      })
      .map(comm => ({ kind: 'reply' as const, timestamp: comm.timestamp, comm }))
    const recawItems = recaws.map(r => ({ kind: 'recaw' as const, timestamp: r.timestamp, recaw: r }))
    const tipItems = tips.map(t => ({ kind: 'tip' as const, timestamp: t.timestamp, tip: t }))
    return [...replyItems, ...recawItems, ...tipItems].sort(
      (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    )
  }, [comments, recaws, tips, pendingReplies])

  // Quotes — kept in their original order from the API so they don't
  // shuffle under any of the merge logic above.
  const quotes = useMemo(() => comments.filter(isQuoteItem), [comments])
  const [showSignInModal, setShowSignInModal] = useState(false)
  const [pollingReplies, setPollingReplies] = useState(false)

  // If we arrived from a desktop Reply click, scroll/focus the reply form.
  useEffect(() => {
    if (searchParams.get('reply') !== '1') return
    if (!isAuthenticated) return
    // Wait for PostForm to render.
    requestAnimationFrame(() => {
      const el = document.getElementById('caw-reply-form')
      if (!el) return
      el.scrollIntoView({ block: 'start', behavior: 'smooth' })
      // Focus the first textarea inside the reply form.
      setTimeout(() => {
        const ta = el.querySelector('textarea') as HTMLTextAreaElement | null
        ta?.focus()
      }, 60)
    })
  }, [searchParams, isAuthenticated])

  // Function to refresh comments after posting a reply
  const refreshComments = async () => {
    try {
      const { caw: fetched, comments: fetchedComments, recaws: fetchedRecaws, tips: fetchedTips } =
        await apiFetch<{ caw: CawItem; comments: CawItem[]; recaws?: RecawIndicator[]; tips?: TipIndicator[] }>(`/api/caws/${id}`)
      setCaw(fetched)
      setComments(fetchedComments)
      setRecaws(fetchedRecaws || [])
      setTips(fetchedTips || [])
    } catch (error) {
      console.error('Error refreshing comments:', error)
    }
  }

  // Poll for updates when caw is pending
  useEffect(() => {
    if (!caw || caw.status !== 'PENDING') return

    const interval = setInterval(async () => {
      try {
        const { caw: fetched } =
          await apiFetch<{ caw: CawItem }>(`/api/caws/${id}`)
        setCaw(fetched)

        // Stop polling if no longer pending
        if (fetched.status !== 'PENDING') {
          clearInterval(interval)
        }
      } catch (error) {
        console.error('Error polling for caw updates:', error)
      }
    }, 2000) // Poll every 2 seconds

    return () => clearInterval(interval)
  }, [caw?.status, id])

  // Start polling when replyPending is set
  useEffect(() => {
    if (caw?.replyPending && !pollingReplies) setPollingReplies(true)
  }, [caw?.replyPending])

  // Poll for pending replies until both replyPending clears AND no PENDING comments remain
  useEffect(() => {
    if (!pollingReplies) return

    const interval = setInterval(async () => {
      try {
        const { caw: fetched, comments: fetchedComments, recaws: fetchedRecaws, tips: fetchedTips } =
          await apiFetch<{ caw: CawItem; comments: CawItem[]; recaws?: RecawIndicator[]; tips?: TipIndicator[] }>(`/api/caws/${id}`)

        setCaw(fetched)
        setComments(fetchedComments)
        setRecaws(fetchedRecaws || [])
        setTips(fetchedTips || [])
        const hasPendingComments = fetchedComments.some(c => c.status === 'PENDING')
        if (!fetched.replyPending && !hasPendingComments) {
          setPollingReplies(false)
        }
      } catch (error) {
        console.error('Error polling for reply updates:', error)
      }
    }, 3000)

    return () => clearInterval(interval)
  }, [pollingReplies, id])

  const loadMoreComments = async () => {
    if (!commentCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const data = await apiFetch<{ comments: CawItem[]; hasMoreComments?: boolean; nextCommentCursor?: number }>(
        `/api/caws/${id}?commentCursor=${commentCursor}&commentLimit=20`
      )
      setComments(prev => [...prev, ...data.comments])
      setHasMoreComments(!!data.hasMoreComments)
      setCommentCursor(data.nextCommentCursor)
    } catch (err) {
      console.error('Error loading more comments:', err)
    } finally {
      setLoadingMore(false)
    }
  }

  // Reset initial load state when navigating to a different caw
  useEffect(() => {
    setInitialLoadDone(false)
    setLoading(true)
  }, [id])

  // Load caw and comments - refetch when id or activeTokenId changes
  const loadCaw = async () => {
    try {
      if (!initialLoadDone) {
        setLoading(true)
      }
      setError(null)

      const data = await apiFetch<{ caw: CawItem; comments: CawItem[]; recaws?: RecawIndicator[]; tips?: TipIndicator[]; hasMoreComments?: boolean; nextCommentCursor?: number }>(`/api/caws/${id}`)
      setCaw(data.caw)
      setComments(data.comments)
      setRecaws(data.recaws || [])
      setTips(data.tips || [])
      setHasMoreComments(!!data.hasMoreComments)
      setCommentCursor(data.nextCommentCursor)
      setInitialLoadDone(true)
    } catch (err) {
      console.error('Error loading caw:', err)
      setError('Could not load post')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    loadCaw()
  }, [id, activeTokenId])

  const errorView = (message: string) => (
    <MainLayout>
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div className="w-12 h-12 mb-4 rounded-full bg-red-500/10 flex items-center justify-center">
          <svg className="w-6 h-6 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
        </div>
        <p className={`text-sm mb-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{message}</p>
        <button
          onClick={() => loadCaw()}
          className={`px-5 py-2 text-sm font-medium rounded-full transition cursor-pointer ${
            isDark ? 'bg-white/10 text-white hover:bg-white/20' : 'bg-gray-200 text-gray-900 hover:bg-gray-300'
          }`}
        >
          Try again
        </button>
      </div>
    </MainLayout>
  )

  if (loading) return <MainLayout><div className={`flex items-center justify-center h-64 ${isDark ? 'text-white' : 'text-gray-900'}`}>Loading…</div></MainLayout>
  if (error) return errorView(error)
  if (!caw) return errorView('Could not load post')

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header with back button and title */}
        <div className="flex items-center space-x-4 mb-6 pb-4 border-b border-white/20">
          <Link 
            to="/home" 
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer hover:bg-white/10 ${
              isDark ? 'text-white' : 'text-black'
            }`}
          >
            <HiArrowLeft className="w-6 h-6" />
          </Link>
          <h1 className={`text-xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Feed
          </h1>
        </div>

        {/* Main Post - Expanded View */}
        <div className="mb-6 relative">
          <div className="relative z-10">
            <FeedItem
              item={caw}
              isMainPost={true}
              onReplyStateChange={(cawId, replyPending) => {
                if (caw && caw.id === cawId) {
                  setCaw({ ...caw, replyPending })
                }
              }}
            />
          </div>
        </div>

        {/* Reply Form — only for authenticated users */}
        {isAuthenticated && (
          <div id="caw-reply-form" className="border-b border-white/20 mb-2">
            <PostForm
              replyTo={caw}
              onSuccess={() => {
                setCaw(prev => prev ? { ...prev, replyPending: true } : prev)
                refreshComments()
              }}
            />
          </div>
        )}

        {/* Comments Section */}
        {isAuthenticated ? (
          <div className="space-y-0 relative">
            {/* Quotes render at the top — they're their own posts, not part
                of the chronological reply thread below. */}
            {quotes.map((quote) => (
              <div key={`quote-${quote.id}`} className="relative">
                <FeedItem item={quote} hideParentPreview={true} />
              </div>
            ))}
            {pendingReplies.map((post) => (
              <div key={post.tempId} className="relative">
                <FeedItem item={post as CawItem} isReply={true} hideParentPreview={true} />
              </div>
            ))}
            {feedItems.map((entry) => {
              if (entry.kind === 'reply') {
                return (
                  <div key={`reply-${entry.comm.id}`} className="relative">
                    <FeedItem
                      item={entry.comm}
                      isReply={true}
                      hideParentPreview={true}
                      onLikeStateChange={(cawId, likePending) => {
                        setComments(current =>
                          current.map(item =>
                            item.id === cawId ? { ...item, likePending } : item
                          )
                        )
                      }}
                    />
                  </div>
                )
              }
              const indicatorUser = entry.kind === 'recaw' ? entry.recaw.user : entry.tip.user
              const indicatorKey  = entry.kind === 'recaw' ? `recaw-${entry.recaw.id}` : `tip-${entry.tip.id}`
              return (
                <Link
                  key={indicatorKey}
                  to={`/users/${indicatorUser.username}`}
                  className={`flex items-center gap-2 py-2 pr-1 pl-[15px] text-sm hover:underline ${
                    isDark ? 'text-gray-400' : 'text-gray-600'
                  }`}
                >
                  {entry.kind === 'recaw'
                    ? <Recaw className="w-4 h-4 opacity-60 flex-shrink-0 translate-y-1" />
                    : <HiOutlineCurrencyDollar className="w-4 h-4 opacity-60 flex-shrink-0" />
                  }
                  <div className="w-6 h-6 rounded-full overflow-hidden flex-shrink-0">
                    <Avatar
                      src={getUserAvatar(indicatorUser)}
                      alt={`${indicatorUser.username} avatar`}
                      className="w-full h-full rounded-full"
                      size="small"
                    />
                  </div>
                  <span className="truncate">
                    <span className={`font-medium ${isDark ? 'text-white' : 'text-black'}`}>
                      {indicatorUser.displayName || indicatorUser.username}
                    </span>
                    {entry.kind === 'recaw'
                      ? ' recawed this'
                      : ` tipped ${entry.tip.amount.toLocaleString()} CAW`
                    }
                  </span>
                </Link>
              )
            })}
            {hasMoreComments && (
              <button
                onClick={loadMoreComments}
                disabled={loadingMore}
                className={`w-full py-3 text-sm font-medium transition-colors ${
                  isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-600 hover:text-yellow-500'
                } disabled:opacity-50`}
              >
                {loadingMore ? 'Loading...' : 'Load more replies'}
              </button>
            )}
          </div>
        ) : (
          /* Gated replies — show count and sign-in prompt */
          (caw.commentCount ?? 0) > 0 ? (
            <button
              onClick={() => setShowSignInModal(true)}
              className={`w-full py-6 text-center rounded-lg border transition-colors cursor-pointer ${
                isDark
                  ? 'border-white/10 hover:border-yellow-500/40 hover:bg-yellow-500/5'
                  : 'border-gray-200 hover:border-yellow-500/40 hover:bg-yellow-50'
              }`}
            >
              <svg className="w-6 h-6 mx-auto mb-2 text-yellow-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <span className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                {caw.commentCount} {caw.commentCount === 1 ? 'reply' : 'replies'}
              </span>
              <span className={`block text-xs mt-1 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                Sign in to view and reply
              </span>
            </button>
          ) : (
            <div className={`py-6 text-center text-sm ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
              Sign in to be the first to reply
            </div>
          )
        )}

        <SignInModal
          isOpen={showSignInModal}
          onClose={() => setShowSignInModal(false)}
          message="Connect your wallet and create a username to view replies and join the conversation."
        />
      </div>
    </MainLayout>
  )
}
