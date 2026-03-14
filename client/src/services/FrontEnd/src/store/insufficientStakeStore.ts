import { create } from 'zustand'

interface InsufficientStakeState {
  isOpen: boolean
  currentAmount?: bigint
  requiredAmount?: bigint
  actionType: 'post' | 'like' | 'repost' | 'profile'
  show: (currentAmount: bigint | undefined, requiredAmount: bigint, actionType?: 'post' | 'like' | 'repost' | 'profile') => void
  close: () => void
}

export const useInsufficientStakeStore = create<InsufficientStakeState>((set) => ({
  isOpen: false,
  actionType: 'post',
  show: (currentAmount, requiredAmount, actionType = 'post') =>
    set({ isOpen: true, currentAmount, requiredAmount, actionType }),
  close: () =>
    set({ isOpen: false, currentAmount: undefined, requiredAmount: undefined })
}))
