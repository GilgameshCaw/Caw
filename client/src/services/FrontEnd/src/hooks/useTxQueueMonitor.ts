import { useEffect, useRef } from 'react'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { apiFetch } from '~/api/client'
import { useQuickSignRenewStore } from '~/components/modals/QuickSignRenewModal'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { privateKeyToAccount } from 'viem/accounts'
import { useAutoRetryStore } from '~/store/autoRetryStore'
import { TYPES, DOMAIN } from '~/api/actions'

// Track retry counts per TxQueue ID to prevent infinite loops
const cawonceRetries = new Map<number, number>()
const MAX_CAWONCE_RETRIES = 2

// Global callbacks for feed updates - set by Feed component
let feedRefreshCallback: (() => void) | null = null
let feedItemUpdateCallback: ((cawId: string, updates: Record<string, any>) => void) | null = null
let feedRefreshVisibleCallback: (() => void) | null = null

export function setFeedRefreshCallback(callback: (() => void) | null) {
  feedRefreshCallback = callback
}

export function setFeedItemUpdateCallback(callback: ((cawId: string, updates: Record<string, any>) => void) | null) {
  feedItemUpdateCallback = callback
}

/** Refresh all visible items in-place without resetting scroll */
export function setFeedRefreshVisibleCallback(callback: (() => void) | null) {
  feedRefreshVisibleCallback = callback
}

/**
 * Monitor txQueue status and update optimistic state accordingly
 */
