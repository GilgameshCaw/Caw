import { useEffect, useRef, useCallback } from 'react'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { apiFetch } from '~/api/client'

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
            // Remove the optimistic post or like associated with this failed txQueue entry
            console.log(`[TxQueueMonitor] Removing optimistic updates for failed txQueue ID: ${status.id}`)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            processedIds.current.add(status.id)
          } else if (status.status === 'done') {
            // The action was successful - remove the pending post and refresh the feed
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} succeeded, removing pending post and refreshing feed`)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            processedIds.current.add(status.id)
            needsRefresh = true
          }
        })

        // Refresh the feed if any actions completed
        if (needsRefresh && feedRefreshCallback) {
          console.log('[TxQueueMonitor] Triggering feed refresh')
          feedRefreshCallback()
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