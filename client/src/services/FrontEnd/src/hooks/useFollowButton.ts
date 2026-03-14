import { useState, useEffect, useRef } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { apiFetch } from '~/api/client'

export interface UseFollowButtonParams {
  targetUserId: number
  initialIsFollowing: boolean
  initialIsPending?: boolean
  onFollowStateChange?: (isFollowing: boolean) => void
}

export interface UseFollowButtonReturn {
  isFollowing: boolean
  isPending: boolean
  wrongWallet: boolean
  handleFollowClick: () => Promise<void>
  buttonText: string
  hoverText: string
}

/**
 * Reusable hook for follow/unfollow button logic
 * Handles pending states, optimistic updates, and hover text
 */
export function useFollowButton({
  targetUserId,
  initialIsFollowing,
  initialIsPending = false,
  onFollowStateChange
}: UseFollowButtonParams): UseFollowButtonReturn {
  const signAndSubmit = useSignAndSubmitAction()
  const activeToken = useActiveToken()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const { address, isConnected } = useAccount()
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing)
  const [isPending, setPending] = useState(initialIsPending)
  const [isPolling, setIsPolling] = useState(false)
  const [hasUserAction, setHasUserAction] = useState(false) // Track if user has taken action
  const [awaitingConnection, setAwaitingConnection] = useState(false) // Track if waiting for wallet connection
  const pendingActionRef = useRef<'follow' | 'unfollow' | null>(null) // Store the pending action type
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollStartTimeRef = useRef<number | null>(null)
  const isSubmittingRef = useRef(false) // Prevent duplicate submissions

  // Check if connected to wrong wallet
  const wrongWallet = activeToken && address
    ? activeToken.address.toLowerCase() !== address.toLowerCase()
    : false

  // Sync with prop changes - but don't override user actions
  useEffect(() => {
    // Only sync from props if user hasn't taken action
    if (!hasUserAction) {
      setIsFollowing(initialIsFollowing)
    }
  }, [initialIsFollowing, hasUserAction])

  useEffect(() => {
    // Only sync from props if user hasn't taken action
    if (!hasUserAction) {
      setPending(initialIsPending)
    }
  }, [initialIsPending, hasUserAction])

  // Handle wallet connection while awaiting - submit the action when wallet connects
  useEffect(() => {
    // Skip if not awaiting or already submitting
    if (!awaitingConnection || !isConnected || !activeToken || !pendingActionRef.current || isSubmittingRef.current) {
      return
    }

    // Check if the connected wallet owns this token
    if (activeToken.address?.toLowerCase() !== address?.toLowerCase()) {
      console.log('[useFollowButton] Wallet connected but wrong address')
      return
    }

    // Prevent duplicate submissions
    isSubmittingRef.current = true

    const actionType = pendingActionRef.current
    const effectiveTokenId = activeToken.tokenId

    console.log('[useFollowButton] Wallet connected, submitting action:', actionType)

    // Clear awaiting state immediately to prevent re-runs
    setAwaitingConnection(false)
    pendingActionRef.current = null

    setHasUserAction(true)
    const newFollowingState = actionType === 'follow'
    setIsFollowing(newFollowingState)
    setPending(true)
    onFollowStateChange?.(newFollowingState)

    // Actually submit the follow action now that we have a token
    signAndSubmit({
      actionType,
      senderId: effectiveTokenId,
      receiverId: targetUserId
    }).then((result) => {
      console.log('[useFollowButton] Follow action submitted after wallet connect, result:', result)
      isSubmittingRef.current = false
      // Start polling for status updates
      setIsPolling(true)
    }).catch((error: any) => {
      console.error('[useFollowButton] Follow action failed after wallet connect:', error)
      isSubmittingRef.current = false

      // Check if user rejected the signature
      const isUserRejection = error?.code === 'ACTION_REJECTED' ||
                             error?.name === 'UserRejectedRequestError' ||
                             error?.message?.toLowerCase().includes('user rejected') ||
                             error?.message?.toLowerCase().includes('user denied')

      if (isUserRejection) {
        console.log('[useFollowButton] User rejected signature, reverting state')
        setIsFollowing(!newFollowingState)
        setPending(false)
        setHasUserAction(false)
        onFollowStateChange?.(!newFollowingState)
      } else {
        // For other errors, start polling in case the record was created
        setIsPolling(true)
      }
    })
  }, [awaitingConnection, isConnected, activeToken, address, onFollowStateChange, signAndSubmit, targetUserId])

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
          setHasUserAction(false) // Allow prop sync again
          pendingActionRef.current = null
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
          setHasUserAction(false) // Allow prop sync again
          pendingActionRef.current = null
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

    const effectiveTokenId = activeTokenId || activeToken?.tokenId

    // If no token OR wallet not connected, trigger wallet connection and track pending action
    if (!effectiveTokenId || !activeToken || !isConnected) {
      const actionType = isFollowing ? 'unfollow' : 'follow'
      console.log('[useFollowButton] No active token or wallet not connected, triggering wallet connection', {
        effectiveTokenId,
        hasActiveToken: !!activeToken,
        isConnected,
        actionType
      })
      // Reset submitting ref for new action
      isSubmittingRef.current = false
      // Track that we're waiting for wallet connection
      pendingActionRef.current = actionType
      setAwaitingConnection(true)
      console.log('[useFollowButton] Set awaitingConnection=true, pendingAction=', actionType)

      // Call signAndSubmit to trigger wallet connection modal (don't await - actual action happens in useEffect)
      signAndSubmit({
        actionType,
        senderId: 0,
        receiverId: targetUserId
      }).catch(() => {
        // Ignore errors here - we just want to trigger the wallet connection
        // The actual action will be submitted in the useEffect when wallet connects
      })
      return
    }

    console.log('[useFollowButton] Toggling follow state', {
      actionType: isFollowing ? 'unfollow' : 'follow',
      senderId: effectiveTokenId,
      receiverId: targetUserId
    })

    // Mark that user has taken action (prevents prop sync from overriding)
    setHasUserAction(true)

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

      // signAndSubmit returns null if insufficient stake (modal shown automatically)
      if (!result) {
        // Revert optimistic update
        setIsFollowing(isFollowing)
        setPending(false)
        setHasUserAction(false)
        onFollowStateChange?.(isFollowing)
        return
      }

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
        setHasUserAction(false) // Allow prop sync again
        setAwaitingConnection(false)
        pendingActionRef.current = null
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
    hoverText
  }
}