export function useTxQueueMonitor() {
  const removePendingPostByTxQueueId = usePendingPostsStore(state => state.removePendingPostByTxQueueId)
  const removeOptimisticLikeByTxQueueId = useOptimisticLikesStore(state => state.removeOptimisticLikeByTxQueueId)
  const processedIds = useRef(new Set<number>())

  useEffect(() => {
    // Stable polling interval — reads current store state on each tick.
    // Previously the effect depended on pendingPosts/optimisticLikes/spendCount
    // and restarted (+ immediately re-fetched) every time any of those changed,
    // causing a burst of XHRs during thread submission.
    const getAllTxQueueIds = (): number[] => {
      const pendingPosts = usePendingPostsStore.getState().pendingPosts
      const optimisticLikes = useOptimisticLikesStore.getState().optimisticLikes
      const pendingSpendIds = Object.keys(usePendingSpendStore.getState().pendingByTxQueue).map(Number)
      const postTxQueueIds = pendingPosts
        .map(p => p.txQueueId)
        .filter((id): id is number => id !== undefined)
      const likeTxQueueIds = optimisticLikes
        .map(l => l.txQueueId)
        .filter((id): id is number => id !== undefined)
      return [...new Set([...postTxQueueIds, ...likeTxQueueIds, ...pendingSpendIds])]
    }

    const checkTxQueueStatus = async () => {
      const allTxQueueIds = getAllTxQueueIds()
      if (allTxQueueIds.length === 0) return
      try {
        // Fetch status for all txQueue entries
        const response = await apiFetch(`/api/txqueue/status?ids=${allTxQueueIds.join(',')}`)

        if (!response || !response.statuses) return

        // Process each status update
        let needsFeedRefresh = false
        let anyCompleted = false
        response.statuses.forEach((status: any) => {
          // Skip already processed IDs to avoid duplicate refreshes
          if (processedIds.current.has(status.id)) return

          if (status.status === 'failed') {
            const reason = (status.reason || '').toLowerCase()
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} failed: ${status.reason}`)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)

            // Show session renewal modal for session-related failures
            if (reason.includes('session expired') || (reason.includes('session') && reason.includes('not found'))) {
              const sessionStore = useSessionKeyStore.getState()
              if (sessionStore.enabled) {
                useQuickSignRenewStore.getState().show('expired')
              }
            } else if (reason.includes('spend limit')) {
              useQuickSignRenewStore.getState().show('spend_limit')
            } else if (reason.includes('cawonce already used')) {
              // Cawonce collision — auto-retry with a fresh cawonce using Quick Sign.
              // If Quick Sign isn't available or retries exhausted, silently drop it.
              const retryCount = cawonceRetries.get(status.id) || 0
              if (retryCount >= MAX_CAWONCE_RETRIES) {
                console.warn(`[TxQueueMonitor] Cawonce retry limit reached for TxQueue ${status.id}`)
                cawonceRetries.delete(status.id)
                // Failure is recorded server-side as an ACTION_FAILED
                // notification — no modal needed here.
              } else {
                cawonceRetries.set(status.id, retryCount + 1)
                console.log(`[TxQueueMonitor] Cawonce collision for TxQueue ${status.id}, auto-retrying (attempt ${retryCount + 1})`)

                // Flip the "retrying" flag BEFORE kicking off the async work so
                // the Notifications UI can swap its Retry button for a
                // "Retrying…" state immediately. The flag keyed by the original
                // TxQueue ID matches the ACTION_FAILED notification's
                // actionPayload.originalTxQueueId.
                useAutoRetryStore.getState().startRetry(status.id)

                // Async retry — fetch fresh cawonce, re-sign with session key, resubmit
                ;(async () => {
                  let retrySucceeded = false
                  try {
                    const senderId = status.senderId
                    const originalData = status.payload?.data
                    if (!senderId || !originalData) return

                    // Get fresh cawonce
                    const cawonceRes = await apiFetch(`/api/users/min-cawonce/${senderId}`)
                    const freshCawonce = cawonceRes.minSafeCawonce
                    if (freshCawonce == null) return

                    // Update local cawonce
                    useTokenDataStore.getState().setCawonce(senderId, freshCawonce + 1)

                    // Find the session key for the token owner
                    const user = await apiFetch(`/api/users/by-token/${senderId}`)
                    const ownerAddress = user?.address?.toLowerCase()
                    if (!ownerAddress) return

                    const sessionStore = useSessionKeyStore.getState()
                    const session = sessionStore.getSessionForAddress(ownerAddress)
                    if (!session || !sessionStore.enabled || session.expiry < Date.now() / 1000) {
                      console.log(`[TxQueueMonitor] No active session key for auto-retry`)
                      return
                    }

                    // Re-use the original message but swap in the fresh cawonce.
                    // Do NOT go through buildTypedData — the original amounts already
                    // include the validator tip, and buildTypedData would add a second one.
                    const message = { ...originalData, cawonce: freshCawonce }
                    const domain = DOMAIN
                    const types = TYPES
                    const primaryType = 'ActionData' as const

                    // Sign with session key
                    const sessionAccount = privateKeyToAccount(session.privateKey)
                    const signature = await sessionAccount.signTypedData({
                      domain,
                      types: { ActionData: TYPES.ActionData },
                      primaryType,
                      message,
                    })

                    // Submit new action
                    const isQuote = status.payload?.isQuote || false
                    await apiFetch('/api/actions', {
                      method: 'POST',
                      body: JSON.stringify({ data: message, domain, types, signature, isQuote }),
                    })

                    console.log(`[TxQueueMonitor] Auto-retried TxQueue ${status.id} with cawonce ${freshCawonce}`)
                    cawonceRetries.delete(status.id)
                    retrySucceeded = true

                    // Hide the ACTION_FAILED notification the server created
                    // for this original TxQueue row — from the user's
                    // perspective the action didn't really fail. Best-effort:
                    // any error here is non-fatal (worst case the user sees
                    // a stale notification with a working manual Retry).
                    try {
                      await apiFetch('/api/notifications/hide-by-original-tx', {
                        method: 'POST',
                        body: JSON.stringify({ userId: senderId, txQueueId: status.id }),
                      })
                    } catch (hideErr) {
                      console.warn(`[TxQueueMonitor] Failed to hide notification for retried tx ${status.id}:`, hideErr)
                    }
                  } catch (err) {
                    console.warn(`[TxQueueMonitor] Auto-retry failed for TxQueue ${status.id}:`, err)
                  } finally {
                    // Always clear the flag — on success the notification is
                    // already hidden server-side; on failure the original
                    // notification stays visible and the manual Retry button
                    // returns. `retrySucceeded` is informational only.
                    useAutoRetryStore.getState().endRetry(status.id)
                    void retrySucceeded
                  }
                })()
              }
            }
            // Previously a generic "Action Failed" modal was shown here for
            // terminal failures. That's been replaced by ACTION_FAILED
            // notifications created server-side by the validator — they're
            // durable (survive reloads), retryable (Session B), and don't
            // interrupt the user mid-action. The modal path is intentionally
            // removed; falling through to this point means the failure is
            // already recorded as a notification that the user will see
            // the next time they open the notifications panel.
          } else if (status.status === 'done') {
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} succeeded`)
            const wasPendingPost = usePendingPostsStore.getState().pendingPosts.some(p => p.txQueueId === status.id)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)
            anyCompleted = true
            if (wasPendingPost) {
              needsFeedRefresh = true
            }
            // When any action completes, refresh visible feed items to pick up
            // updated state (hasLiked, hasRecawed, etc.) without resetting scroll
            if (!wasPendingPost && feedRefreshVisibleCallback) {
              feedRefreshVisibleCallback()
            }
          }
        })

        // Refresh the feed only when new posts are confirmed (not for likes/recaws/etc.)
        if (needsFeedRefresh) {
          if (feedRefreshCallback) {
            console.log('[TxQueueMonitor] Triggering feed refresh (new post confirmed)')
            feedRefreshCallback()
          }
        }
        // Refresh token data when any action completes (staked balance changes)
        if (anyCompleted) {
          const refetch = useTokenDataStore.getState().refetchTokenData
          if (refetch) {
            refetch()
          }
        }
      } catch (error) {
        console.error('Error checking txQueue status:', error)
      }
    }

    // Check immediately on mount
    checkTxQueueStatus()

    // Then poll every 2 seconds. Interval is stable — store reads happen
    // inside getAllTxQueueIds(), so changes to pending posts/likes/spend
    // don't restart the interval (and don't trigger a burst of immediate fetches).
    const interval = setInterval(checkTxQueueStatus, 2000)

    return () => clearInterval(interval)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}