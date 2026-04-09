import { useState, useEffect, useRef } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { useAccount } from 'wagmi'
import { apiFetch } from '~/api/client'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'

export interface UseFollowButtonParams {
  targetUserId: number
  initialIsFollowing: boolean
  initialIsPending?: boolean
  onFollowStateChange?: (isFollowing: boolean) => void
}

export interface UseFollowButtonReturn {
  isFollowing: boolean
  isPending: boolean
  /** True while signing/submitting to server, before handoff */
  isSigning: boolean
  wrongWallet: boolean
  error: string | null
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
  const hasActiveSession = useHasActiveSession()
  const [isFollowing, setIsFollowing] = useState(initialIsFollowing)
  const [isPending, setPending] = useState(initialIsPending)
  const [isSigning, setIsSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPolling, setIsPolling] = useState(initialIsPending) // Start polling immediately if mounting in pending state
  const [hasUserAction, setHasUserAction] = useState(false) // Track if user has taken action
  const [awaitingConnection, setAwaitingConnection] = useState(false) // Track if waiting for wallet connection
  const pendingActionRef = useRef<'follow' | 'unfollow' | null>(null) // Store the pending action type
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollStartTimeRef = useRef<number | null>(null)
  const isSubmittingRef = useRef(false) // Prevent duplicate submissions

  // Check if connected to wrong wallet (skip if session key active)
  const wrongWallet = hasActiveSession ? false : (activeToken && address
    ? activeToken.address.toLowerCase() !== address.toLowerCase()
    : false)

