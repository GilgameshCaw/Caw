import React, { useState } from 'react'
import { useFollowButton } from '~/hooks/useFollowButton'

interface FollowButtonProps {
  targetUserId: number
  initialIsFollowing: boolean
  initialIsPending?: boolean
  onFollowStateChange?: (isFollowing: boolean) => void
  className?: string
  size?: 'small' | 'medium' | 'large'
}

export const FollowButton: React.FC<FollowButtonProps> = ({
  targetUserId,
  initialIsFollowing,
  initialIsPending = false,
  onFollowStateChange,
  className = '',
  size = 'medium'
}) => {
  const [isHovered, setIsHovered] = useState(false)

  const {
    isFollowing,
    isPending,
    wrongWallet,
    handleFollowClick,
    buttonText,
    hoverText
  } = useFollowButton({
    targetUserId,
    initialIsFollowing,
    initialIsPending,
    onFollowStateChange
  })

  const sizeClasses = {
    small: 'px-3 py-1 text-sm',
    medium: 'px-4 py-1.5',
    large: 'px-8 py-2'
  }

  const displayText = isPending ? buttonText : (isHovered && isFollowing ? hoverText : buttonText)

  // Determine button styles based on state
  const getButtonStyles = () => {
    if (isFollowing) {
      // When showing "Following" or "Unfollow" on hover
      if (isHovered) {
        return 'border-2 border-white bg-black text-white'
      }
      return 'border-2 border-white bg-white text-black'
    } else {
      // When showing "Follow"
      if (isHovered) {
        return 'border-2 border-white bg-white text-black'
      }
      return 'border-2 border-white text-white bg-transparent'
    }
  }

  return (
    <span className="relative group inline-block">
      <button
        onClick={handleFollowClick}
        disabled={isPending || wrongWallet}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
        className={`rounded-full font-medium transition-all duration-200 ${
          isPending || wrongWallet ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'
        } ${getButtonStyles()} ${sizeClasses[size]} ${className}`}
      >
        {isPending && (
          <svg className="inline w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        )}
        {displayText}
      </button>
      {wrongWallet && (
        <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs rounded-lg whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity duration-200 z-50 bg-white text-black">
          Please switch to the correct wallet
          <span className="absolute top-full left-1/2 -translate-x-1/2 border-4 border-transparent border-t-white"></span>
        </span>
      )}
    </span>
  )
}
