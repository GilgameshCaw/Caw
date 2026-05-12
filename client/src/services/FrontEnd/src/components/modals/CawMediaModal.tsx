import React, { useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { HiArrowLeft, HiArrowRight, HiOutlineX } from 'react-icons/hi'

import FeedItem from '~/components/FeedItem'
import PostForm from '~/components/PostForm'
import SignInModal from '~/components/modals/SignInModal'
import { apiFetch } from '~/api/client'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore, useActiveToken } from '~/store/tokenDataStore'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { parseCawIdSlug } from '~/utils/cawUrl'
import { acquireScrollLock, releaseScrollLock } from '~/utils/scrollLock'

type MediaItem =
  | { kind: 'url'; src: string }
  | { kind: 'base64'; data: string }
  | { kind: 'shortImage'; code: string; originHost?: string }

// Local short-url resolver cache. (Same idea as ContentWithHashtags.)
const shortUrlCache = new Map<string, string | null>()

const cacheKey = (host: string | undefined, code: string) => (host ? `${host}|${code}` : code)
const resolverEndpoint = (host: string | undefined, code: string) => (host ? `${host}/api/shorturl/${code}` : `/api/shorturl/${code}`)
const extractShortUrlHost = (shortUrlText: string): string | undefined => {
  const m = shortUrlText.match(/^(https?:\/\/[^\/]+)\/s\//)
  return m ? m[1] : undefined
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

export default function CawMediaModal() {
  // Mounted from either /caws/:id (legacy) or /users/:username/caw/:idSlug
  // (canonical). Pull the numeric id from whichever shape is in the route.
  const params = useParams<{ id?: string; idSlug?: string }>()
  const id = params.id ?? (params.idSlug ? String(parseCawIdSlug(params.idSlug) ?? '') : undefined)
  const navigate = useNavigate()
  const location = useLocation()
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()
  const source = searchParams.get('source') || 'content'

  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useActiveToken()
  const isAuthenticated = !!activeToken?.username

  const [caw, setCaw] = useState<CawItem | null>(null)
  const [comments, setComments] = useState<CawItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showSignInModal, setShowSignInModal] = useState(false)
  // Mobile-only: bottom sheet (post + replies) over the image.
  const [mobileSheetOpen, setMobileSheetOpen] = useState(false)
  const allPendingPosts = usePendingPostsStore(s => s.pendingPosts)

  // Lock scroll while modal is open (iOS-aware via shared util).
  useEffect(() => {
    acquireScrollLock()
    return () => { releaseScrollLock() }
  }, [])

  // ESC closes modal (standard lightbox behavior).
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        navigate(-1)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [navigate])

  useEffect(() => {
    if (!id) return
    let cancelled = false
    const run = async () => {
      setLoading(true)
      setError(null)
      try {
        const data = await apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
        if (cancelled) return
        setCaw(data.caw)
        setComments(data.comments)
      } catch (e) {
        console.error('Failed to load caw for media modal:', e)
        if (cancelled) return
        setError('Could not load post')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    run()
    return () => {
      cancelled = true
    }
  }, [id, activeTokenId])

  const pendingReplies = useMemo(
    () => allPendingPosts.filter(p => p.replyToId === id),
    [allPendingPosts, id]
  )

  // Avoid rendering the same pending reply twice: PostForm adds an
  // optimistic pending reply to the store, and the API may also return a
  // mirrored PENDING reply object for the same content.
  const dedupedComments = useMemo(() => {
    if (!comments.length) return comments
    if (!pendingReplies.length) return comments
    const sigs = new Set(
      pendingReplies.map((p: any) => `${p?.user?.tokenId}:${String(p?.content ?? '').trim()}`)
    )
    return comments.filter((c) => {
      if (c.status !== 'PENDING') return true
      const sig = `${c?.user?.tokenId}:${String(c?.content ?? '').trim()}`
      return !sigs.has(sig)
    })
  }, [comments, pendingReplies])

  const mediaItems = useMemo<MediaItem[]>(() => {
    if (!caw) return []
    const out: MediaItem[] = []
    // Dedupe by logical file identity (filename/code), not full URL.
    // Some posts can surface the same image via different URL forms
    // (e.g. attached URL vs short-url resolution). If the user only has
    // one image, we should not render multi-image nav chrome.
    const seen = new Set<string>()

    const fileKeyFromUrl = (src: string): string | null => {
      if (!src) return null
      try {
        const u = new URL(src, window.location.origin)
        const path = u.pathname || ''
        const name = path.split('/').filter(Boolean).pop()
        return name ? `file:${name}` : null
      } catch {
        // Fallback for non-URL-ish strings.
        const noQuery = src.split('?')[0]
        const name = noQuery.split('/').filter(Boolean).pop()
        return name ? `file:${name}` : null
      }
    }

    const pushUrl = (src: string) => {
      const key = fileKeyFromUrl(src) || `url:${src}`
      if (!src || seen.has(key)) return
      seen.add(key)
      out.push({ kind: 'url', src })
    }

    const addContentMedia = () => {
      // Mirrors ContentWithHashtags extraction.
      const text = caw.content || ''
      const mediaMatches: { type: 'shortImage' | 'image'; data: string; code?: string; originHost?: string; position: number }[] = []
      const shortUrlWithExtPattern = /(?:https?:\/\/[^\s]+)?\/s\/([a-zA-Z0-9]+\.(gif|jpg|jpeg|png|webp))/g
      const imageUrlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/g

      let match: RegExpExecArray | null
      while ((match = shortUrlWithExtPattern.exec(text)) !== null) {
        const code = match[1]
        const full = match[0]
        mediaMatches.push({
          type: 'shortImage',
          data: full,
          code,
          originHost: extractShortUrlHost(full),
          position: match.index,
        })
      }

      while ((match = imageUrlPattern.exec(text)) !== null) {
        mediaMatches.push({
          type: 'image',
          data: match[0],
          position: match.index,
        })
      }

      mediaMatches.sort((a, b) => a.position - b.position)

      mediaMatches.forEach(m => {
        if (m.type === 'shortImage' && m.code) {
          const key = `file:${m.code}`
          if (seen.has(key)) return
          seen.add(key)
          out.push({ kind: 'shortImage', code: m.code, originHost: m.originHost })
          return
        }
        if (m.type === 'image') pushUrl(m.data)
      })
    }

    const addImageDataMedia = () => {
      if (caw.imageData) {
        if (caw.imageData.startsWith('urls:')) {
          caw.imageData.replace('urls:', '').split('|||').forEach(u => pushUrl(u))
        } else {
          caw.imageData.split('|||').filter(Boolean).forEach(b64 => {
            const key = `b64:${b64}`
            if (seen.has(key)) return
            seen.add(key)
            out.push({ kind: 'base64', data: b64 })
          })
        }
      } else if (caw.imageUrl) {
        pushUrl(caw.imageUrl)
      }
    }

    // IMPORTANT: Keep indices stable.
    // - source=imageData: only show attached media (imageData/imageUrl)
    // - source=content: only show media extracted from content
    // Fallback: if the chosen source produced nothing, try the other one.
    if (source === 'imageData') {
      addImageDataMedia()
      if (!out.length) addContentMedia()
    } else if (source === 'content') {
      addContentMedia()
      if (!out.length) addImageDataMedia()
    } else {
      addContentMedia()
      addImageDataMedia()
    }

    return out
  }, [caw, source])

  const requestedIndex = Number(searchParams.get('media') || '0')
  const activeIndex = clamp(Number.isFinite(requestedIndex) ? requestedIndex : 0, 0, Math.max(0, mediaItems.length - 1))

  // Keep URL param normalized when out of range.
  useEffect(() => {
    if (!mediaItems.length) return
    if (requestedIndex === activeIndex) return
    const next = new URLSearchParams(searchParams)
    next.set('media', String(activeIndex))
    setSearchParams(next, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeIndex, mediaItems.length])

  const setIndex = (nextIndex: number) => {
    const next = clamp(nextIndex, 0, Math.max(0, mediaItems.length - 1))
    const sp = new URLSearchParams(searchParams)
    sp.set('media', String(next))
    // IMPORTANT: preserve location.state.backgroundLocation.
    // If we drop state here, AppRoutes loses `backgroundLocation` and the modal unmounts.
    navigate(
      { search: `?${sp.toString()}` },
      { replace: true, state: location.state }
    )
  }

  const close = () => {
    navigate(-1)
  }

  const current = mediaItems[activeIndex]

  const postPanelInner = loading
    ? <div className={`${isDark ? 'text-white/70' : 'text-gray-700'}`}>Loading…</div>
    : error || !caw
      ? <div className={`${isDark ? 'text-white/70' : 'text-gray-700'}`}>{error || 'Could not load post'}</div>
      : (
        <>
          <FeedItem
            item={caw}
            isMainPost={true}
            hideMedia={true}
            uiDensity="compact"
            contentClassName="text-base md:text-lg leading-relaxed"
          />

          {/* Keep separators minimal in modal: FeedItem already includes its own divider. */}

          {isAuthenticated && (
            <PostForm
              replyTo={caw}
              onSuccess={() => {
                // Refresh replies after posting
                apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
                  .then(d => {
                    setCaw(d.caw)
                    setComments(d.comments)
                  })
                  .catch(() => {})
              }}
            />
          )}

          {/* Replies */}
          {isAuthenticated ? (
            <div className="space-y-0 mt-3">
              {pendingReplies.map((post: any) => (
                <div key={post.tempId} className="relative">
                  <FeedItem item={post as CawItem} isReply={true} hideParentPreview={true} hideMedia={true} uiDensity="compact" />
                </div>
              ))}

              {dedupedComments.map((comm) => (
                <div key={comm.id} className="relative">
                  <FeedItem item={comm} isReply={true} hideParentPreview={true} hideMedia={true} uiDensity="compact" />
                </div>
              ))}
            </div>
          ) : (
            (caw?.commentCount ?? 0) > 0 ? (
              <button
                onClick={() => setShowSignInModal(true)}
                className={`w-full py-6 text-center rounded-lg border transition-colors cursor-pointer mt-3 ${
                  isDark
                    ? 'border-white/10 hover:border-yellow-500/40 hover:bg-yellow-500/5'
                    : 'border-gray-200 hover:border-yellow-500/40 hover:bg-yellow-50'
                }`}
              >
                <span className={`text-sm font-medium ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                  {caw.commentCount} {caw.commentCount === 1 ? 'reply' : 'replies'}
                </span>
                <span className={`block text-xs mt-1 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                  Sign in to view and reply
                </span>
              </button>
            ) : (
              <div className={`py-6 text-center text-sm mt-3 ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                Sign in to be the first to reply
              </div>
            )
          )}
        </>
      )

  return (
      <div
        className="fixed inset-0 z-[9999] bg-black/90"
        onClick={(e) => {
          // Close on backdrop tap/click, WITHOUT click-through to the feed.
          if (e.target !== e.currentTarget) return
          e.preventDefault()
          e.stopPropagation()
          close()
        }}
      >
      {/* Close button (top-right) */}
      <button
        onClick={close}
        className="absolute top-4 right-4 z-10 p-2 rounded-full bg-black/60 text-white/80 hover:text-white hover:bg-black/80 transition-colors cursor-pointer"
        aria-label="Close"
      >
        <HiOutlineX className="w-6 h-6" />
      </button>

      <div className="absolute inset-0 flex flex-col md:flex-row">
        {/* LEFT PANEL: post + actions + comments */}
        <div className={`hidden md:block md:w-[300px] lg:w-[340px] xl:w-[380px] h-full overflow-hidden border-r ${isDark ? 'border-white/10 bg-black' : 'border-gray-200 bg-white'}`}>
          <div className="h-full overflow-y-auto">
            <div className="px-4 py-4">
              {postPanelInner}
            </div>
          </div>
        </div>

        {/* RIGHT PANEL: image viewer */}
        <div
          className="flex-1 h-full bg-transparent flex items-center justify-center relative overflow-hidden pb-16 md:pb-0"
          onPointerDown={(e) => {
            // Never let interactions inside the viewer close the modal.
            e.stopPropagation()

            // If the bottom sheet is open, a tap on the image area
            // (outside the sheet) should minimize it.
            if (e.pointerType === 'touch' && mobileSheetOpen) setMobileSheetOpen(false)
          }}
          onClick={(e) => {
            // Tap/click the empty area around the image closes the modal.
            // Use click (not pointerdown) to avoid click-through after unmount.
            if (e.target !== e.currentTarget) return
            e.preventDefault()
            e.stopPropagation()
            close()
          }}
        >
          {/* Nav arrows */}
          {mediaItems.length > 1 && (
            <>
              <button
                onClick={(e) => {
                  // Never let nav buttons click-through to the backdrop.
                  e.preventDefault()
                  e.stopPropagation()
                  if (activeIndex <= 0) return
                  setIndex(activeIndex - 1)
                }}
                aria-disabled={activeIndex <= 0}
                tabIndex={activeIndex <= 0 ? -1 : 0}
                className={`flex items-center justify-center absolute left-3 md:left-4 top-1/2 -translate-y-1/2 p-3 md:p-2 rounded-full bg-black/50 text-white/80 transition-colors cursor-pointer select-none ${
                  activeIndex <= 0
                    ? 'opacity-30 cursor-not-allowed'
                    : 'hover:text-white hover:bg-black/70'
                }`}
                aria-label="Previous"
              >
                <HiArrowLeft className="w-6 h-6" />
              </button>
              <button
                onClick={(e) => {
                  // Never let nav buttons click-through to the backdrop.
                  e.preventDefault()
                  e.stopPropagation()
                  if (activeIndex >= mediaItems.length - 1) return
                  setIndex(activeIndex + 1)
                }}
                aria-disabled={activeIndex >= mediaItems.length - 1}
                tabIndex={activeIndex >= mediaItems.length - 1 ? -1 : 0}
                className={`flex items-center justify-center absolute right-3 md:right-4 top-1/2 -translate-y-1/2 p-3 md:p-2 rounded-full bg-black/50 text-white/80 transition-colors cursor-pointer select-none ${
                  activeIndex >= mediaItems.length - 1
                    ? 'opacity-30 cursor-not-allowed'
                    : 'hover:text-white hover:bg-black/70'
                }`}
                aria-label="Next"
              >
                <HiArrowRight className="w-6 h-6" />
              </button>
            </>
          )}

          {/* Counter */}
          {mediaItems.length > 1 && (
            <div className="absolute bottom-4 right-4 text-xs text-white/70 bg-black/50 px-2 py-1 rounded-full">
              {activeIndex + 1}/{mediaItems.length}
            </div>
          )}

          <MediaViewerImage item={current} />
        </div>

        {/* MOBILE: bottom sheet for post + replies (mobile only) */}
        <div className="md:hidden fixed inset-x-0 bottom-0 z-[10000] pointer-events-none">
          <div
            className={`pointer-events-auto w-full rounded-t-2xl border-t ${
              isDark ? 'bg-black/95 border-white/10' : 'bg-white/95 border-gray-200'
            }`}
            style={{
              height: '75vh',
              transform: mobileSheetOpen
                ? 'translateY(0)'
                : 'translateY(calc(75vh - 64px))',
              transition: 'transform 220ms ease',
              backdropFilter: 'blur(10px)',
              WebkitBackdropFilter: 'blur(10px)'
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {/* Handle / header */}
            <button
              type="button"
              onClick={() => setMobileSheetOpen(v => !v)}
              className={`w-full px-4 pt-2 pb-3 flex flex-col items-center gap-2 cursor-pointer ${
                isDark ? 'text-white/70' : 'text-gray-700'
              }`}
              aria-expanded={mobileSheetOpen}
            >
              <span className={`h-1.5 w-12 rounded-full ${isDark ? 'bg-white/15' : 'bg-black/10'}`} />
              <div className="w-full flex items-center justify-between text-xs">
                <span className="font-medium">Post</span>
                <span className="opacity-70">
                  {caw?.commentCount ?? 0} {(caw?.commentCount ?? 0) === 1 ? 'reply' : 'replies'}
                </span>
              </div>
            </button>

            {/* Sheet content */}
            <div className="h-[calc(75vh-64px)] overflow-y-auto px-4 pb-6">
              <div className="pt-1">
                {postPanelInner}
              </div>
            </div>
          </div>
        </div>
      </div>

      <SignInModal
        isOpen={showSignInModal}
        onClose={() => setShowSignInModal(false)}
        message="Connect your wallet and create a username to view replies and join the conversation."
      />
    </div>
  )
}

function MediaViewerImage({ item }: { item?: MediaItem }) {
  const { isDark } = useTheme()
  // Resolve short URLs on demand for the currently active item.
  const resolved = useShortImageResolver(item)

  if (!item) {
    return <div className="text-white/60">No media</div>
  }

  if (item.kind === 'shortImage') {
    if (resolved.loading) {
      return <div className="w-[60vw] h-[60vh] max-w-[1100px] bg-white/10 rounded animate-pulse" />
    }
    if (!resolved.url) {
      return <div className={`${isDark ? 'text-white/60' : 'text-gray-700'}`}>Failed to load image</div>
    }
    return (
      <img
        src={resolved.url}
        alt="Post media"
        className="max-w-[95vw] md:max-w-full max-h-[70vh] md:max-h-[95vh] object-contain"
        onMouseDown={e => e.stopPropagation()}
      />
    )
  }

  const src = item.kind === 'base64'
    ? `data:image/jpeg;base64,${item.data}`
    : item.src

  return (
    <img
      src={src}
      alt="Post media"
      className="max-w-[95vw] md:max-w-full max-h-[70vh] md:max-h-[95vh] object-contain"
      onMouseDown={e => e.stopPropagation()}
    />
  )
}

function useShortImageResolver(item?: MediaItem): { url: string | null; loading: boolean } {
  const [state, setState] = useState<{ url: string | null; loading: boolean }>({ url: null, loading: false })

  useEffect(() => {
    if (!item || item.kind !== 'shortImage') {
      setState({ url: null, loading: false })
      return
    }

    const key = cacheKey(item.originHost, item.code)
    const cached = shortUrlCache.get(key)
    if (shortUrlCache.has(key)) {
      setState({ url: cached ?? null, loading: false })
      return
    }

    let cancelled = false
    setState({ url: null, loading: true })
    const endpoint = resolverEndpoint(item.originHost, item.code)

    const run = async () => {
      try {
        let data: any
        if (/^https?:\/\//.test(endpoint)) {
          const res = await fetch(endpoint)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          data = await res.json()
        } else {
          data = await apiFetch<any>(endpoint)
        }
        const url = data?.originalUrl ? String(data.originalUrl) : null
        shortUrlCache.set(key, url)
        if (!cancelled) setState({ url, loading: false })
      } catch (e) {
        console.error('Failed to resolve short image url:', e)
        shortUrlCache.set(key, null)
        if (!cancelled) setState({ url: null, loading: false })
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [item])

  return state
}
