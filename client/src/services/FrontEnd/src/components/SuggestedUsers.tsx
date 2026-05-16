import React, { useEffect, useRef, useState, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useTokenDataStore } from '~/store/tokenDataStore'
import UserCard from '~/components/UserCard'
import { LoadingSpinner } from '~/components/Skeleton'
import { useT } from '~/i18n/I18nProvider'


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
  const t = useT()
  const { isDark } = useTheme()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  // Owned-token set: covers every profile the connected wallet(s) hold,
  // not just the currently-active one. A user with multiple profiles
  // shouldn't see ANY of their own profiles in the suggestion list —
  // filtering by activeTokenId alone leaks sibling profiles in.
  const ownedTokenIds = useTokenDataStore(s => {
    const out = new Set<number>()
    for (const tokens of Object.values(s.tokensByAddress)) {
      for (const t of tokens) out.add(t.tokenId)
    }
    return out
  })
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
        const filtered = response.users.filter(u => !ownedTokenIds.has(u.tokenId))
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

  if (loading) {
    return <LoadingSpinner className="py-8" />
  }

  const visibleUsers = users.filter(u =>
    !ownedTokenIds.has(u.tokenId) && !removedIds.has(u.tokenId) && !dismissedIds.has(u.tokenId) && !u.isFollowing && !u.followPending
  )

  if (visibleUsers.length <= 1) {
    return null
  }

  return (
    <div className={`pt-4 mb-3 rounded-xl ${
      // Light theme: keep it flat (no gray panel behind cards).
      isDark ? 'bg-black' : 'bg-transparent'
    }`}>
      <h2 className={`text-lg font-semibold mb-4 ml-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
        {t('suggested.title')}
      </h2>
      <div className={`flex gap-3 overflow-x-auto overflow-y-visible pb-[20px] transition-all duration-500 ${visibleUsers.length <= 3 ? 'justify-center' : ''}`}>
        {visibleUsers.map((user, idx) => (
          <UserCard
            key={user.tokenId}
            user={user}
            layout="carousel"
            isFirst={idx === 0}
            isLast={idx === visibleUsers.length - 1}
            fadingOut={fadingOutIds.has(user.tokenId)}
            onDismiss={handleDismiss}
            onFollowConfirmed={handleFollowConfirmed}
          />
        ))}
      </div>
    </div>
  )
}

export default React.memo(SuggestedUsers)