  // Sync with prop changes - only when the prop itself changes, never when hasUserAction changes
  useEffect(() => {
    if (!hasUserAction) {
      setIsFollowing(initialIsFollowing)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIsFollowing])

  useEffect(() => {
    if (!hasUserAction) {
      setPending(initialIsPending)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIsPending])

  // Handle wallet connection while awaiting - submit the action when wallet connects
  useEffect(() => {
    // Skip if not awaiting or already submitting
    if (!awaitingConnection || !isConnected || !activeToken || !pendingActionRef.current || isSubmittingRef.current) {
      return
    }

    // Check if the connected wallet owns this token (skip if session key active)
    if (!hasActiveSession && activeToken.address?.toLowerCase() !== address?.toLowerCase()) {
      return
    }

    // Prevent duplicate submissions
    isSubmittingRef.current = true

    const actionType = pendingActionRef.current
    const effectiveTokenId = activeToken.tokenId

    // Clear awaiting state immediately to prevent re-runs
    setAwaitingConnection(false)
    pendingActionRef.current = null

    setHasUserAction(true)
    const newFollowingState = actionType === 'follow'
    setIsFollowing(newFollowingState)
    setPending(true)
    setIsSigning(true)
    onFollowStateChange?.(newFollowingState)

    // Actually submit the follow action now that we have a token
    signAndSubmit({
      actionType,
      senderId: effectiveTokenId,
      receiverId: targetUserId
    }).then(() => {
      isSubmittingRef.current = false
      setIsSigning(false)
      // Start polling for status updates
      setIsPolling(true)
    }).catch((error: any) => {
      isSubmittingRef.current = false

      // Check if user rejected the signature
      const isUserRejection = error?.code === 'ACTION_REJECTED' ||
                             error?.name === 'UserRejectedRequestError' ||
                             error?.message?.toLowerCase().includes('user rejected') ||
                             error?.message?.toLowerCase().includes('user denied')

      // Check if it's a server validation error that should be shown to the user
      const errorMsg = error?.message || error?.shortMessage || ''
      const isServerError = errorMsg.toLowerCase().includes('cannot follow') ||
                           errorMsg.toLowerCase().includes('already following') ||
                           errorMsg.toLowerCase().includes('insufficient') ||
                           errorMsg.toLowerCase().includes('invalid')

      if (isUserRejection) {
        setIsFollowing(!newFollowingState)
        setPending(false)
        setIsSigning(false)
        setHasUserAction(false)
        onFollowStateChange?.(!newFollowingState)
      } else if (isServerError) {
        // Server validation error - show to user and revert state
        setError(errorMsg)
        setIsFollowing(!newFollowingState)
        setPending(false)
        setIsSigning(false)
        setHasUserAction(false)
        onFollowStateChange?.(!newFollowingState)
      } else {
        // For other errors, start polling in case the record was created
        setIsSigning(false)
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

    const POLL_TIMEOUT = 5 * 60 * 1000 // 5 minutes

    const checkStatus = async () => {
      try {
        // Check if we've been polling for too long
        if (pollStartTimeRef.current && Date.now() - pollStartTimeRef.current > POLL_TIMEOUT) {
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

        if (status.isPending) {
          // Still processing — keep polling
          return
        }

        if (status.isFollowing) {
          // Confirmed as following — success
          setPending(false)
          setIsFollowing(true)
          pendingActionRef.current = null
          onFollowStateChange?.(true)
          setHasUserAction(false)
        } else if (!isFollowing) {
          // We were trying to unfollow, and server says not following — success
          setPending(false)
          setIsFollowing(false)
          pendingActionRef.current = null
          onFollowStateChange?.(false)
          setHasUserAction(false)
        } else if (pollStartTimeRef.current && Date.now() - pollStartTimeRef.current < 90_000) {
          // Waiting for a follow — record may not exist yet (on-chain processing can take 20-60s)
          return
        } else {
          // Enough time has passed — accept the server state
          setPending(false)
          setIsFollowing(status.isFollowing)
          pendingActionRef.current = null
          onFollowStateChange?.(status.isFollowing)
          setHasUserAction(false)
        }

        // Clear the interval and stop polling
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        pollStartTimeRef.current = null
        setIsPolling(false)
      } catch (error) {
        // Ignore polling errors
      }
    }

    // Delay first poll slightly — give the API time to create the record
    const initialDelay = setTimeout(() => {
      checkStatus()
      pollIntervalRef.current = setInterval(checkStatus, 2000)
    }, 1500)

    // Cleanup on unmount or when dependencies change
    return () => {
      clearTimeout(initialDelay)
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [isPolling, activeTokenId, activeToken?.tokenId, targetUserId, onFollowStateChange, initialIsFollowing])

  const handleFollowClick = async () => {
    console.log('[FollowButton] handleFollowClick', { wrongWallet, isPending, isSigning, targetUserId, activeTokenId, activeTokenOwner: activeToken?.owner, connectedAddress: address, hasActiveSession })
    // Don't do anything if wrong wallet or pending
    if (wrongWallet || isPending) {
      console.log('[FollowButton] Early return — wrongWallet:', wrongWallet, 'isPending:', isPending)
      return
    }

    // Clear any previous error
    setError(null)

    const effectiveTokenId = activeTokenId || activeToken?.tokenId

    // If no token OR wallet not connected (and no session key), trigger wallet connection
    if (!effectiveTokenId || !activeToken || (!isConnected && !hasActiveSession)) {
      const actionType = isFollowing ? 'unfollow' : 'follow'
      // Reset submitting ref for new action
      isSubmittingRef.current = false
      // Track that we're waiting for wallet connection
      pendingActionRef.current = actionType
      setAwaitingConnection(true)

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

    // Mark that user has taken action (prevents prop sync from overriding)
    setHasUserAction(true)

    // Optimistic update
    const newFollowingState = !isFollowing
    setIsFollowing(newFollowingState)
    setPending(true)
    setIsSigning(true)
    onFollowStateChange?.(newFollowingState)

    try {
      console.log('[FollowButton] calling signAndSubmit', { actionType: isFollowing ? 'unfollow' : 'follow', senderId: effectiveTokenId, receiverId: targetUserId })
      const result = await signAndSubmit({
        actionType: isFollowing ? 'unfollow' : 'follow',
        senderId: effectiveTokenId,
        receiverId: targetUserId
      })
      console.log('[FollowButton] signAndSubmit returned', result)

      // signAndSubmit returns null if insufficient stake (modal shown automatically)
      if (!result) {
        // Revert optimistic update
        setIsFollowing(isFollowing)
        setPending(false)
        setIsSigning(false)
        setHasUserAction(false)
        onFollowStateChange?.(isFollowing)
        return
      }

      // Server has the action — stop signing state, start polling
      setIsSigning(false)
      setIsPolling(true)

    } catch (error: any) {
      // Only revert optimistic update if user rejected/cancelled the signature
      // For other errors (like network issues), keep the pending state
      const isUserRejection = error?.code === 'ACTION_REJECTED' ||
                             error?.name === 'UserRejectedRequestError' ||
                             error?.message?.toLowerCase().includes('user rejected') ||
                             error?.message?.toLowerCase().includes('user denied')

      // Check if it's a server validation error that should be shown to the user
      const errorMsg = error?.message || error?.shortMessage || ''
      const isServerError = errorMsg.toLowerCase().includes('cannot follow') ||
                           errorMsg.toLowerCase().includes('already following') ||
                           errorMsg.toLowerCase().includes('insufficient') ||
                           errorMsg.toLowerCase().includes('invalid')

      if (isUserRejection) {
        setIsFollowing(isFollowing)
        setPending(false)
        setIsSigning(false)
        setHasUserAction(false) // Allow prop sync again
        setAwaitingConnection(false)
        pendingActionRef.current = null
        onFollowStateChange?.(isFollowing)
      } else if (isServerError) {
        // Server validation error - show to user and revert state
        setError(errorMsg)
        setIsFollowing(isFollowing)
        setPending(false)
        setIsSigning(false)
        setHasUserAction(false)
        setAwaitingConnection(false)
        pendingActionRef.current = null
        onFollowStateChange?.(isFollowing)
      } else {
        // For non-user-rejection errors, also start polling in case the record was created
        setIsSigning(false)
        setIsPolling(true)
      }
    }
  }

  const buttonText = isSigning ? 'Processing...' : isFollowing ? 'Following' : 'Follow'
  const hoverText = isFollowing ? 'Unfollow' : 'Follow'

  return {
    isFollowing,
    isPending,
    isSigning,
    wrongWallet,
    error,
    handleFollowClick,
    buttonText,
    hoverText
  }
}
