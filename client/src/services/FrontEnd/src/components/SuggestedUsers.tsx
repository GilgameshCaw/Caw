import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { FollowButton } from './FollowButton'
import { HiOutlineX } from 'react-icons/hi'
import { getUserAvatar } from '~/utils/defaultAvatar'
import { LoadingSpinner } from '~/components/Skeleton'


const DISMISSED_KEY = 'caw-dismissed-suggestions'

function getDismissedIds(): number[] {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]')
  } catch { return [] }
}

function dismissUser(tokenId: number) {
  const ids = getDismissedIds()
  if (!ids.includes(tokenId)) {
    ids.push(tokenId)
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids))
  }
}

interface SuggestedUser {
  tokenId: number
  username: string
  displayName: string | null
  avatarUrl: string | null
  image: string | null
  defaultAvatarId: number | null
  followerCount: number
  likeCount: number
  isFollowing: boolean
  followPending: boolean
}

// Module-level cache so suggested users survive navigation
let cachedUsers: SuggestedUser[] | null = null
let cacheTokenId: number | undefined

interface SuggestedUsersProps {
  onFollowChange?: () => void
}

const SuggestedUsers: React.FC<SuggestedUsersProps> = ({ onFollowChange }) => {
  const { isDark } = useTheme()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const hasCachedData = cachedUsers !== null && cacheTokenId === activeTokenId
  const [users, setUsers] = useState<SuggestedUser[]>(hasCachedData ? cachedUsers! : [])
  const [loading, setLoading] = useState(!hasCachedData)
  // Track users that have been confirmed followed and are fading out
  const [fadingOutIds, setFadingOutIds] = useState<Set<number>>(new Set())
  // Track users that have been fully removed after fade-out
  const [removedIds, setRemovedIds] = useState<Set<number>>(new Set())
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(() => new Set(getDismissedIds()))
  const hasFetchedRef = useRef(false)

  useEffect(() => {
    if (hasFetchedRef.current) return
    hasFetchedRef.current = true

    const fetchUsers = async () => {
      try {
        const response = await apiFetch<{ users: SuggestedUser[] }>('/api/users/top-followed?limit=10')
        const filtered = response.users.filter(u => u.tokenId !== activeTokenId)
        setUsers(filtered)
        cachedUsers = filtered
        cacheTokenId = activeTokenId
      } catch (err) {
        console.error('Failed to fetch suggested users:', err)
      } finally {
        setLoading(false)
      }
    }

    fetchUsers()
  }, [activeTokenId])

  // Called when follow is fully confirmed (pending resolved to following)
  const handleFollowConfirmed = useCallback((tokenId: number) => {
    onFollowChange?.()
    // Update cache so the followed user doesn't reappear on navigation
    if (cachedUsers) {
      cachedUsers = cachedUsers.map(u => u.tokenId === tokenId ? { ...u, isFollowing: true } : u)
    }
    // Wait 2 seconds showing "Following" state, then start fade-out
    setTimeout(() => {
      setFadingOutIds(prev => new Set(prev).add(tokenId))
      // After fade animation (700ms), remove from list
      setTimeout(() => {
        setRemovedIds(prev => new Set(prev).add(tokenId))
        setFadingOutIds(prev => {
          const next = new Set(prev)
          next.delete(tokenId)
          return next
        })
      }, 700)
    }, 2000)
  }, [onFollowChange])

  const handleDismiss = useCallback((tokenId: number) => {
    dismissUser(tokenId)
    setDismissedIds(prev => new Set(prev).add(tokenId))
    // Update cache so dismissed user doesn't reappear on navigation
    if (cachedUsers) {
      cachedUsers = cachedUsers.filter(u => u.tokenId !== tokenId)
    }
  }, [])

  const formatCount = (count: number) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
    return count.toString()
  }

  if (loading) {
    return <LoadingSpinner className="py-8" />
  }

  const visibleUsers = users.filter(u =>
    u.tokenId !== activeTokenId && !removedIds.has(u.tokenId) && !dismissedIds.has(u.tokenId) && !u.isFollowing && !u.followPending
  )

  if (visibleUsers.length <= 1) {
    return null
  }

  return (
    <div className={`pt-4 mb-3 rounded-xl ${
      isDark ? 'bg-black' : 'bg-gray-100 border border-gray-200 shadow-inner'
    }`}>
      <h2 className={`text-lg font-semibold mb-4 ml-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
        Suggested users to follow
      </h2>
      <div className={`flex gap-3 overflow-x-auto overflow-y-visible pb-[20px] transition-all duration-500 ${visibleUsers.length <= 3 ? 'justify-center' : ''}`}>
        {visibleUsers.map((user, idx) => {
          const isFadingOut = fadingOutIds.has(user.tokenId)
          const isFirst = idx === 0
          const isLast = idx === visibleUsers.length - 1
          return (
            <div
              key={user.tokenId}
              className={`relative rounded-xl p-4 shrink-0 transition-all duration-700 ease-in-out ${
                isDark
                  ? 'bg-white/5 hover:bg-white/10'
                  : 'bg-white hover:bg-gray-50 shadow-lg border border-gray-200'
              }`}
              style={{
                width: isFadingOut ? '0%' : '33%',
                minWidth: isFadingOut ? '0' : '165px',
                opacity: isFadingOut ? 0 : 1,
                padding: isFadingOut ? '0' : undefined,
                overflow: isFadingOut ? 'hidden' : 'visible',
                marginLeft: isFirst ? '20px' : undefined,
                marginRight: isLast ? '20px' : undefined,
              }}
            >
              {/* Dismiss button */}
              <button
                onClick={() => handleDismiss(user.tokenId)}
                className={`absolute top-2 right-2 p-1 rounded-full transition-opacity cursor-pointer ${
                  isDark ? 'hover:bg-white/10 text-white/40 hover:text-white/70' : 'hover:bg-gray-200 text-gray-400 hover:text-gray-600'
                }`}
                style={{ opacity: 0.4 }}
              >
                <HiOutlineX className="w-4 h-4" />
              </button>

              <Link to={`/users/${user.username}`} className="block text-center">
                <div className="w-16 h-16 rounded-full mx-auto mb-1 overflow-hidden">
                  <img
                    src={getUserAvatar(user)}
                    alt={user.username}
                    className="w-full h-full object-cover"
                  />
                </div>

                <p className={`font-medium truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                  {user.displayName || user.username}
                </p>
                <p className={`text-sm truncate ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  @{user.username}
                </p>

                <div className={`flex justify-center gap-3 mt-2 text-xs ${
                  isDark ? 'text-white/40' : 'text-gray-400'
                }`}>
                  <span>{formatCount(user.followerCount)} followers</span>
                  <span>·</span>
                  <span>{formatCount(user.likeCount)} likes</span>
                </div>
              </Link>

              <div className="mt-3 flex justify-center">
                <FollowButton
                  targetUserId={user.tokenId}
                  initialIsFollowing={user.isFollowing}
                  initialIsPending={user.followPending}
                  size="small"
                  onFollowConfirmed={() => handleFollowConfirmed(user.tokenId)}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default React.memo(SuggestedUsers)
