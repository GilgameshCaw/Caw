import { create } from 'zustand'

/**
 * Tracks CAW tokens that have been committed to pending actions
 * but not yet confirmed on-chain. This prevents the user from
 * submitting actions that would exceed their staked balance.
 *
 * Values are in wei (10^18).
 */
interface PendingSpendState {
  /** Total pending spend in wei across all unconfirmed actions */
  pendingSpend: bigint
  /** Map of txQueueId -> spend amount for cleanup on confirm/fail */
  pendingByTxQueue: Record<number, bigint>

  /** Record a new pending action spend */
  addPendingSpend: (txQueueId: number, amount: bigint) => void
  /** Remove a pending spend when txQueue confirms or fails */
  removePendingSpend: (txQueueId: number) => void
  /** Get effective staked amount (staked - pending) */
  getEffectiveStake: (stakedAmount: bigint | undefined) => bigint
}

export const usePendingSpendStore = create<PendingSpendState>((set, get) => ({
  pendingSpend: 0n,
  pendingByTxQueue: {},

  addPendingSpend: (txQueueId, amount) => set(state => ({
    pendingSpend: state.pendingSpend + amount,
    pendingByTxQueue: { ...state.pendingByTxQueue, [txQueueId]: amount },
  })),

  removePendingSpend: (txQueueId) => set(state => {
    const amount = state.pendingByTxQueue[txQueueId]
    if (!amount) return state
    const { [txQueueId]: _, ...rest } = state.pendingByTxQueue
    return {
      pendingSpend: state.pendingSpend - amount,
      pendingByTxQueue: rest,
    }
  }),

  getEffectiveStake: (stakedAmount) => {
    if (!stakedAmount) return 0n
    const pending = get().pendingSpend
    return stakedAmount > pending ? stakedAmount - pending : 0n
  },
}))
