import { useEffect, useRef } from 'react'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { apiFetch } from '~/api/client'
import { useQuickSignRenewStore } from '~/components/modals/QuickSignRenewModal'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { useActionErrorStore } from '~/store/actionErrorStore'

// Global callbacks for feed refresh - set by Feed component
let feedRefreshCallback: (() => void) | null = null

export function setFeedRefreshCallback(callback: (() => void) | null) {
  feedRefreshCallback = callback
}

/**
 * Monitor txQueue status and update optimistic state accordingly
 */
export function useTxQueueMonitor() {
  const removePendingPostByTxQueueId = usePendingPostsStore(state => state.removePendingPostByTxQueueId)
  const pendingPosts = usePendingPostsStore(state => state.pendingPosts)
  const removeOptimisticLikeByTxQueueId = useOptimisticLikesStore(state => state.removeOptimisticLikeByTxQueueId)
  const optimisticLikes = useOptimisticLikesStore(state => state.optimisticLikes)
  const pendingSpendCount = usePendingSpendStore(state => Object.keys(state.pendingByTxQueue).length)
  const processedIds = useRef(new Set<number>())

  useEffect(() => {
    // Collect all txQueue IDs that need monitoring
    const postsWithTxQueueIds = pendingPosts.filter(p => p.txQueueId)
    const likesWithTxQueueIds = optimisticLikes.filter(l => l.txQueueId)
    const pendingSpendIds = Object.keys(usePendingSpendStore.getState().pendingByTxQueue).map(Number)

    const postTxQueueIds = postsWithTxQueueIds
      .map(p => p.txQueueId)
      .filter((id): id is number => id !== undefined)
    const likeTxQueueIds = likesWithTxQueueIds
      .map(l => l.txQueueId)
      .filter((id): id is number => id !== undefined)
    const allTxQueueIds = [...new Set([...postTxQueueIds, ...likeTxQueueIds, ...pendingSpendIds])]

    if (allTxQueueIds.length === 0) return

    const checkTxQueueStatus = async () => {
      try {
        if (allTxQueueIds.length === 0) return

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
              // Cawonce collision — silently bump the local cawonce so the next action uses a fresh one.
              // Don't show an error — the user's action likely already went through via a previous attempt.
              console.log(`[TxQueueMonitor] Cawonce collision for TxQueue ${status.id}, bumping local cawonce`)
              const tokenDataStore = useTokenDataStore.getState()
              if (status.senderId) {
                // Sync cawonce from server to get the correct next value
                apiFetch(`/api/users/min-cawonce/${status.senderId}`)
                  .then((res: any) => {
                    if (res.minSafeCawonce != null) {
                      tokenDataStore.setCawonce(status.senderId, res.minSafeCawonce)
                    }
                  })
                  .catch(() => {})
              }
            } else if (reason) {
              // Map technical errors to user-friendly messages
              let userMessage = 'Something went wrong while processing your action. Please try again.'
              if (reason.includes('insufficient')) {
                userMessage = 'You don\'t have enough staked CAW for this action.'
              } else if (reason.includes('not authenticated')) {
                userMessage = 'Your account needs to be authenticated with this client. Please try reconnecting.'
              } else if (reason.includes('cannot follow yourself')) {
                userMessage = 'You can\'t follow your own account.'
              } else if (reason.includes('text exceeds')) {
                userMessage = 'Your post is too long. Please shorten it and try again.'
              }
              useActionErrorStore.getState().show('Action Failed', userMessage)
            }
          } else if (status.status === 'done') {
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} succeeded`)
            // Only trigger a full feed refresh for new posts (which have a pending post entry).
            // Likes, recaws, replies, follows, and tips are updated in-place by Feed's own polling,
            // so a full refresh would just wipe the feed and scroll the user to the top.
            const wasPendingPost = pendingPosts.some(p => p.txQueueId === status.id)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)
            anyCompleted = true
            if (wasPendingPost) {
              needsFeedRefresh = true
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

    // Check immediately
    checkTxQueueStatus()

    // Then poll every 2 seconds while there are pending posts
    const interval = setInterval(checkTxQueueStatus, 2000)

    return () => clearInterval(interval)
  }, [pendingPosts, optimisticLikes, pendingSpendCount, removePendingPostByTxQueueId, removeOptimisticLikeByTxQueueId])
}