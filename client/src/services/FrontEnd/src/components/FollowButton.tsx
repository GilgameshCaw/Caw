import React, { useState, useEffect, useRef } from 'react'
import { useFollowButton } from '~/hooks/useFollowButton'
import { useTheme } from '~/hooks/useTheme'
import Tooltip from '~/components/Tooltip'
import { useT } from '~/i18n/I18nProvider'

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
  const { isDark } = useTheme()
  const t = useT()

  const {
    isFollowing,
    isPending,
    isSigning,
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

  // When signing, show "Processing..."; when pending (server has it), show anticipated result; otherwise normal
  const displayText = isPending ? buttonText : (isHovered && isFollowing ? hoverText : buttonText)


  // Determine button styles based on state
  const getButtonStyles = () => {
    if (isFollowing || (isPending && !isFollowing)) {
      // "Following" state (or pending follow that will become "Following")
      if (isHovered && !isPending) {
        return isDark
          ? 'border-2 border-white bg-black text-white'
          : 'border-2 border-gray-800 bg-white text-gray-900'
      }
      return isDark
        ? 'border-2 border-white bg-white text-black'
        : 'border-2 border-gray-800 bg-gray-800 text-white'
    } else {
      // "Follow" state (or pending unfollow that will become "Follow")
      if (isHovered && !isPending) {
        return isDark
          ? 'border-2 border-white bg-white text-black'
          : 'border-2 border-gray-800 bg-gray-800 text-white'
      }
      return isDark
        ? 'border-2 border-white text-white bg-transparent'
        : 'border-2 border-gray-800 text-gray-800 bg-transparent'
    }
  }

  // Stay clickable while pending so a second click can cancel the in-flight
  // follow/unfollow (matches Like's cancel-the-in-flight UX). The hook
  // gates the actual cancel on having a known txQueueId; clicks during the
  // wallet-sign window are no-ops there.
  const button = (
    <button
      onClick={handleFollowClick}
      disabled={wrongWallet || disabled}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className={`rounded-full font-medium transition-all duration-200 ${
        wrongWallet || disabled ? 'opacity-50 cursor-not-allowed' :
        isPending ? 'opacity-90 cursor-pointer' :
        'cursor-pointer'
      } ${getButtonStyles()} ${sizeClasses[size]} ${className}`}
    >
      {displayText}
    </button>
  )

  if (isPending && !isSigning) {
    return (
      <Tooltip text={t('follow.cancel_tooltip')} className="inline-block">
        {button}
      </Tooltip>
    )
  }

  if (isSigning) {
    return button
  }

  if (wrongWallet) {
    return (
      <Tooltip text={t('post_form.error.wrong_wallet_tooltip')} className="inline-block">
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
