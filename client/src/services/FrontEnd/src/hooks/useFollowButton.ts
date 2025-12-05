import { useState, useEffect, useRef } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { apiFetch } from '~/api/client'
import { hasMinimumStake } from '~/constants/stakingRequirements'

export interface UseFollowButtonParams {
  targetUserId: number
  initialIsFollowing: boolean
  initialIsPending?: boolean
  onFollowStateChange?: (isFollowing: boolean) => void
  onInsufficientStake?: () => void
}

export interface UseFollowButtonReturn {
  isFollowing: boolean
  isPending: boolean
  wrongWallet: boolean
  handleFollowClick: () => Promise<void>
  buttonText: string
  hoverText: string
  hasInsufficientStake: boolean
}

/**
 * Reusable hook for follow/unfollow button logic
 * Handles pending states, optimistic updates, and hover text
 */
export function useFollowButton({
  targetUserId,
  initialIsFollowing,
  initialIsPending = false,
  onFollowStateChange,
  onInsufficientStake
}: UseFollowButtonParams): UseFollowButtonReturn {
  const signAndSubmit = useSignAndSubmitAction()
  const activeToken = useActiveToken()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const { address } = useAccount()
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing)
  const [isPending, setPending] = useState(initialIsPending)
  const [isPolling, setIsPolling] = useState(false)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollStartTimeRef = useRef<number | null>(null)

  // Check if connected to wrong wallet
  const wrongWallet = activeToken && address
    ? activeToken.address.toLowerCase() !== address.toLowerCase()
    : false

  // Check if user has sufficient stake for following
  const hasInsufficientStake = !hasMinimumStake(activeToken?.stakedAmount, 'MIN_STAKE_FOLLOW')

  // Sync with prop changes
  useEffect(() => {
    setIsFollowing(initialIsFollowing)
  }, [initialIsFollowing])

  useEffect(() => {
    setPending(initialIsPending)
  }, [initialIsPending])

  // Poll for status updates when polling is triggered
  useEffect(() => {
    const effectiveTokenId = activeTokenId || activeToken?.tokenId

    // Only poll if we have both IDs and polling was explicitly triggered
    if (!isPolling || !effectiveTokenId || !targetUserId) {
      return
    }

    // Set start time if not already set
    if (!pollStartTimeRef.current) {
      pollStartTimeRef.current = Date.now()
    }

    console.log('[useFollowButton] Starting poll for follow status', {
      followerId: effectiveTokenId,
      followingId: targetUserId
    })

    const POLL_TIMEOUT = 2 * 60 * 1000 // 2 minutes

    const checkStatus = async () => {
      try {
        // Check if we've been polling for too long
        if (pollStartTimeRef.current && Date.now() - pollStartTimeRef.current > POLL_TIMEOUT) {
          console.log('[useFollowButton] Poll timeout after 2 minutes, giving up')
          setPending(false)
          // Revert to original state
          setIsFollowing(initialIsFollowing)
          onFollowStateChange?.(initialIsFollowing)

          // Clear the interval and stop polling
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          pollStartTimeRef.current = null
          setIsPolling(false)
          return
        }

        const status = await apiFetch<{ isFollowing: boolean; isPending: boolean }>(
          `/api/users/follow-status?followerId=${effectiveTokenId}&followingId=${targetUserId}`
        )

        console.log('[useFollowButton] Poll result:', {
          status,
          currentIsFollowing: isFollowing,
          currentIsPending: isPending,
          willUpdate: !status.isPending
        })

        if (!status.isPending) {
          // Status is no longer pending
          console.log('[useFollowButton] Updating state - isPending: false, isFollowing:', status.isFollowing)
          setPending(false)
          setIsFollowing(status.isFollowing)
          onFollowStateChange?.(status.isFollowing)

          // Clear the interval and stop polling
          if (pollIntervalRef.current) {
            clearInterval(pollIntervalRef.current)
            pollIntervalRef.current = null
          }
          pollStartTimeRef.current = null
          setIsPolling(false)
        }
      } catch (error) {
        console.error('[useFollowButton] Failed to check follow status:', error)
      }
    }

    // Start polling immediately now that transaction is submitted
    checkStatus()
    pollIntervalRef.current = setInterval(checkStatus, 2000)

    // Cleanup on unmount or when dependencies change
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [isPolling, activeTokenId, activeToken?.tokenId, targetUserId, onFollowStateChange, initialIsFollowing])

  const handleFollowClick = async () => {
    // Don't do anything if wrong wallet or pending
    if (wrongWallet || isPending) {
      return
    }

    // Check staking requirement before proceeding (only for new follows, not unfollows)
    if (!isFollowing && hasInsufficientStake) {
      console.log('[useFollowButton] Insufficient stake to follow')
      onInsufficientStake?.()
      return
    }

    const effectiveTokenId = activeTokenId || activeToken?.tokenId

    // If no token, still call signAndSubmit - it will handle wallet connection
    if (!effectiveTokenId || !activeToken) {
      console.log('[useFollowButton] No active token, letting signAndSubmit handle wallet connection')
      await signAndSubmit({
        actionType: isFollowing ? 'unfollow' : 'follow',
        senderId: effectiveTokenId || 0,
        receiverId: targetUserId
      })
      return
    }

    console.log('[useFollowButton] Toggling follow state', {
      actionType: isFollowing ? 'unfollow' : 'follow',
      senderId: effectiveTokenId,
      receiverId: targetUserId
    })

    // Optimistic update
    const newFollowingState = !isFollowing
    setIsFollowing(newFollowingState)
    setPending(true)
    onFollowStateChange?.(newFollowingState)

    try {
      const result = await signAndSubmit({
        actionType: isFollowing ? 'unfollow' : 'follow',
        senderId: effectiveTokenId,
        receiverId: targetUserId
      })
      console.log('[useFollowButton] Follow action submitted successfully, result:', result)

      // Now that transaction is submitted, start polling for status updates
      setIsPolling(true)

    } catch (error: any) {
      console.error('[useFollowButton] Follow action failed:', error)
      console.error('[useFollowButton] Error details:', {
        message: error?.message,
        name: error?.name,
        stack: error?.stack,
        code: error?.code
      })

      // Only revert optimistic update if user rejected/cancelled the signature
      // For other errors (like network issues), keep the pending state
      const isUserRejection = error?.code === 'ACTION_REJECTED' ||
                             error?.name === 'UserRejectedRequestError' ||
                             error?.message?.toLowerCase().includes('user rejected') ||
                             error?.message?.toLowerCase().includes('user denied')

      if (isUserRejection) {
        console.log('[useFollowButton] User rejected signature, reverting optimistic update')
        setIsFollowing(isFollowing)
        setPending(false)
        onFollowStateChange?.(isFollowing)
      } else {
        console.log('[useFollowButton] Non-user-rejection error, keeping pending state and starting polling')
        // For non-user-rejection errors, also start polling in case the record was created
        setIsPolling(true)
      }
    }
  }

  const buttonText = isPending ? 'Processing...' : isFollowing ? 'Following' : 'Follow'
  const hoverText = isFollowing ? 'Unfollow' : 'Follow'

  return {
    isFollowing,
    isPending,
    wrongWallet,
    handleFollowClick,
    buttonText,
    hoverText,
    hasInsufficientStake
  }
}
