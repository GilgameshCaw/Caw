import React from 'react'
import { Link } from 'react-router-dom'
import { HiOutlineX } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { FollowButton } from './FollowButton'
import Avatar from '~/components/Avatar'
import { getUserAvatar } from '~/utils/defaultAvatar'
import { useT } from '~/i18n/I18nProvider'
import { useTokenDataStore } from '~/store/tokenDataStore'

export interface UserCardUser {
  tokenId: number
  username: string
  displayName?: string | null
  image?: string | null
  avatarUrl?: string | null
  defaultAvatarId?: number | null
  followerCount: number
  likeCount: number
  isFollowing?: boolean
  followPending?: boolean
}

interface UserCardProps {
  user: UserCardUser
  /** Optional dismiss handler — when set, renders the X in the corner. */
  onDismiss?: (tokenId: number) => void
  /** When true, the card animates to width:0 / opacity:0. Used by SuggestedUsers carousel. */
  fadingOut?: boolean
  /** Called when a follow action is fully confirmed on-chain. */
  onFollowConfirmed?: (tokenId: number) => void
  /** Layout context. `carousel` matches SuggestedUsers (33% width, shrink-0); `grid` is full-width within its grid cell. */
  layout?: 'carousel' | 'grid'
  /** When `layout === 'carousel'`, these add edge margins for the first/last item. */
  isFirst?: boolean
  isLast?: boolean
}

const formatCount = (count: number) => {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`
  return count.toString()
}

const UserCard: React.FC<UserCardProps> = ({
  user,
  onDismiss,
  fadingOut = false,
  onFollowConfirmed,
  layout = 'grid',
  isFirst = false,
  isLast = false,
}) => {
  const { isDark } = useTheme()
  const t = useT()
  // Suppress the Follow button when the card represents one of the
  // viewer's own tokens — there's nothing useful to do, and the follow
  // action would just bounce off the contract's self-action guard.
  const isSelf = useTokenDataStore(s => {
    for (const tokens of Object.values(s.tokensByAddress)) {
      for (const t of tokens) if (t.tokenId === user.tokenId) return true
    }
    return false
  })

  const carouselStyle: React.CSSProperties = layout === 'carousel'
    ? {
        width: fadingOut ? '0%' : '33%',
        minWidth: fadingOut ? '0' : '165px',
        opacity: fadingOut ? 0 : 1,
        padding: fadingOut ? '0' : undefined,
        overflow: fadingOut ? 'hidden' : 'visible',
        marginLeft: isFirst ? '10px' : undefined,
        marginRight: isLast ? '20px' : undefined,
      }
    : { opacity: fadingOut ? 0 : 1 }

  const containerClass = layout === 'carousel' ? 'shrink-0' : ''

  return (
    <div
      className={`relative rounded-xl p-4 transition-all duration-700 ease-in-out ${containerClass} ${
        isDark
          ? 'bg-white/5 hover:bg-white/10'
          : `bg-gray-50 hover:bg-gray-100 border ${layout === 'carousel' ? 'border-gray-200' : 'border-gray-200'} ${layout === 'carousel' ? '' : 'shadow-lg'}`
      }`}
      style={carouselStyle}
    >
      {onDismiss && (
        <button
          onClick={() => onDismiss(user.tokenId)}
          className={`absolute top-2 right-2 p-1 rounded-full transition-opacity cursor-pointer ${
            isDark ? 'hover:bg-white/10 text-white/40 hover:text-white/70' : 'hover:bg-gray-200 text-gray-400 hover:text-gray-600'
          }`}
          style={{ opacity: 0.4 }}
        >
          <HiOutlineX className="w-4 h-4" />
        </button>
      )}

      <Link to={`/users/${user.username}`} className="block text-center">
        <div className="w-16 h-16 rounded-full mx-auto mb-1 overflow-hidden">
          <Avatar src={getUserAvatar(user)} alt={user.username} size="small" />
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
          <span>{t('user_card.followers_count', { count: user.followerCount, value: formatCount(user.followerCount) })}</span>
          <span>·</span>
          <span>{t('user_card.likes_count', { count: user.likeCount, value: formatCount(user.likeCount) })}</span>
        </div>
      </Link>

      {!isSelf && (
        <div className="mt-3 flex justify-center">
          <FollowButton
            targetUserId={user.tokenId}
            initialIsFollowing={user.isFollowing ?? false}
            initialIsPending={user.followPending}
            size="small"
            onFollowConfirmed={onFollowConfirmed ? () => onFollowConfirmed(user.tokenId) : undefined}
          />
        </div>
      )}
    </div>
  )
}

export default UserCard
