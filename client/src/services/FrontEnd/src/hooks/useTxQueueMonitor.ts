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
  const processedIds = useRef(new Set<number>())

  useEffect(() => {
    // Don't poll if there are no pending posts or likes with txQueue IDs
    const postsWithTxQueueIds = pendingPosts.filter(p => p.txQueueId)
    const likesWithTxQueueIds = optimisticLikes.filter(l => l.txQueueId)

    if (postsWithTxQueueIds.length === 0 && likesWithTxQueueIds.length === 0) return

    const checkTxQueueStatus = async () => {
      try {
        // Get all txQueue IDs from pending posts and likes
        const postTxQueueIds = postsWithTxQueueIds
          .map(p => p.txQueueId)
          .filter((id): id is number => id !== undefined)

        const likeTxQueueIds = likesWithTxQueueIds
          .map(l => l.txQueueId)
          .filter((id): id is number => id !== undefined)

        const allTxQueueIds = [...new Set([...postTxQueueIds, ...likeTxQueueIds])]

        if (allTxQueueIds.length === 0) return

        // Fetch status for all txQueue entries
        const response = await apiFetch(`/api/txqueue/status?ids=${allTxQueueIds.join(',')}`)

        if (!response || !response.statuses) return

        // Process each status update
        let needsRefresh = false
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
            } else if (reason) {
              // Map technical errors to user-friendly messages
              let userMessage = 'Something went wrong while processing your action. Please try again.'
              if (reason.includes('cawonce already used')) {
                userMessage = 'This action was already processed. Please try again.'
              } else if (reason.includes('insufficient')) {
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
            // The action was successful - remove the pending post and refresh the feed
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} succeeded, removing pending post and refreshing feed`)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)
            needsRefresh = true
          }
        })

        // Refresh the feed and token data if any actions completed
        if (needsRefresh) {
          if (feedRefreshCallback) {
            console.log('[TxQueueMonitor] Triggering feed refresh')
            feedRefreshCallback()
          }
          // Refetch token data (staked balance, etc.) since actions spend CAW
          const refetch = useTokenDataStore.getState().refetchTokenData
          if (refetch) {
            console.log('[TxQueueMonitor] Refreshing token data')
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
  }, [pendingPosts, optimisticLikes, removePendingPostByTxQueueId, removeOptimisticLikeByTxQueueId])
}