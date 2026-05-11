import React, { useEffect, useMemo, useState } from 'react'
import { useParams, Link, useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { useT } from '~/i18n/I18nProvider'
import PostForm from "~/components/PostForm";
import FeedItem from '~/components/FeedItem'
import { UserAvatar } from '~/components/Avatar'
import { apiFetch, RemovedCawError } from '~/api/client'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore, useActiveToken } from '~/store/tokenDataStore'
import { HiArrowLeft, HiChevronRight } from 'react-icons/hi'
import SignInModal from '~/components/modals/SignInModal'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { formatTimeAgo } from '~/utils/formatTimeAgo'
import { cawUrl, parseCawIdSlug } from '~/utils/cawUrl'

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
  // Route can be either the legacy /caws/:id or the canonical
  // /users/:username/caw/:idSlug. The numeric id is the only piece used
  // for lookup; username + slug are decorative + canonical-redirected.
  const params = useParams<{ id?: string; idSlug?: string; username?: string }>()
  // Legacy /caws/:id passes raw id (can be `pending-...`). Canonical
  // /users/:username/caw/:idSlug has only numeric ids — parseCawIdSlug
  // strips the slug suffix.
  const id = params.id ?? (params.idSlug ? String(parseCawIdSlug(params.idSlug) ?? '') : undefined)
  const [searchParams, setSearchParams] = useSearchParams()
  const navigate = useNavigate()
  const location = useLocation()
  // Pre-seed `caw` from location.state.caw when the user clicked through
  // from a feed — FeedItem passes the in-memory post so we can render
  // immediately. Replies/recaws/tips aren't in the seed, so those still
  // load from the API. The seed only matches when its id equals the
  // route id (defensive: a stale state from a different post would be
  // worse than no seed).
  const seededCaw = (location.state as { caw?: CawItem } | null)?.caw
  const [caw, setCaw]           = useState<CawItem | null>(
    seededCaw && String(seededCaw.id) === id ? seededCaw : null,
  )
  // Tempo-id route — the user clicked a pending caw whose id is still a
  // FE-only `pending-<timestamp>-<random>` tempId. There is no row at
  // /api/caws/<tempId> yet (the server would 404), so we rely entirely on
  // the seed + pendingPostsStore until the on-chain confirmation flips
  // the tempId to a real numeric DB id (see redirect effect below).
  const isTempIdRoute = !!id && id.startsWith('pending-')
  const [comments, setComments] = useState<CawItem[]>([])
  const [recaws, setRecaws]     = useState<RecawIndicator[]>([])
  const [tips, setTips]         = useState<TipIndicator[]>([])
  const [likes, setLikes]       = useState<LikeIndicator[]>([])
  const [likesLoaded, setLikesLoaded] = useState(false)
  const [likesLoading, setLikesLoading] = useState(false)
  const [likesError, setLikesError] = useState<string | null>(null)
  const [likesAttempted, setLikesAttempted] = useState(false)
  const [activeInteractionsTab, setActiveInteractionsTab] = useState<'likes' | 'comments' | 'reposts' | 'quotes' | 'tips'>('likes')
  // `loading` covers the post itself; `commentsLoading` covers replies/
  // recaws/tips. When we have a seed, we skip the post-loading state but
  // still show a small loader below the post for the comments fetch.
  const [loading, setLoading]   = useState(!seededCaw)
  const [commentsLoading, setCommentsLoading] = useState(true)
  const [error, setError]       = useState<string | null>(null)
  // Set when /api/caws/:id returned 410 (caw hidden by author). Null on
  // every other status. Author handle is `null` when the server couldn't
  // resolve it (rare — author rows are populated by the indexer).
  const [removedBy, setRemovedBy] = useState<{ author: string | null } | null>(null)
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

  // Load likes list on-demand when the user opens the interactions tab.
  // Public endpoint — interactions are visible to any authenticated viewer.
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

  // Poll for updates when caw is pending. Skip on tempId routes — there's
  // no DB row to fetch yet; the redirect effect above will move us to the
  // real id as soon as the pending-posts store learns it.
  useEffect(() => {
    if (!caw || caw.status !== 'PENDING') return
    if (isTempIdRoute) return

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

  // Reset initial load state when navigating to a different caw. Only
  // flip `loading` back on if we DON'T have a fresh seed for the new
  // route — a click-through from another feed item passes the post in
  // location state (see FeedItem.handleCardClick) so the post itself
  // can render synchronously while replies/tips/recaws fetch below.
  useEffect(() => {
    const hasSeed = !!(location.state as { caw?: CawItem } | null)?.caw &&
                    String((location.state as { caw?: CawItem }).caw!.id) === id
    if (!hasSeed) setLoading(true)
    setCommentsLoading(true)
  }, [id])

  // Load caw and comments - refetch when id or activeTokenId changes
  const loadCaw = async () => {
    try {
      setError(null)
      setRemovedBy(null)

      const data = await apiFetch<{ caw: CawItem; comments: CawItem[]; recaws?: RecawIndicator[]; tips?: TipIndicator[]; hasMoreComments?: boolean; nextCommentCursor?: number }>(`/api/caws/${id}`)
      setCaw(data.caw)
      setComments(data.comments)
      setRecaws(data.recaws || [])
      setTips(data.tips || [])
      setHasMoreComments(!!data.hasMoreComments)
      setCommentCursor(data.nextCommentCursor)
    } catch (err) {
      // 410 → caw was hidden by its author. Render a tombstone instead
      // of the generic "could not load" path so deep-links from old
      // notifications / shares are at least informative.
      if (err instanceof RemovedCawError) {
        setRemovedBy({ author: err.author })
        setCaw(null)
      } else {
        console.error('Error loading caw:', err)
        setError(t('caw_page.could_not_load_post'))
      }
    } finally {
      setLoading(false)
      setCommentsLoading(false)
    }
  }
  useEffect(() => {
    if (isTempIdRoute) {
      // Render-from-seed only. Flip loading off so the spinner doesn't
      // hang; the redirect effect below will swap us to the real id once
      // the confirmation lands.
      setLoading(false)
      setCommentsLoading(false)
      return
    }
    loadCaw()
  }, [id, activeTokenId])

  // Redirect from /caws/pending-<tempId> to /caws/<realId> the moment the
  // pending-posts store flips the matching post's id to its real numeric
  // DB id (happens when the indexer confirms the action). We match by
  // tempId to avoid colliding with unrelated pending posts.
  useEffect(() => {
    if (!isTempIdRoute) return
    const matched = allPendingPosts.find(p => p.tempId === id)
    if (!matched) return
    const realId = matched.id
    if (typeof realId === 'string' && realId.startsWith('pending-')) return
    if (String(realId) === id) return
    navigate(`/caws/${realId}`, { replace: true, state: { caw: matched } })
  }, [allPendingPosts, id, isTempIdRoute, navigate])

  // Canonical-URL redirect. Once we have the caw, snap the address bar
  // to /users/<username>/caw/<id>-<slug>. Covers legacy /caws/:id hits,
  // stale usernames (token transfer), and stale slugs (post edit). Only
  // runs when the target differs from the current path so it never loops.
  useEffect(() => {
    if (!caw) return
    if (isTempIdRoute) return
    const canonical = cawUrl(caw)
    if (canonical === location.pathname) return
    // Preserve the query string (e.g. ?reply=1, ?media=N) when redirecting.
    const target = location.search ? `${canonical}${location.search}` : canonical
    navigate(target, { replace: true, state: location.state })
  }, [caw, isTempIdRoute, location.pathname, location.search, location.state, navigate])

  const errorView = (message: string) => (
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
  )

  // Full-page loader only when we have nothing to render — i.e. no
  // location-state seed AND the API hasn't returned. With a seed the
  // post itself renders synchronously and the small in-place loader
  // below the post (gated on commentsLoading) covers the API leg.
  if (loading && !caw) return <><div className={`flex items-center justify-center h-64 ${isDark ? 'text-white' : 'text-gray-900'}`}>{t('common.loading')}</div></>
  if (error && !caw) return errorView(error)
  // Removed-by-author tombstone. Distinct from a generic "not found"
  // so the deep-link from a stale notification is at least informative
  // about WHY the page is blank.
  if (removedBy) {
    return (
      <div className="flex flex-col items-center justify-center py-16 px-6 text-center">
        <div className={`w-12 h-12 mb-4 rounded-full flex items-center justify-center ${
          isDark ? 'bg-white/5 text-white/40' : 'bg-gray-100 text-gray-400'
        }`}>
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V3.5A1.5 1.5 0 0110.5 2h3A1.5 1.5 0 0115 3.5V7" />
          </svg>
        </div>
        <p className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
          {removedBy.author
            ? `This post has been removed by its author (@${removedBy.author}).`
            : 'This post has been removed by its author.'}
        </p>
      </div>
    )
  }
  if (!caw) return errorView(t('caw_page.could_not_load_post'))

  const canShowInteractions = isAuthenticated
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
      <div
        className="max-w-2xl mx-auto px-6 py-4"
        style={{ paddingBottom: 'calc(var(--bottom-nav-h, 0px) + 96px)' }}
      >
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
                              <UserAvatar user={l.user} alt={t('caw_page.user_avatar_alt', { username: l.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {l.user.displayName || l.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">
                                @{l.user.username} · {formatTimeAgo(l.timestamp)}
                              </div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeInteractionsTab === 'comments' && (
                  <div>
                    {/* Render replies as full FeedItems — same render path the
                        thread uses below. Newest first to match the user's
                        mental model of "who replied recently". hideParentPreview
                        because the parent IS this page; rendering it inside
                        each reply would just be the same post, six times. */}
                    {comments.filter(c => !isQuoteItem(c)).length === 0 ? (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.comments')}</div>
                    ) : (
                      <div className="space-y-0">
                        {comments
                          .filter(c => !isQuoteItem(c))
                          .slice()
                          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                          .map(c => (
                            <div key={`reply-tab-${c.id}`} className="relative">
                              <FeedItem item={c} isReply={true} hideParentPreview={true} />
                            </div>
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
                              <UserAvatar user={r.user} alt={t('caw_page.user_avatar_alt', { username: r.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {r.user.displayName || r.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">
                                @{r.user.username} · {formatTimeAgo(r.timestamp)}
                              </div>
                            </div>
                          </Link>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {activeInteractionsTab === 'quotes' && (
                  <div>
                    {/* Quotes as FeedItems — they ARE standalone posts, so
                        rendering them in their full form is the natural read.
                        hideParentPreview for the same reason as replies: the
                        parent is this page. */}
                    {quotes.length === 0 ? (
                      <div className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>{t('caw_page.empty.quotes')}</div>
                    ) : (
                      <div className="space-y-0">
                        {quotes
                          .slice()
                          .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
                          .map(q => (
                            <div key={`quote-tab-${q.id}`} className="relative">
                              <FeedItem item={q} hideParentPreview={true} />
                            </div>
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
                              <UserAvatar user={tp.user} alt={t('caw_page.user_avatar_alt', { username: tp.user.username })} className="w-full h-full rounded-full" size="small" />
                            </div>
                            <div className="min-w-0 flex-1">
                              <div className={`text-sm font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                                {tp.user.displayName || tp.user.username}
                              </div>
                              <div className="text-xs truncate text-gray-500">
                                {t('caw_page.tip_indicator', { username: tp.user.username, amount: tp.amount.toLocaleString() })} · {formatTimeAgo(tp.timestamp)}
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
              {/* Pending indicator. Visible to anyone who deep-links to a
                  caw before its on-chain confirmation lands. The page's
                  pending-poll loop (above) flips this off automatically
                  when the status changes — no reload needed. */}
              {caw.status === 'PENDING' && (
                <div className={`mb-3 flex items-center gap-2 px-3 py-1.5 rounded-md text-xs font-medium ${
                  isDark
                    ? 'bg-yellow-500/10 text-yellow-300 border border-yellow-500/20'
                    : 'bg-yellow-50 text-yellow-800 border border-yellow-200'
                }`}>
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-500 animate-pulse" />
                  <span>Pending — waiting for on-chain confirmation</span>
                </div>
              )}
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

            {/* Interactions entrypoint — visible to any authenticated viewer */}
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
                {/* In-place loader when we rendered the post synchronously
                    from a feed-click seed but the API call for replies/
                    quotes/recaws/tips hasn't returned yet. Only shows
                    when we have nothing to render — once the API lands
                    (or pending replies are present), it disappears. */}
                {commentsLoading && comments.length === 0 && pendingReplies.length === 0 && (
                  <div className={`py-8 text-center text-sm ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
                    {t('common.loading')}
                  </div>
                )}
                {/* Quotes render at the top — they're their own posts, not part
                    of the chronological reply thread below. */}
                {quotes.map((quote) => (
                  <div key={`quote-${quote.id}`} className="relative">
                    <FeedItem item={quote} hideParentPreview={true} />
                  </div>
                ))}
                {/* Replies are oldest-first (feedItems is sorted asc by
                    timestamp), so pending replies render AFTER the
                    confirmed list to match where they'll land once the
                    chain catches up. Otherwise the user sees their fresh
                    pending reply at the top, then it visibly jumps to
                    the bottom on refresh. */}
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
                {pendingReplies.map((post) => (
                  <div key={post.tempId} className="relative">
                    <FeedItem item={post as CawItem} isReply={true} hideParentPreview={true} />
                  </div>
                ))}
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
  )
}
