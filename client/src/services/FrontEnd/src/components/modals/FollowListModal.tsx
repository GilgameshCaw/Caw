import { UserAvatar } from "~/components/Avatar"
// src/components/modals/FollowListModal.tsx
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useModalStore } from '~/store/modalStore'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { themeText, themeTextMuted, themeTextSecondary, themeDivide } from '~/utils/theme'
import { useActiveToken } from '~/store/tokenDataStore'
import { FollowButton } from '~/components/FollowButton'
import ModalWrapper from './ModalWrapper'
import ModalHeader from './ModalHeader'
import { useT } from '~/i18n/I18nProvider'

type UserItem = {
  id: number
  tokenId: number
  username: string
  image?: string
  displayName?: string
  bio?: string
  avatarUrl?: string
  isFollowing?: boolean
  followPending?: boolean
}

type Props = {
  type: 'following' | 'followers'
}

const FollowListModal: React.FC<Props> = ({ type }) => {
  const t = useT()
  const { modal, modalData, closeModal } = useModalStore()
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const activeToken = useActiveToken()
  const [users, setUsers] = useState<UserItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [nextCursor, setNextCursor] = useState<number | undefined>(undefined)
  const [hasMore, setHasMore] = useState(true)
  const [followingStates, setFollowingStates] = useState<Record<number, boolean>>({})

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

        // Initialize following states from API data
        const states: Record<number, boolean> = {}
        for (const user of response.items) {
          states[user.tokenId] = user.isFollowing || false
        }
        setFollowingStates(states)
      } catch (err) {
        console.error('Failed to fetch users:', err)
        setError(t('follow_list.error'))
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

      // Update following states for new users from API data
      const states = { ...followingStates }
      for (const user of response.items) {
        states[user.tokenId] = user.isFollowing || false
      }
      setFollowingStates(states)
    } catch (err) {
      console.error('Failed to load more users:', err)
    }
  }

  // Handle clicking on a user to navigate to their profile
  const handleUserClick = (username: string) => {
    closeModal()
    navigate(`/users/${username}`)
  }

  return (
    <ModalWrapper
      isOpen={isOpen}
      onClose={closeModal}
      maxWidth="max-w-lg"
      className="max-h-[80vh] max-h-[80dvh] overflow-hidden"
    >
      <ModalHeader
        title={type === 'following' ? t('profile.stats.following') : t('profile.stats.followers')}
        onClose={closeModal}
      />

      {/* Content */}
      <div className="overflow-y-auto overscroll-contain max-h-[calc(80vh-4rem)] max-h-[calc(80dvh-4rem)]">
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
            {type === 'following' ? t('follow_list.empty.following') : t('follow_list.empty.followers')}
          </div>
        ) : (
          <div className={`divide-y ${themeDivide(isDark)}`}>
            {users.map((user) => (
              <div key={user.tokenId} className="p-4 flex items-center justify-between">
                <div
                  className="flex items-center space-x-3 cursor-pointer flex-1"
                  onClick={() => handleUserClick(user.username)}
                >
                  <div className={`w-10 h-10 rounded-full overflow-hidden ${isDark ? 'bg-gray-700' : 'bg-gray-200'}`}>
                    <UserAvatar
                      user={user}
                      alt={user.username}
                      className="w-full h-full rounded-full"
                      size="small"
                    />
                  </div>
                  <div>
                    <div className={`font-medium ${themeText(isDark)}`}>
                      {user.displayName || user.username}
                    </div>
                    <div className={`text-sm ${themeTextMuted(isDark)}`}>
                      @{user.username}
                    </div>
                    {user.bio && (
                      <div className={`text-sm mt-1 line-clamp-2 ${themeTextSecondary(isDark)}`}>
                        {user.bio}
                      </div>
                    )}
                  </div>
                </div>

                {/* Follow button */}
                {activeToken && user.tokenId !== activeToken.tokenId && (
                  <FollowButton
                    targetUserId={user.tokenId}
                    initialIsFollowing={followingStates[user.tokenId] || false}
                    initialIsPending={user.followPending || false}
                    onFollowStateChange={(newState) => {
                      setFollowingStates(prev => ({
                        ...prev,
                        [user.tokenId]: newState
                      }))
                    }}
                    size="small"
                  />
                )}
              </div>
            ))}

            {/* Load more */}
            {hasMore && (
              <div className="p-4 text-center">
                <button
                  onClick={loadMore}
                  className={`text-sm hover:underline ${themeTextMuted(isDark)}`}
                >
                  Load more
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </ModalWrapper>
  )
}

export default FollowListModal