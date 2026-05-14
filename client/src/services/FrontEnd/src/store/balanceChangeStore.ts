import { create } from 'zustand'

/**
 * Live "balance change" toast feed.
 *
 * Each window has an expiry. The displayed total is the sum of all
 * *currently-live* windows' deltas — so a fast stream looks like:
 *
 *   +5k arrives at t=0  (expires t=10s)
 *   +3k arrives at t=2  (expires t=12s)            → shows +8k
 *   (t=10s, first window expires)                  → shows +3k
 *   (t=12s, second expires)                        → hidden
 *
 * This is intentionally NOT a stack of toasts. One element on screen,
 * net of what's live. Reduces visual noise when activity bursts.
 *
 * Values are in wei (10^18). Positive = incoming, negative = outgoing.
 */
interface BalanceWindow {
  id: number
  delta: bigint
  expiresAt: number
  /** Stable key from the source (notification id, txQueueId, deposit hash)
   *  — used to dedupe re-renders / re-polls so the same event doesn't
   *  fire two windows. */
  source: string
}

interface BalanceChangeState {
  windows: BalanceWindow[]
  /** Set of `source` keys we've already created a window for. Survives
   *  the window's lifetime so a poll that re-sees the same source after
   *  expiry doesn't refire it. Bounded — see addWindow. */
  seenSources: Set<string>
  /** Monotonic id generator. */
  _nextId: number

  addWindow: (delta: bigint, durationMs: number, source: string) => void
  /** Drop expired windows. Called on a tick from a hook. Returns true if
   *  any windows were dropped (so callers can re-render). */
  sweep: () => boolean
  /** Sum of currently-live window deltas. Computed lazily — call sweep()
   *  first if you need stale entries excluded. */
  getNet: () => bigint
}

const MAX_SEEN = 5_000

export const useBalanceChangeStore = create<BalanceChangeState>((set, get) => ({
  windows: [],
  seenSources: new Set(),
  _nextId: 1,

  addWindow: (delta, durationMs, source) => {
    const state = get()
    if (state.seenSources.has(source)) return
    // Bounded set — drop oldest half when too large. Keeps long sessions
    // from leaking memory while still deduping recent activity.
    const newSeen = state.seenSources.size >= MAX_SEEN
      ? new Set(Array.from(state.seenSources).slice(state.seenSources.size / 2))
      : new Set(state.seenSources)
    newSeen.add(source)
    set({
      windows: [
        ...state.windows,
        { id: state._nextId, delta, expiresAt: Date.now() + durationMs, source },
      ],
      seenSources: newSeen,
      _nextId: state._nextId + 1,
    })
  },

  sweep: () => {
    const now = Date.now()
    const state = get()
    const live = state.windows.filter(w => w.expiresAt > now)
    if (live.length === state.windows.length) return false
    set({ windows: live })
    return true
  },

  getNet: () => {
    return get().windows.reduce((acc, w) => acc + w.delta, 0n)
  },
}))
