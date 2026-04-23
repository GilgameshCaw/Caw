import React, { useState } from 'react'
import { useTheme } from '~/hooks/useTheme'

interface AvatarProps {
  src: string
  alt?: string
  className?: string
}

/**
 * Avatar image with broken-image fallback.
 * Shows a user-silhouette icon if the image fails to load.
 */
const Avatar: React.FC<AvatarProps> = ({ src, alt = '', className = 'w-full h-full' }) => {
  const [broken, setBroken] = useState(false)
  const { isDark } = useTheme()

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
      src={src}
      alt={alt}
      className={`${className} object-cover`}
      onError={() => setBroken(true)}
    />
  )
}

export default Avatar
