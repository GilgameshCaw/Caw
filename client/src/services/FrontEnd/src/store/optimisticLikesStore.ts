import { create } from 'zustand'

interface OptimisticLike {
  tempId: string
  userId: number
  cawId: string | number
  txQueueId?: number
}

interface OptimisticLikesStore {
  optimisticLikes: OptimisticLike[]
  addOptimisticLike: (like: { userId: number; cawId: string | number }) => string
  updateLikeWithTxQueueId: (tempId: string, txQueueId: number) => void
  removeOptimisticLike: (tempId: string) => void
  removeOptimisticLikeByTxQueueId: (txQueueId: number) => void
  isOptimisticallyLiked: (userId: number, cawId: string | number) => boolean
  clearOptimisticLikes: () => void
}

export const useOptimisticLikesStore = create<OptimisticLikesStore>((set, get) => ({
  optimisticLikes: [],

  addOptimisticLike: (like) => {
    const tempId = `like-${Date.now()}-${Math.random()}`
    const optimisticLike: OptimisticLike = {
      tempId,
      userId: like.userId,
      cawId: like.cawId
    }

    set((state) => ({
      optimisticLikes: [...state.optimisticLikes, optimisticLike]
    }))

    // Auto-remove after 30 seconds if still pending
    setTimeout(() => {
      set((state) => ({
        optimisticLikes: state.optimisticLikes.filter(l => l.tempId !== tempId)
      }))
    }, 30000)

    return tempId
  },

  updateLikeWithTxQueueId: (tempId, txQueueId) => {
    set((state) => ({
      optimisticLikes: state.optimisticLikes.map(like =>
        like.tempId === tempId ? { ...like, txQueueId } : like
      )
    }))
  },

  removeOptimisticLike: (tempId) => {
    set((state) => ({
      optimisticLikes: state.optimisticLikes.filter(l => l.tempId !== tempId)
    }))
  },

  removeOptimisticLikeByTxQueueId: (txQueueId) => {
    set((state) => ({
      optimisticLikes: state.optimisticLikes.filter(l => l.txQueueId !== txQueueId)
    }))
  },

  isOptimisticallyLiked: (userId, cawId) => {
    return get().optimisticLikes.some(
      like => like.userId === userId && like.cawId === cawId
    )
  },

  clearOptimisticLikes: () => {
    set({ optimisticLikes: [] })
  }
}))