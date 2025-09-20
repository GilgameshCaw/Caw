import { create } from 'zustand'
import { FeedItem } from '~/types'

interface OptimisticPost extends Omit<FeedItem, 'id' | 'createdAt'> {
  tempId: string
  createdAt: string
  status: 'pending' | 'confirmed' | 'failed'
  txHash?: string
  txQueueId?: number // Track the associated txQueue ID
}

interface OptimisticPostsStore {
  optimisticPosts: OptimisticPost[]
  addOptimisticPost: (post: Omit<OptimisticPost, 'tempId' | 'status' | 'createdAt'>) => string
  updatePostStatus: (tempId: string, status: 'confirmed' | 'failed', realId?: number) => void
  removeOptimisticPost: (tempId: string) => void
  removeOptimisticPostByTxQueueId: (txQueueId: number) => void
  clearOptimisticPosts: () => void
}

export const useOptimisticPostsStore = create<OptimisticPostsStore>((set) => ({
  optimisticPosts: [],

  addOptimisticPost: (post) => {
    const tempId = `temp-${Date.now()}-${Math.random()}`
    const optimisticPost: OptimisticPost = {
      ...post,
      tempId,
      createdAt: new Date().toISOString(),
      status: 'pending'
    }

    set((state) => ({
      optimisticPosts: [optimisticPost, ...state.optimisticPosts]
    }))

    return tempId
  },

  updatePostStatus: (tempId, status, realId) => {
    set((state) => ({
      optimisticPosts: state.optimisticPosts.map(post =>
        post.tempId === tempId
          ? { ...post, status, ...(realId ? { id: realId } : {}) }
          : post
      )
    }))

    // Remove confirmed posts after a delay to allow for smooth transition
    if (status === 'confirmed') {
      setTimeout(() => {
        set((state) => ({
          optimisticPosts: state.optimisticPosts.filter(p => p.tempId !== tempId)
        }))
      }, 2000)
    }
  },

  removeOptimisticPost: (tempId) => {
    set((state) => ({
      optimisticPosts: state.optimisticPosts.filter(p => p.tempId !== tempId)
    }))
  },

  removeOptimisticPostByTxQueueId: (txQueueId) => {
    set((state) => ({
      optimisticPosts: state.optimisticPosts.filter(p => p.txQueueId !== txQueueId)
    }))
  },

  clearOptimisticPosts: () => {
    set({ optimisticPosts: [] })
  }
}))