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
  /** Map of txQueueId -> timestamp when added */
  pendingTimestamps: Record<number, number>

  /** Record a new pending action spend */
  addPendingSpend: (txQueueId: number, amount: bigint) => void
  /** Remove a pending spend when txQueue confirms or fails */
  removePendingSpend: (txQueueId: number) => void
  /** Get effective staked amount (staked - pending), auto-cleaning stale entries */
  getEffectiveStake: (stakedAmount: bigint | undefined) => bigint
}

const STALE_THRESHOLD_MS = 2 * 60 * 1000 // 2 minutes

export const usePendingSpendStore = create<PendingSpendState>((set, get) => ({
  pendingSpend: 0n,
  pendingByTxQueue: {},
  pendingTimestamps: {},

  addPendingSpend: (txQueueId, amount) => set(state => ({
    pendingSpend: state.pendingSpend + amount,
    pendingByTxQueue: { ...state.pendingByTxQueue, [txQueueId]: amount },
    pendingTimestamps: { ...state.pendingTimestamps, [txQueueId]: Date.now() },
  })),

  removePendingSpend: (txQueueId) => set(state => {
    const amount = state.pendingByTxQueue[txQueueId]
    if (!amount) return state
    const { [txQueueId]: _, ...restSpends } = state.pendingByTxQueue
    const { [txQueueId]: __, ...restTimestamps } = state.pendingTimestamps
    return {
      pendingSpend: state.pendingSpend - amount,
      pendingByTxQueue: restSpends,
      pendingTimestamps: restTimestamps,
    }
  }),

  getEffectiveStake: (stakedAmount) => {
    if (!stakedAmount) return 0n

    // Auto-clean stale entries (older than 5 min — likely failed or already confirmed)
    const state = get()
    const now = Date.now()
    let cleanedSpend = 0n
    const staleIds: number[] = []

    for (const [idStr, amount] of Object.entries(state.pendingByTxQueue)) {
      const id = Number(idStr)
      const ts = state.pendingTimestamps[id] || 0
      if (now - ts > STALE_THRESHOLD_MS) {
        staleIds.push(id)
      } else {
        cleanedSpend += amount
      }
    }

    // Remove stale entries in the background
    if (staleIds.length > 0) {
      console.log(`[PendingSpend] Cleaning ${staleIds.length} stale entries`)
      setTimeout(() => {
        const store = get()
        const newByTxQueue = { ...store.pendingByTxQueue }
        const newTimestamps = { ...store.pendingTimestamps }
        let removed = 0n
        for (const id of staleIds) {
          if (newByTxQueue[id]) {
            removed += newByTxQueue[id]
            delete newByTxQueue[id]
            delete newTimestamps[id]
          }
        }
        set({
          pendingByTxQueue: newByTxQueue,
          pendingTimestamps: newTimestamps,
          pendingSpend: store.pendingSpend - removed,
        })
      }, 0)
    }

    return stakedAmount > cleanedSpend ? stakedAmount - cleanedSpend : 0n
  },
}))
