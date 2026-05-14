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
   *  fire two windows. Also the join key used by confirmWindow to upgrade
   *  a pending window to confirmed in place. */
  source: string
  /** Pending = action signed and queued client-side but the validator
   *  hasn't confirmed yet. Toast renders these dim/grey so the user gets
   *  immediate visual feedback at click time. Flipped to false (and
   *  delta possibly updated) by confirmWindow when the txqueue 'done'
   *  branch fires. */
  pending: boolean
}

interface BalanceChangeState {
  windows: BalanceWindow[]
  /** Set of `source` keys we've already created a window for. Survives
   *  the window's lifetime so a poll that re-sees the same source after
   *  expiry doesn't refire it. Bounded — see addWindow. */
  seenSources: Set<string>
  /** Monotonic id generator. */
  _nextId: number

  addWindow: (delta: bigint, durationMs: number, source: string, opts?: { pending?: boolean }) => void
  /** Upgrade a pending window (matched by source) to confirmed. Updates
   *  delta + extends expiry. If no matching pending window exists (it
   *  already expired, or the action skipped the pending step) this falls
   *  through to addWindow so the confirmed amount still surfaces. */
  confirmWindow: (delta: bigint, durationMs: number, source: string) => void
  /** Drop any live pending window for this source. Called when an action
   *  fails or is cancelled — the user's spend didn't happen, so the
   *  grey pending pill shouldn't linger for its full 20s duration. */
  dropPendingWindow: (source: string) => void
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

  addWindow: (delta, durationMs, source, opts) => {
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
        { id: state._nextId, delta, expiresAt: Date.now() + durationMs, source, pending: !!opts?.pending },
      ],
      seenSources: newSeen,
      _nextId: state._nextId + 1,
    })
  },

  confirmWindow: (delta, durationMs, source) => {
    const state = get()
    // Match by source — pending window already created at click time.
    const existing = state.windows.find(w => w.source === source && w.pending)
    if (existing) {
      // Upgrade in place: flip pending→false, replace delta (validator's
      // settled cost may differ from the optimistic estimate). Keep the
      // ORIGINAL expiry — the pill shouldn't linger longer just because
      // the confirm arrived; the 5s budget is from click time, not from
      // confirm time.
      set({
        windows: state.windows.map(w =>
          w.id === existing.id
            ? { ...w, pending: false, delta }
            : w
        ),
      })
      return
    }
    // No pending window matched — either the user clicked just before the
    // pending window expired, or some path skipped addWindow at click
    // time. Fall through to a fresh confirmed window so the amount still
    // surfaces. We add it directly (not via addWindow) because seenSources
    // already holds this source key from the pending step, which would
    // otherwise dedup the confirm into a no-op.
    if (state.seenSources.has(source)) {
      // Already-seen but no live pending window — append a fresh confirmed
      // entry directly, bypassing the dedup gate.
      set({
        windows: [
          ...state.windows,
          { id: state._nextId, delta, expiresAt: Date.now() + durationMs, source, pending: false },
        ],
        _nextId: state._nextId + 1,
      })
    } else {
      get().addWindow(delta, durationMs, source)
    }
  },

  dropPendingWindow: (source) => {
    const state = get()
    const hasLivePending = state.windows.some(w => w.source === source && w.pending)
    if (!hasLivePending) return
    set({ windows: state.windows.filter(w => !(w.source === source && w.pending)) })
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
