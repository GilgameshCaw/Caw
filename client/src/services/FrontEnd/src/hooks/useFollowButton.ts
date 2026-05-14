import { useState, useEffect, useRef } from 'react'
import { useSignAndSubmitAction } from '~/api/actions'
import { useActiveToken, useTokenDataStore } from '~/store/tokenDataStore'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { useAccount } from 'wagmi'
import { apiFetch } from '~/api/client'
import { useHasActiveSession } from '~/hooks/useHasActiveSession'
import { useT } from '~/i18n/I18nProvider'

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
  const t = useT()
  const signAndSubmit = useSignAndSubmitAction()
  const activeToken = useActiveToken()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const { address, isConnected } = useAccount()
  const hasActiveSession = useHasActiveSession()
  // When mounting into a pending server-state, `initialIsFollowing` reflects
  // the *previous* (last server-confirmed) state — the user is mid-transition
  // to its opposite. Display `isFollowing` as the anticipated end state from
  // the start so it agrees with the click path (which also flips this flag
  // optimistically before the on-chain confirmation lands).
  const [isFollowing, setIsFollowing] = useState(
    initialIsPending ? !initialIsFollowing : initialIsFollowing
  )
  const [isPending, setPending] = useState(initialIsPending)
  const [isSigning, setIsSigning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // TxQueue id of the in-flight follow/unfollow, set right after
  // signAndSubmit resolves. Lets a follow-up click cancel the action
  // before the validator picks it up — same pattern as Like.
  const [pendingTxQueueId, setPendingTxQueueId] = useState<number | null>(null)
  const [isPolling, setIsPolling] = useState(initialIsPending) // Start polling immediately if mounting in pending state
  const [hasUserAction, setHasUserAction] = useState(false) // Track if user has taken action
  const [awaitingConnection, setAwaitingConnection] = useState(false) // Track if waiting for wallet connection
  const pendingActionRef = useRef<'follow' | 'unfollow' | null>(null) // Store the pending action type
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)
  const pollStartTimeRef = useRef<number | null>(null)
  const isSubmittingRef = useRef(false) // Prevent duplicate submissions
  // Keep a ref to the latest onFollowStateChange so the polling effect doesn't
  // have to re-subscribe every time the parent re-renders with a fresh
  // callback. Prior behavior: the effect re-ran on every parent render,
  // tearing down and re-creating the 2s interval constantly. Multiplied
  // across a feed of follow buttons, this produced 200+ req/sec to
  // /api/users/follow-status.
  const onFollowStateChangeRef = useRef(onFollowStateChange)
  useEffect(() => { onFollowStateChangeRef.current = onFollowStateChange }, [onFollowStateChange])

  // Check if connected to wrong wallet (skip if session key active)
  const wrongWallet = hasActiveSession ? false : (activeToken && address
    ? activeToken.address.toLowerCase() !== address.toLowerCase()
    : false)

  // Sync with prop changes - only when the prop itself changes, never when hasUserAction changes.
  // Same invariant as the initial useState: while pending, display the
  // anticipated state, not the previous server-confirmed state.
  useEffect(() => {
    if (!hasUserAction) {
      setIsFollowing(initialIsPending ? !initialIsFollowing : initialIsFollowing)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialIsFollowing, initialIsPending])

  useEffect(() => {
    if (!hasUserAction) {
      setPending(initialIsPending)
      // Kick off polling if the prop says we're pending and we aren't already
      // polling. Covers the case where the parent's data fetch resolves after
      // mount and flips initialIsPending false → true; the useState initializer
      // only ran on first render, so isPolling wouldn't otherwise update.
      if (initialIsPending) setIsPolling(true)
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
    }).then((result: any) => {
      isSubmittingRef.current = false
      setIsSigning(false)
      if (result?.txQueueId) setPendingTxQueueId(result.txQueueId)
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
          setPendingTxQueueId(null)
          setHasUserAction(false) // Allow prop sync again
          pendingActionRef.current = null
          // Revert to original state
          setIsFollowing(initialIsFollowing)
          onFollowStateChangeRef.current?.(initialIsFollowing)

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

        // Local `isFollowing` reflects the anticipated end state. Server has
        // settled when status.isPending=false; treat a server result that
        // matches our anticipation as success.
        if (status.isFollowing === isFollowing) {
          setPending(false)
          setPendingTxQueueId(null)
          // setIsFollowing call left in for callback symmetry — value already matches.
          setIsFollowing(status.isFollowing)
          pendingActionRef.current = null
          onFollowStateChangeRef.current?.(status.isFollowing)
          setHasUserAction(false)
        } else if (pollStartTimeRef.current && Date.now() - pollStartTimeRef.current < 90_000) {
          // Server result disagrees with anticipation but on-chain processing
          // can take 20-60s — keep polling for a bit before giving up.
          return
        } else {
          // Enough time has passed — accept the server state, even if it
          // contradicts what we anticipated (e.g. tx reverted).
          setPending(false)
          setPendingTxQueueId(null)
          setIsFollowing(status.isFollowing)
          pendingActionRef.current = null
          onFollowStateChangeRef.current?.(status.isFollowing)
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
  }, [isPolling, activeTokenId, activeToken?.tokenId, targetUserId, initialIsFollowing])

  const handleFollowClick = async () => {
    console.log('[FollowButton] handleFollowClick', { wrongWallet, isPending, isSigning, targetUserId, activeTokenId, activeTokenOwner: activeToken?.owner, connectedAddress: address, hasActiveSession })
    // Don't do anything if wrong wallet
    if (wrongWallet) {
      console.log('[FollowButton] Early return — wrongWallet')
      return
    }

    // Cancel path: if a follow/unfollow is in flight and we have its txQueueId,
    // a second click cancels it (and rolls back the ProfileChooser budget)
    // instead of being inert. Mirrors Like's handleCancelLike. We only attempt
    // a cancel while the row is still cancellable — once isSigning is over and
    // we have the id, the validator hasn't grabbed it yet.
    if (isPending && pendingTxQueueId) {
      try {
        await apiFetch(`/api/txqueue/${pendingTxQueueId}/cancel`, { method: 'POST' })
        usePendingSpendStore.getState().removePendingSpend(pendingTxQueueId)
        // Revert local UI: go back to whatever the server last confirmed.
        setIsFollowing(initialIsFollowing)
        setPending(false)
        setIsSigning(false)
        setPendingTxQueueId(null)
        setHasUserAction(false)
        pendingActionRef.current = null
        // Stop polling — there's nothing to wait for anymore.
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current)
          pollIntervalRef.current = null
        }
        pollStartTimeRef.current = null
        setIsPolling(false)
        onFollowStateChange?.(initialIsFollowing)
        return
      } catch (err: any) {
        // 409 = validator already picked it up. Leave the optimistic state
        // alone — the polling loop will reconcile to the server result.
        if (!String(err?.message || '').includes('409')) {
          console.error('Cancel follow failed', err)
        }
        return
      }
    }

    // No cancel handle yet (still signing, or the cancel just got cleared).
    // Treat as a no-op — a click during the wallet-sign window shouldn't
    // double-submit.
    if (isPending) return

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
      if (result?.txQueueId) setPendingTxQueueId(result.txQueueId)
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

  // `isFollowing` is normalized in the hook so it always reflects the
  // *anticipated* state (during pending) or the confirmed state (otherwise).
  // That lets this stay simple.
  const buttonText = isSigning ? t('follow.processing') : isFollowing ? t('follow.following') : t('follow.follow')
  const hoverText = isFollowing ? t('follow.unfollow') : t('follow.follow')

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
