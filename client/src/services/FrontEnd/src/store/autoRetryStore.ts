import { create } from 'zustand'

/**
 * Tracks which failed TxQueue IDs are currently being auto-retried by the
 * useTxQueueMonitor cawonce-collision recovery path. Written by the monitor
 * when an auto-retry starts/ends; read by the Notifications component so
 * the Retry button on an ACTION_FAILED notification can show "Retrying…"
 * while the auto-retry is in flight.
 *
 * Matched to notifications via the payload's `originalTxQueueId`. When the
 * monitor finishes an auto-retry successfully it also calls a backend
 * endpoint to mark the notification hidden, so the "retrying" state is
 * short-lived — either it transitions to hidden (success) or back to a
 * plain Retry button (failure).
 */
interface AutoRetryState {
  retryingTxIds: Set<number>
  startRetry: (txQueueId: number) => void
  endRetry: (txQueueId: number) => void
  isRetrying: (txQueueId: number | undefined) => boolean
}

export const useAutoRetryStore = create<AutoRetryState>((set, get) => ({
  retryingTxIds: new Set(),
  startRetry: (txQueueId) => set(state => {
    const next = new Set(state.retryingTxIds)
    next.add(txQueueId)
    return { retryingTxIds: next }
  }),
  endRetry: (txQueueId) => set(state => {
    const next = new Set(state.retryingTxIds)
    next.delete(txQueueId)
    return { retryingTxIds: next }
  }),
  isRetrying: (txQueueId) => {
    if (txQueueId == null) return false
    return get().retryingTxIds.has(txQueueId)
  },
}))
