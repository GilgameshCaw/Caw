import React, { useEffect, useMemo, useState } from 'react'
import { useParams, Link, useSearchParams, useNavigate } from 'react-router-dom'
import { useT } from '~/i18n/I18nProvider'
import PostForm from "~/components/PostForm";
import MainLayout from '~/layouts/MainLayout'
import FeedItem from '~/components/FeedItem'
import Avatar from '~/components/Avatar'
import { apiFetch } from '~/api/client'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore, useActiveToken } from '~/store/tokenDataStore'
import { HiArrowLeft, HiChevronRight } from 'react-icons/hi'
import SignInModal from '~/components/modals/SignInModal'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { getUserAvatar } from '~/utils/defaultAvatar'

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

type LikeIndicator = {
  id: string
  timestamp: string
  user: IndicatorUser
}

export const CawPage: React.FC = () => {
  const t = useT()
  const { id } = useParams<{ id: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const [caw, setCaw]           = useState<CawItem | null>(null)
  const [comments, setComments] = useState<CawItem[]>([])
  const [recaws, setRecaws]     = useState<RecawIndicator[]>([])
  const [tips, setTips]         = useState<TipIndicator[]>([])
  const [likes, setLikes]       = useState<LikeIndicator[]>([])
  const [likesLoaded, setLikesLoaded] = useState(false)
  const [likesLoading, setLikesLoading] = useState(false)
  const [likesError, setLikesError] = useState<string | null>(null)
  const [likesAttempted, setLikesAttempted] = useState(false)
  const [activeInteractionsTab, setActiveInteractionsTab] = useState<'likes' | 'comments' | 'reposts' | 'quotes' | 'tips'>('likes')
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

  // Quotes (RECAW with non-empty content) are standalone posts that just
  // happen to reference this one. They don't belong in the chronological
  // reply thread — slotting them by timestamp reads as if they were replies.
  // Detect them defensively: prefer the API-shaped isQuote flag, but fall
  // back to action+content in case isQuote isn't populated (optimistic
  // local items, future API shape drift).
  const isQuoteItem = (c: CawItem) =>
    c.isQuote === true || (c.action === 'RECAW' && !!c.content && c.content !== '')

  const feedItems = useMemo(() => {
    return comments
      .filter(comm => {
        if (isQuoteItem(comm)) return false
        if (comm.status !== 'PENDING') return true
        const sig = `${comm.user.tokenId}:${comm.content?.trim()}`
        return !pendingReplies.some(p => `${p.user?.tokenId}:${p.content?.trim()}` === sig)
      })
      .map(comm => ({ kind: 'reply' as const, timestamp: comm.timestamp, comm }))
      .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime())
  }, [comments, pendingReplies])

  // Quotes — kept in their original order from the API so they don't
  // shuffle under any of the merge logic above.
  const quotes = useMemo(() => comments.filter(isQuoteItem), [comments])

  const commentIndicators = useMemo(() => {
    return comments
      .filter(c => !isQuoteItem(c))
      .map(c => ({ id: c.id, timestamp: c.timestamp, user: c.user }))
  }, [comments])

  const quoteIndicators = useMemo(() => {
    return quotes.map(q => ({ id: q.id, timestamp: q.timestamp, user: q.user }))
  }, [quotes])

  const [showSignInModal, setShowSignInModal] = useState(false)
  const [pollingReplies, setPollingReplies] = useState(false)

  const view = (searchParams.get('view') || '').toLowerCase()
  const wantsInteractions = view === 'interactions'

  // Load likes list on-demand. Public endpoint — anyone viewing the
  // interactions tab loads it. Author-only is a UI gate, not an API gate.
  useEffect(() => {
    if (!id) return
    if (!wantsInteractions) return
    if (likesAttempted || likesLoaded || likesLoading) return
    if (!caw) return

    setLikesAttempted(true)
    setLikesLoading(true)
    setLikesError(null)
    apiFetch<{ likes: LikeIndicator[] }>(`/api/caws/${id}/likes`)
      .then(data => {
        setLikes(data.likes || [])
        setLikesLoaded(true)
      })
      .catch(err => {
        console.error('Error loading likes list:', err)
        // If the API route isn't deployed/restarted yet, the server may return
        // an HTML shell ("<!doctype ...") which blows up JSON parsing.
        const msg = (err instanceof SyntaxError)
          ? t('caw_page.likes_unavailable')
          : t('caw_page.likes_load_failed')
        setLikesError(msg)
        // Prevent an infinite retry loop.
        setLikesLoaded(false)
      })
      .finally(() => setLikesLoading(false))
  }, [wantsInteractions, id, likesAttempted, likesLoaded, likesLoading, caw, t])

  // Reset likes state when leaving interactions or switching posts
  useEffect(() => {
    // Reset on view toggle or post change so a new attempt can happen.
    setLikesAttempted(false)
    setLikesLoaded(false)
    setLikesLoading(false)
    setLikesError(null)
    setLikes([])
  }, [wantsInteractions, id])

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
      setError(t('caw_page.could_not_load_post'))
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
          {t('common.try_again')}
        </button>
      </div>
    </MainLayout>
  )

  if (loading) return <MainLayout><div className={`flex items-center justify-center h-64 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('common.loading')}</div></MainLayout>
  if (error) return errorView(error)
  if (!caw) return errorView(t('caw_page.could_not_load_post'))

  const viewerTokenId = activeTokenId ?? activeToken?.tokenId
  const isOwnPost = viewerTokenId !== undefined && caw.user.tokenId === viewerTokenId
  const canShowInteractions = isAuthenticated && isOwnPost
  const showingInteractions = wantsInteractions && canShowInteractions

  const tabLabels: { key: 'likes' | 'comments' | 'reposts' | 'quotes' | 'tips'; label: string }[] = [
    {
      key: 'likes',
      label: t('caw_page.tab.likes_count', { count: likesLoaded ? likes.length : (caw.likeCount ?? 0) }),
    },
    {
      key: 'comments',
      label: commentIndicators.length
        ? t('caw_page.tab.comments_count', { count: commentIndicators.length })
        : t('caw_page.tab.comments'),
    },
    {
      key: 'reposts',
      label: recaws.length
        ? t('caw_page.tab.recaws_count', { count: recaws.length })
        : t('caw_page.tab.recaws'),
    },
    {
      key: 'quotes',
      label: quoteIndicators.length
        ? t('caw_page.tab.quotes_count', { count: quoteIndicators.length })
        : t('caw_page.tab.quotes'),
    },
    {
      key: 'tips',
      label: tips.length
        ? t('caw_page.tab.tips_count', { count: tips.length })
        : t('caw_page.tab.tips'),
    },
  ]

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header with back button and title */}
        <div className="flex items-center space-x-4 mb-6 pb-4 border-b border-white/20">
          {showingInteractions ? (
            <button
              onClick={() => {
                if (window.history.state && window.history.state.idx > 0) {
                  navigate(-1)
                } else {
                  const next = new URLSearchParams(searchParams)
                  next.delete('view')
                  setSearchParams(next, { replace: true })
                }
              }}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer hover:bg-white/10 ${
                isDark ? 'text-white' : 'text-black'
              }`}
              aria-label={t('caw_page.back')}
            >
              <HiArrowLeft className="w-6 h-6" />
            </button>
          ) : (
            <button
              onClick={() => {
                if (window.history.state && window.history.state.idx > 0) {
                  navigate(-1)
                } else {
                  navigate('/home')
                }
              }}
              className={`p-2 rounded-full transition-all duration-200 cursor-pointer hover:bg-white/10 ${
                isDark ? 'text-white' : 'text-black'
              }`}
              aria-label={t('caw_page.back')}
            >
              <HiArrowLeft className="w-6 h-6" />
            </button>
          )}
          <h1 className={`text-xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {showingInteractions ? t('caw_page.interactions_title') : t('caw_page.feed_title')}
          </h1>
        </div>

        {/* Main content area: Post view OR Interactions view */}
        {showingInteractions ? (
          <div>
            <div className={`rounded-2xl border overflow-hidden ${isDark ? 'border-white/10 bg-black' : 'border-gray-200 bg-white'}`}>
              {/* Tabs */}
              <div className={`grid grid-cols-5 border-b ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                {tabLabels.map(tab => (
                  <button
                    key={tab.key}
                    onClick={() => setActiveInteractionsTab(tab.key)}
                    className={`w-full py-3 px-2 text-xs sm:text-sm font-semibold transition-colors cursor-pointer text-center min-w-0 ${
                      activeInteractionsTab === tab.key
                        ? (isDark ? 'text-white border-b-2 border-yellow-500' : 'text-black border-b-2 border-yellow-500')
                        : (isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black')
                    }`}
                  >
                    <span className="block truncate" title={tab.label}>{tab.label}</span>
                  </button>
                ))}
              </div>

              {/* Content */}
              <div className="p-4">
                {activeInteractionsTab === 'likes' && (
                  <div>
                    {likesError && (
                      <div className={`text-sm ${isDark ? 'text-red-400' : 'text-red-600'}`}>{likesError}</div>
                    )}
                    {!likesError && likesLoading && (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('common.loading')}</div>
                    )}
                    {!likesError && !likesLoading && likes.length === 0 && (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.likes')}</div>
                    )}
                    {!likesError && !likesLoading && likes.length > 0 && (
                      <div className="space-y-3">
                        {likes.map(l => (
                          <Link
                            key={`like-${l.id}`}
                            to={`/users/${l.user.username}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-gray-700">
                              <Avatar src={getUserAvatar(l.user)} alt={t('caw_page.user_avatar_alt', { username: l.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {l.user.displayName || l.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">@{l.user.username}</div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeInteractionsTab === 'comments' && (
                  <div>
                    {commentIndicators.length === 0 ? (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.comments')}</div>
                    ) : (
                      <div className="space-y-3">
                        {[...commentIndicators].reverse().map(c => (
                          <Link
                            key={`comment-${c.id}`}
                            to={`/users/${c.user.username}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-gray-700">
                              <Avatar src={getUserAvatar(c.user)} alt={t('caw_page.user_avatar_alt', { username: c.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {c.user.displayName || c.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">@{c.user.username}</div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeInteractionsTab === 'reposts' && (
                  <div>
                    {recaws.length === 0 ? (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.reposts')}</div>
                    ) : (
                      <div className="space-y-3">
                        {[...recaws].reverse().map(r => (
                          <Link
                            key={`repost-${r.id}`}
                            to={`/users/${r.user.username}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-gray-700">
                              <Avatar src={getUserAvatar(r.user)} alt={t('caw_page.user_avatar_alt', { username: r.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {r.user.displayName || r.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">@{r.user.username}</div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeInteractionsTab === 'quotes' && (
                  <div>
                    {quoteIndicators.length === 0 ? (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.quotes')}</div>
                    ) : (
                      <div className="space-y-3">
                        {[...quoteIndicators].reverse().map(q => (
                          <Link
                            key={`quote-${q.id}`}
                            to={`/users/${q.user.username}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-gray-700">
                              <Avatar src={getUserAvatar(q.user)} alt={t('caw_page.user_avatar_alt', { username: q.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {q.user.displayName || q.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">@{q.user.username}</div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeInteractionsTab === 'tips' && (
                  <div>
                    {tips.length === 0 ? (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.tips')}</div>
                    ) : (
                      <div className="space-y-3">
                        {[...tips].reverse().map(tp => (
                          <Link
                            key={`tip-${tp.id}`}
                            to={`/users/${tp.user.username}`}
                            className="flex items-center gap-3 hover:underline"
                          >
                            <div className="w-9 h-9 rounded-full overflow-hidden flex-shrink-0 border border-gray-700">
                              <Avatar src={getUserAvatar(tp.user)} alt={t('caw_page.user_avatar_alt', { username: tp.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {tp.user.displayName || tp.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">
                                {t('caw_page.tip_indicator', { username: tp.user.username, amount: tp.amount.toLocaleString() })}
                              </div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        ) : (
          <>
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

            {/* Author-only interactions entrypoint (desktop only) */}
            {canShowInteractions && (
              <div className="-mt-4 mb-6">
                <div className="flex items-center justify-end">
                  <button
                    onClick={() => {
                      const next = new URLSearchParams(searchParams)
                      next.set('view', 'interactions')
                      setSearchParams(next)
                    }}
                    className={`inline-flex items-center gap-1 text-sm font-medium transition-colors cursor-pointer ${
                      isDark ? 'text-gray-400 hover:text-white' : 'text-gray-600 hover:text-black'
                    }`}
                  >
                    {t('caw_page.view_interactions')}
                    <HiChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

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
                })}
                {hasMoreComments && (
                  <button
                    onClick={loadMoreComments}
                    disabled={loadingMore}
                    className={`w-full py-3 text-sm font-medium transition-colors ${
                      isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-yellow-600 hover:text-yellow-500'
                    } disabled:opacity-50`}
                  >
                    {loadingMore ? t('common.loading') : t('caw_page.load_more_replies')}
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
                    {t('caw_page.replies_count', { count: caw.commentCount ?? 0 })}
                  </span>
                  <span className={`block text-xs mt-1 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                    {t('caw_page.sign_in_to_view_and_reply')}
                  </span>
                </button>
              ) : (
                <div className={`py-6 text-center text-sm ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                  {t('caw_page.sign_in_to_be_first')}
                </div>
              )
            )}

          </>
        )}

        <SignInModal
          isOpen={showSignInModal}
          onClose={() => setShowSignInModal(false)}
          message={t('caw_page.sign_in_modal_message')}
        />
      </div>
    </MainLayout>
  )
}
