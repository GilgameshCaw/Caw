import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Link } from '~/utils/localizedRouter'
import { useUserByUsername } from '~/hooks/useUserData'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { UserAvatar } from './Avatar'
import { FollowButton } from './FollowButton'
import XBadge from '~/components/XBadge'

const SHOW_DELAY = 300
const HIDE_DELAY = 150

interface Props {
  username: string
  children: React.ReactNode
  /** Portal the card to <body> to avoid clipping in overflow-hidden/scroll containers. */
  portal?: boolean
}

const UserHoverCard: React.FC<Props> = ({ username, children, portal = false }) => {
  const [open, setOpen] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const anchorRef = useRef<HTMLSpanElement | null>(null)
  const [portalStyle, setPortalStyle] = useState<React.CSSProperties | null>(null)
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  // Fetch only once the card is intent-to-show; React Query caches across mounts.
  const { data: user } = useUserByUsername(open ? username : undefined)
  const isSelf = !!activeToken && user?.tokenId === activeToken.tokenId

  const clearTimers = () => {
    if (showTimer.current) { clearTimeout(showTimer.current); showTimer.current = null }
    if (hideTimer.current) { clearTimeout(hideTimer.current); hideTimer.current = null }
  }
  const handleEnter = () => {
    clearTimers()
    // If we're entering from a portaled card, open immediately to prevent flicker.
    if (open) {
      setOpen(true)
      return
    }
    showTimer.current = setTimeout(() => setOpen(true), SHOW_DELAY)
  }
  const handleLeave = () => {
    clearTimers()
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY)
  }
  useEffect(() => clearTimers, [])

  const recomputePortalStyle = useCallback(() => {
    if (!portal) return
    const el = anchorRef.current
    if (!el) return
    const r = el.getBoundingClientRect()

    const gap = 8
    const width = 288 // w-72
    const maxH = 280
    const viewportW = window.innerWidth
    const viewportH = window.innerHeight

    const left = Math.min(Math.max(8, r.left), viewportW - 8 - width)

    const spaceBelow = viewportH - r.bottom
    const willOpenAbove = spaceBelow < Math.min(maxH, 160)
    const top = willOpenAbove
      ? Math.max(8, r.top - gap)
      : Math.min(viewportH - 8, r.bottom + gap)

    setPortalStyle({
      left,
      top,
      width,
      transform: willOpenAbove ? 'translateY(-100%)' : undefined,
    })
  }, [portal])

  useLayoutEffect(() => {
    if (!portal) return
    if (!open) return
    recomputePortalStyle()
  }, [portal, open, recomputePortalStyle])

  useEffect(() => {
    if (!portal) return
    if (!open) return
    const onWin = () => recomputePortalStyle()
    window.addEventListener('resize', onWin)
    window.addEventListener('scroll', onWin, { capture: true, passive: true })
    return () => {
      window.removeEventListener('resize', onWin)
      window.removeEventListener('scroll', onWin, { capture: true } as EventListenerOptions)
    }
  }, [portal, open, recomputePortalStyle])

  const card = open ? (
    <div
      className={`hidden md:block ${portal ? 'fixed z-[200]' : 'absolute left-0 top-full mt-2 z-50'} w-72 p-4 rounded-2xl shadow-xl ${
        isDark ? 'bg-black border border-white/10' : 'bg-white border border-gray-200'
      }`}
      style={portal ? (portalStyle ?? undefined) : undefined}
      onMouseEnter={() => {
        // When portaled, treat the card as part of the hover target.
        clearTimers()
        setOpen(true)
      }}
      onMouseLeave={handleLeave}
    >
          {!user ? (
            <div className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Loading…</div>
          ) : (
            <>
              <div className="flex items-start justify-between gap-2 mb-2">
                <Link to={`/users/${user.username}`} className="block flex-shrink-0">
                  <div className="w-12 h-12 rounded-full overflow-hidden border border-gray-700">
                    <UserAvatar user={user} alt={user.username} size="small" className="w-full h-full rounded-full" />
                  </div>
                </Link>
                {!isSelf && (
                  <FollowButton
                    targetUserId={user.tokenId}
                    initialIsFollowing={!!user.isFollowing}
                    initialIsPending={!!user.followPending}
                    size="small"
                  />
                )}
              </div>
              <Link to={`/users/${user.username}`} className="block">
                <div className="flex items-center gap-1 min-w-0">
                  <div className={`font-semibold truncate ${isDark ? 'text-white' : 'text-black'}`}>
                    {user.displayName || user.username}
                  </div>
                  <XBadge
                    xHandle={user.xHandle}
                    xFollowerBucket={user.xFollowerBucket}
                    size="md"
                    className="shrink-0"
                  />
                </div>
                <div className={`text-sm truncate ${isDark ? 'text-white/50' : 'text-gray-500'}`}>@{user.username}</div>
              </Link>
              {user.bio && (
                <p className={`text-sm mt-2 line-clamp-3 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>{user.bio}</p>
              )}
              <div className={`flex gap-4 mt-3 text-sm ${isDark ? 'text-white/70' : 'text-gray-600'}`}>
                <span>
                  <strong className={isDark ? 'text-white' : 'text-black'}>{user.followingCount ?? 0}</strong> Following
                </span>
                <span>
                  <strong className={isDark ? 'text-white' : 'text-black'}>{user.followerCount ?? 0}</strong> Followers
                </span>
              </div>
            </>
          )}
    </div>
  ) : null

  return (
    <span ref={anchorRef} className="relative inline-block" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {portal ? (card ? createPortal(card, document.body) : null) : card}
    </span>
  )
}

export default UserHoverCard
