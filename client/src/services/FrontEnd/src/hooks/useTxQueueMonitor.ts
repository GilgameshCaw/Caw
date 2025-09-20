import { useEffect } from 'react'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { apiFetch } from '~/api/client'

/**
 * Monitor txQueue status and update optimistic state accordingly
 */
export function useTxQueueMonitor() {
  const removePendingPostByTxQueueId = usePendingPostsStore(state => state.removePendingPostByTxQueueId)
  const pendingPosts = usePendingPostsStore(state => state.pendingPosts)
  const removeOptimisticLikeByTxQueueId = useOptimisticLikesStore(state => state.removeOptimisticLikeByTxQueueId)
  const optimisticLikes = useOptimisticLikesStore(state => state.optimisticLikes)

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
        response.statuses.forEach((status: any) => {
          if (status.status === 'failed') {
            // Remove the optimistic post or like associated with this failed txQueue entry
            console.log(`Removing optimistic updates for failed txQueue ID: ${status.id}`)
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
          } else if (status.status === 'done') {
            // The action was successful, it will be removed automatically when the real data appears
            // or after the timeout period
            console.log(`TxQueue ID ${status.id} succeeded, optimistic updates will auto-remove`)
          }
        })
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