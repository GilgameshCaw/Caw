import React, { useState, useEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { avatarThumbUrl } from '~/utils/imageVariants'
import { getUserAvatar, getDefaultAvatarForUser } from '~/utils/defaultAvatar'

interface AvatarProps {
  src: string
  alt?: string
  className?: string
  /**
   * "small" pulls the 64px thumb variant when one exists. Use anywhere the
   * avatar renders ≤64px (feed items, comments, lists). Falls back to the
   * main URL automatically if the thumb 404s — which it will for any
   * avatar uploaded before the variant system shipped, until backfill runs.
   *
   * "large" uses the main URL directly. Use on the profile page (150px).
   * Default is "large" so the rendering is conservative — switching a
   * callsite to "small" is opt-in.
   */
  size?: 'small' | 'large'
  /**
   * Optional second-tier fallback. When `src` (and its thumb) both 404 we
   * try this URL once before giving up to the silhouette. Use it to point
   * at the user's deterministic default avatar (per-user `defaultAvatarId`
   * picture) so a broken custom upload never surfaces the generic
   * silhouette in feed items / comments / lists.
   *
   * Skipped if equal to `src` (avoids an infinite retry on a default
   * avatar that's itself missing — e.g. early dev with no /images/avatars
   * payload).
   */
  fallbackSrc?: string
}

/**
 * Avatar image with broken-image fallback.
 * Shows a user-silhouette icon if the image fails to load.
 */
const Avatar: React.FC<AvatarProps> = ({ src, alt = '', className = 'w-full h-full', size = 'large', fallbackSrc }) => {
  // Resolve the URL we WANT to render (thumb or main) up-front, then track
  // a "fell back to main" state so an onError on the thumb reroutes to the
  // main URL exactly once before showing the broken-state silhouette.
  const preferred = size === 'small' ? (avatarThumbUrl(src) || src) : src
  const [currentSrc, setCurrentSrc] = useState(preferred)
  const [broken, setBroken] = useState(false)
  const { isDark } = useTheme()

  useEffect(() => {
    setBroken(false)
    setCurrentSrc(preferred)
  }, [preferred])

  if (broken) {
    return (
      <div className={`${className} flex items-center justify-center ${isDark ? 'bg-gray-800' : 'bg-gray-200'}`}>
        <svg className="w-1/2 h-1/2 opacity-40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="8" r="4" />
          <path d="M20 21a8 8 0 1 0-16 0" />
        </svg>
      </div>
    )
  }

  return (
    <img
      src={currentSrc}
      alt={alt}
      decoding="sync"
      loading="eager"
      className={`${className} object-cover`}
      onError={() => {
        // Two-step recovery before the silhouette:
        //   1. If we're rendering the thumb variant, try the main URL.
        //   2. If the main URL ALSO 404s and a fallbackSrc is provided
        //      (and isn't already what we tried), use it.
        // Only after both fail do we render the broken-state silhouette.
        if (currentSrc !== src) {
          setCurrentSrc(src)
          return
        }
        if (fallbackSrc && fallbackSrc !== src) {
          setCurrentSrc(fallbackSrc)
          return
        }
        setBroken(true)
      }}
    />
  )
}

interface UserAvatarProps {
  user?: {
    avatarUrl?: string | null
    image?: string | null
    defaultAvatarId?: number | null
    tokenId?: number
    username?: string
  } | null
  alt?: string
  className?: string
  size?: 'small' | 'large'
}

/**
 * User-aware Avatar wrapper. Resolves src + fallbackSrc from the user
 * record so a broken custom upload silently degrades to the user's
 * deterministic default avatar instead of the generic silhouette.
 *
 * Prefer this over `<Avatar src=...>` for any feed/list/comment/profile
 * surface that renders a known user. Use raw <Avatar> only when the
 * user identity isn't available (e.g. share-card preview from a URL).
 */
export const UserAvatar: React.FC<UserAvatarProps> = ({
  user,
  alt,
  className,
  size,
}) => (
  <Avatar
    src={getUserAvatar(user)}
    fallbackSrc={getDefaultAvatarForUser(user)}
    alt={alt ?? (user?.username ? `${user.username} avatar` : '')}
    className={className}
    size={size}
  />
)

export default Avatar
