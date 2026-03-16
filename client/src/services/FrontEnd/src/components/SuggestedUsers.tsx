import React, { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { FollowButton } from './FollowButton'
import cawLogo from '~/assets/images/caw-logo.png'

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

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await apiFetch<{ users: SuggestedUser[] }>('/api/users/top-followed?limit=10')
        // Filter out the current user
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
              className={`animate-pulse rounded-xl p-4 shrink-0 w-[31%] ${
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

  // Only show if at least 3 suggested users are available
  if (users.length < 3) {
    return null
  }

  return (
    <div className="py-6">
      <h2 className={`text-lg font-semibold mb-4 ${isDark ? 'text-white' : 'text-gray-900'}`}>
        Suggested users to follow
      </h2>
      <div className={`flex gap-3 overflow-x-auto pb-2 ${users.length <= 3 ? 'justify-center' : ''}`}>
        {users.map(user => (
          <div
            key={user.tokenId}
            className={`rounded-xl p-4 transition-colors shrink-0 w-[31%] ${
              isDark
                ? 'bg-white/5 hover:bg-white/10'
                : 'bg-gray-50 hover:bg-gray-100'
            }`}
          >
            <Link to={`/users/${user.username}`} className="block text-center">
              {/* Avatar */}
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

              {/* Username */}
              <p className={`font-medium truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {user.displayName || user.username}
              </p>
              <p className={`text-sm truncate ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                @{user.username}
              </p>

              {/* Stats */}
              <div className={`flex justify-center gap-3 mt-2 text-xs ${
                isDark ? 'text-white/40' : 'text-gray-400'
              }`}>
                <span>{formatCount(user.followerCount)} followers</span>
                <span>·</span>
                <span>{formatCount(user.likeCount)} likes</span>
              </div>
            </Link>

            {/* Follow Button */}
            <div className="mt-3 flex justify-center">
              <FollowButton
                targetUserId={user.tokenId}
                initialIsFollowing={user.isFollowing}
                initialIsPending={user.followPending}
                size="small"
                onFollowStateChange={onFollowChange ? () => onFollowChange() : undefined}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default SuggestedUsers
