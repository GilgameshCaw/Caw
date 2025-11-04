// src/components/modals/FollowListModal.tsx
import React, { useState, useEffect } from 'react'
import { HiX } from 'react-icons/hi'
import { useModalStore } from '~/store/modalStore'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useSignAndSubmitAction } from '~/api/actions'
import { useActiveToken } from '~/store/tokenDataStore'

type UserItem = {
  id: number
  tokenId: number
  username: string
  image?: string
  displayName?: string
  bio?: string
  avatarUrl?: string
}

type Props = {
  type: 'following' | 'followers'
}

const FollowListModal: React.FC<Props> = ({ type }) => {
  const { modal, modalData, closeModal } = useModalStore()
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const [users, setUsers] = useState<UserItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined)
  const [hasMore, setHasMore] = useState(true)
  const [followingStates, setFollowingStates] = useState<Record<number, boolean>>({})
  const [pendingFollows, setPendingFollows] = useState<Set<number>>(new Set())
  const { submitAction } = useSignAndSubmitAction()

  const isOpen = modal === (type === 'following' ? 'followingList' : 'followersList')
  const username = modalData?.username

  // Fetch users
  useEffect(() => {
    if (!isOpen || !username) return

    const fetchUsers = async () => {
      setLoading(true)
      setError(null)

      try {
        const endpoint = type === 'following'
          ? `/api/users/${username}/following`
          : `/api/users/${username}/followers`

        const response = await apiFetch<{
          items: UserItem[]
          nextCursor?: number
        }>(endpoint)

        setUsers(response.items)
        setNextCursor(response.nextCursor)
        setHasMore(!!response.nextCursor)

        // Initialize following states
        const states: Record<number, boolean> = {}
        for (const user of response.items) {
          // Check if current user is following this user
          if (activeToken?.tokenId) {
            try {
              const profileData = await apiFetch(`/api/users/${user.username}`)
              states[user.tokenId] = profileData.isFollowing || false
            } catch {
              states[user.tokenId] = false
            }
          }
        }
        setFollowingStates(states)
      } catch (err) {
        console.error('Failed to fetch users:', err)
        setError('Failed to load users')
      } finally {
        setLoading(false)
      }
    }

    fetchUsers()
  }, [isOpen, username, type, activeToken?.tokenId])

  // Load more users
  const loadMore = async () => {
    if (!hasMore || !nextCursor) return

    try {
      const endpoint = type === 'following'
        ? `/api/users/${username}/following?cursor=${nextCursor}`
        : `/api/users/${username}/followers?cursor=${nextCursor}`

      const response = await apiFetch<{
        items: UserItem[]
        nextCursor?: number
      }>(endpoint)

      setUsers(prev => [...prev, ...response.items])
      setNextCursor(response.nextCursor)
      setHasMore(!!response.nextCursor)

      // Update following states for new users
      const states = { ...followingStates }
      for (const user of response.items) {
        if (activeToken?.tokenId) {
          try {
            const profileData = await apiFetch(`/api/users/${user.username}`)
            states[user.tokenId] = profileData.isFollowing || false
          } catch {
            states[user.tokenId] = false
          }
        }
      }
      setFollowingStates(states)
    } catch (err) {
      console.error('Failed to load more users:', err)
    }
  }

  // Handle follow/unfollow
  const handleFollow = async (user: UserItem) => {
    if (!activeToken || pendingFollows.has(user.tokenId)) return

    setPendingFollows(prev => new Set(prev).add(user.tokenId))
    const isCurrentlyFollowing = followingStates[user.tokenId]

    try {
      await submitAction({
        actionType: isCurrentlyFollowing ? 'UNFOLLOW' : 'FOLLOW',
        senderId: activeToken.tokenId,
        targetId: user.tokenId
      })

      // Optimistically update state
      setFollowingStates(prev => ({
        ...prev,
        [user.tokenId]: !isCurrentlyFollowing
      }))
    } catch (err) {
      console.error('Failed to follow/unfollow:', err)
    } finally {
      setPendingFollows(prev => {
        const next = new Set(prev)
        next.delete(user.tokenId)
        return next
      })
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50" onClick={closeModal}>
      <div
        className={`w-full max-w-lg mx-4 rounded-2xl max-h-[80vh] overflow-hidden transition-all duration-300 ${
          isDark ? 'bg-black border border-white/20' : 'bg-white border border-gray-200'
        }`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between p-4 border-b border-white/10">
          <h2 className={`text-lg font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            {type === 'following' ? 'Following' : 'Followers'}
          </h2>
          <button
            onClick={closeModal}
            className={`p-2 rounded-full transition-all duration-300 hover:bg-gray-500/10 ${
              isDark ? 'text-white' : 'text-black'
            }`}
          >
            <HiX className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="overflow-y-auto max-h-[calc(80vh-4rem)]">
          {loading && users.length === 0 ? (
            <div className="p-8 text-center">
              <div className="animate-spin text-2xl">⌛</div>
            </div>
          ) : error ? (
            <div className="p-8 text-center text-red-500">
              {error}
            </div>
          ) : users.length === 0 ? (
            <div className="p-8 text-center text-gray-500">
              No {type === 'following' ? 'following' : 'followers'} yet
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {users.map((user) => (
                <div key={user.tokenId} className="p-4 flex items-center justify-between">
                  <div className="flex items-center space-x-3">
                    {/* Avatar */}
                    <div className={`w-10 h-10 rounded-full ${
                      isDark ? 'bg-gray-700' : 'bg-gray-200'
                    }`}>
                      {user.avatarUrl && (
                        <img
                          src={user.avatarUrl}
                          alt={user.username}
                          className="w-full h-full rounded-full object-cover"
                        />
                      )}
                    </div>

                    {/* User info */}
                    <div>
                      <div className={`font-medium ${
                        isDark ? 'text-white' : 'text-black'
                      }`}>
                        {user.displayName || user.username}
                      </div>
                      <div className={`text-sm ${
                        isDark ? 'text-gray-400' : 'text-gray-600'
                      }`}>
                        @{user.username}
                      </div>
                      {user.bio && (
                        <div className={`text-sm mt-1 line-clamp-2 ${
                          isDark ? 'text-gray-300' : 'text-gray-700'
                        }`}>
                          {user.bio}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Follow button */}
                  {activeToken && user.tokenId !== activeToken.tokenId && (
                    <button
                      onClick={() => handleFollow(user)}
                      disabled={pendingFollows.has(user.tokenId)}
                      className={`px-4 py-1.5 rounded-full text-sm font-medium border transition-all duration-200 ${
                        pendingFollows.has(user.tokenId)
                          ? 'opacity-50 cursor-not-allowed'
                          : ''
                      } ${
                        followingStates[user.tokenId]
                          ? isDark
                            ? 'border-white bg-white text-black hover:bg-white/90'
                            : 'border-black bg-black text-white hover:bg-black/90'
                          : isDark
                            ? 'border-white text-white hover:bg-white hover:text-black'
                            : 'border-black text-black hover:bg-black hover:text-white'
                      }`}
                    >
                      {pendingFollows.has(user.tokenId) ? (
                        <span className="animate-pulse">...</span>
                      ) : followingStates[user.tokenId] ? (
                        'Following'
                      ) : (
                        'Follow'
                      )}
                    </button>
                  )}
                </div>
              ))}

              {/* Load more */}
              {hasMore && (
                <div className="p-4 text-center">
                  <button
                    onClick={loadMore}
                    className={`text-sm hover:underline ${
                      isDark ? 'text-gray-400' : 'text-gray-600'
                    }`}
                  >
                    Load more
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default FollowListModal