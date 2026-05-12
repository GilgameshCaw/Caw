import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
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
}

const UserHoverCard: React.FC<Props> = ({ username, children }) => {
  const [open, setOpen] = useState(false)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
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
    showTimer.current = setTimeout(() => setOpen(true), SHOW_DELAY)
  }
  const handleLeave = () => {
    clearTimers()
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY)
  }
  useEffect(() => clearTimers, [])

  return (
    <span className="relative inline-block" onMouseEnter={handleEnter} onMouseLeave={handleLeave}>
      {children}
      {open && (
        <div
          className={`hidden md:block absolute left-0 top-full mt-2 z-50 w-72 p-4 rounded-2xl shadow-xl ${
            isDark ? 'bg-black border border-white/10' : 'bg-white border border-gray-200'
          }`}
          onMouseEnter={handleEnter}
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
      )}
    </span>
  )
}

export default UserHoverCard
