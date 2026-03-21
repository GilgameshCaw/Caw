import { create } from 'zustand'

interface InsufficientStakeState {
  isOpen: boolean
  currentAmount?: bigint
  requiredAmount?: bigint
  actionType: 'post' | 'like' | 'repost' | 'profile'
  onStake?: () => void
  show: (currentAmount: bigint | undefined, requiredAmount: bigint, actionType?: 'post' | 'like' | 'repost' | 'profile') => void
  close: () => void
  setOnStake: (handler: (() => void) | undefined) => void
}

export const useInsufficientStakeStore = create<InsufficientStakeState>((set) => ({
  isOpen: false,
  actionType: 'post',
  onStake: undefined,
  show: (currentAmount, requiredAmount, actionType = 'post') =>
    set({ isOpen: true, currentAmount, requiredAmount, actionType }),
  close: () =>
    set({ isOpen: false, currentAmount: undefined, requiredAmount: undefined }),
  setOnStake: (handler) => set({ onStake: handler }),
}))
