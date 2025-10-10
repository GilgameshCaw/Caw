import { create } from 'zustand'
import type { CawItem } from '~/types'

interface PendingPost extends Partial<CawItem> {
  tempId: string
  content: string
  timestamp: string
  isPending: true
  isFailed?: boolean // Track if the post failed to submit
  txQueueId?: number // Track the associated txQueue ID
}

interface PendingPostsStore {
  pendingPosts: PendingPost[]
  addPendingPost: (post: { content: string; username: string; tokenId: number }) => string
  updatePostWithTxQueueId: (tempId: string, txQueueId: number) => void
  markPostAsFailed: (txQueueId: number) => void
  removePendingPost: (tempId: string) => void
  removePendingPostByTxQueueId: (txQueueId: number) => void
  clearPendingPosts: () => void
}

export const usePendingPostsStore = create<PendingPostsStore>((set) => ({
  pendingPosts: [],

  addPendingPost: (post) => {
    const tempId = `pending-${Date.now()}-${Math.random()}`
    const pendingPost: PendingPost = {
      tempId,
      id: tempId,
      content: post.content,
      timestamp: new Date().toISOString(),
      user: {
        tokenId: post.tokenId,
        username: post.username,
        id: post.tokenId
      },
      likeCount: 0,
      commentCount: 0,
      recawCount: 0,
      viewCount: 0,
      hasLiked: false,
      hasRecawed: false,
      cawonce: 0,
      isPending: true
    }

    set((state) => ({
      pendingPosts: [pendingPost, ...state.pendingPosts]
    }))

    // Auto-remove after 30 seconds if still pending
    setTimeout(() => {
      set((state) => ({
        pendingPosts: state.pendingPosts.filter(p => p.tempId !== tempId)
      }))
    }, 30000)

    return tempId
  },

  updatePostWithTxQueueId: (tempId, txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post =>
        post.tempId === tempId ? { ...post, txQueueId } : post
      )
    }))
  },

  markPostAsFailed: (txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.map(post =>
        post.txQueueId === txQueueId ? { ...post, isFailed: true } : post
      )
    }))
  },

  removePendingPostByTxQueueId: (txQueueId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.filter(p => p.txQueueId !== txQueueId)
    }))
  },

  removePendingPost: (tempId) => {
    set((state) => ({
      pendingPosts: state.pendingPosts.filter(p => p.tempId !== tempId)
    }))
  },

  clearPendingPosts: () => {
    set({ pendingPosts: [] })
  }
}))