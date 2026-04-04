import React, { useState, useEffect, useRef } from 'react'
import { useFollowButton } from '~/hooks/useFollowButton'
import Tooltip from '~/components/Tooltip'

interface FollowButtonProps {
  targetUserId: number
  initialIsFollowing: boolean
  initialIsPending?: boolean
  onFollowStateChange?: (isFollowing: boolean) => void
  /** Fires when a follow action is fully confirmed (pending → confirmed following) */
  onFollowConfirmed?: () => void
  className?: string
  size?: 'small' | 'medium' | 'large'
  disabled?: boolean
}

export const FollowButton: React.FC<FollowButtonProps> = ({
  targetUserId,
  initialIsFollowing,
  initialIsPending = false,
  onFollowStateChange,
  onFollowConfirmed,
  className = '',
  size = 'medium',
  disabled = false
}) => {
  const [isHovered, setIsHovered] = useState(false)

  const {
    isFollowing,
    isPending,
    wrongWallet,
    error,
    handleFollowClick,
    buttonText,
    hoverText
  } = useFollowButton({
    targetUserId,
    initialIsFollowing,
    initialIsPending,
    onFollowStateChange
  })

  // Detect when follow is confirmed: was pending, now not pending and following
  const wasPendingRef = useRef(isPending)
  useEffect(() => {
    if (wasPendingRef.current && !isPending && isFollowing) {
      onFollowConfirmed?.()
    }
    wasPendingRef.current = isPending
  }, [isPending, isFollowing, onFollowConfirmed])

  const sizeClasses = {
    small: 'px-3 py-1 text-sm',
    medium: 'px-4 py-1.5',
    large: 'px-8 py-2'
  }

  // When pending, show the anticipated result state (following → "Following", unfollowing → "Follow")
  const displayText = isPending ? buttonText : (isHovered && isFollowing ? hoverText : buttonText)

  // Determine button styles based on state
  const getButtonStyles = () => {
    if (isFollowing || (isPending && !isFollowing)) {
      // "Following" state (or pending follow that will become "Following")
      if (isHovered && !isPending) {
        return 'border-2 border-white bg-black text-white'
      }
      return 'border-2 border-white bg-white text-black'
    } else {
      // "Follow" state (or pending unfollow that will become "Follow")
      if (isHovered && !isPending) {
        return 'border-2 border-white bg-white text-black'
      }
      return 'border-2 border-white text-white bg-transparent'
    }
  }

  const button = (
    <button
      onClick={handleFollowClick}
      disabled={isPending || wrongWallet || disabled}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`rounded-full font-medium transition-all duration-200 ${
        wrongWallet || disabled ? 'opacity-50 cursor-not-allowed' :
        isPending ? 'opacity-90 cursor-not-allowed' :
        'cursor-pointer'
      } ${getButtonStyles()} ${sizeClasses[size]} ${className}`}
    >
      {displayText}
    </button>
  )

  if (isPending) {
    return (
      <Tooltip text="Processing on-chain" className="inline-block">
        {button}
      </Tooltip>
    )
  }

  if (wrongWallet) {
    return (
      <Tooltip text="Please switch to the correct wallet" className="inline-block">
        {button}
      </Tooltip>
    )
  }

  if (error) {
    return (
      <Tooltip text={error} className="inline-block">
        {button}
      </Tooltip>
    )
  }

  return button
}
