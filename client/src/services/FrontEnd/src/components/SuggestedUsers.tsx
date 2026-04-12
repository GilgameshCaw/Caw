import React, { useEffect, useRef, useState, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { FollowButton } from './FollowButton'
import cawLogo from '~/assets/images/caw-logo.png'
import { HiOutlineX } from 'react-icons/hi'


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
  followerCount: number
  likeCount: number
  isFollowing: boolean
  followPending: boolean
}

interface SuggestedUsersProps {
  onFollowChange?: () => void
}

const SuggestedUsers: React.FC<SuggestedUsersProps> = ({ onFollowChange }) => {
  const { isDark } = useTheme()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const [users, setUsers] = useState<SuggestedUser[]>([])
  const [loading, setLoading] = useState(true)
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
  }, [])

  const formatCount = (count: number) => {
    if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
    if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
    return count.toString()
  }

  if (loading) {
    return (
      <div className="py-8">
        <div className="flex gap-3 overflow-x-auto pb-2">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className={`animate-pulse rounded-xl p-4 shrink-0 w-[33%] min-w-[165px] ${
                isDark ? 'bg-white/5' : 'bg-gray-100'
              }`}
            >
              <div className="w-16 h-16 rounded-full bg-gray-600 mx-auto mb-3" />
              <div className="h-4 bg-gray-600 rounded w-3/4 mx-auto mb-2" />
              <div className="h-3 bg-gray-700 rounded w-1/2 mx-auto" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  const visibleUsers = users.filter(u =>
    u.tokenId !== activeTokenId && !removedIds.has(u.tokenId) && !dismissedIds.has(u.tokenId) && !u.isFollowing
  )

  if (visibleUsers.length === 0) {
    return null
  }

  return (
    <div className={`py-6 px-4 rounded-xl border transition-all duration-300 ${
      isDark ? 'bg-black border-yellow-500/30' : 'bg-gray-100 border-gray-200 shadow-xl'
    }`}>
      <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
        Suggested users to follow
      </h2>
      <div className={`flex gap-3 overflow-x-auto overflow-y-visible pb-2 transition-all duration-500 ${visibleUsers.length <= 3 ? 'justify-center' : ''}`}>
        {visibleUsers.map(user => {
          const isFadingOut = fadingOutIds.has(user.tokenId)
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
                  {(user.avatarUrl || user.image) ? (
                    <img
                      src={user.avatarUrl || user.image || ''}
                      alt={user.username}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <img
                      src={cawLogo}
                      alt={user.username}
                      className="w-full h-full object-contain p-2"
                    />
                  )}
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
