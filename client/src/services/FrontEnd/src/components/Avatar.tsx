import React, { useState, useEffect } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { avatarThumbUrl } from '~/utils/imageVariants'

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
}

/**
 * Avatar image with broken-image fallback.
 * Shows a user-silhouette icon if the image fails to load.
 */
const Avatar: React.FC<AvatarProps> = ({ src, alt = '', className = 'w-full h-full', size = 'large' }) => {
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
      className={`${className} object-cover`}
      onError={() => {
        // Thumb missing? Try the main URL once before giving up.
        if (currentSrc !== src) setCurrentSrc(src)
        else setBroken(true)
      }}
    />
  )
}

export default Avatar
