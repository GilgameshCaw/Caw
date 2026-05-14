import { useEffect, useRef } from 'react'
import { usePendingPostsStore } from '~/store/pendingPostsStore'
import { useOptimisticLikesStore } from '~/store/optimisticLikesStore'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { usePendingSpendStore } from '~/store/pendingSpendStore'
import { useBalanceChangeStore } from '~/store/balanceChangeStore'
import { apiFetch } from '~/api/client'
import { useQuickSignRenewStore } from '~/components/modals/QuickSignRenewModal'
import { useSessionKeyStore } from '~/store/sessionKeyStore'
import { privateKeyToAccount } from 'viem/accounts'
import { useAutoRetryStore } from '~/store/autoRetryStore'
import { TYPES, DOMAIN, allocateCawonces, retryBatchByBatchId } from '~/api/actions'

// Track retry counts per TxQueue ID to prevent infinite loops.
// Persisted to sessionStorage so retries don't reset on page refresh.
const RETRY_STORAGE_KEY = 'caw:cawonceRetries'
function loadRetries(): Map<number, number> {
  try {
    const raw = sessionStorage.getItem(RETRY_STORAGE_KEY)
    if (raw) return new Map(JSON.parse(raw))
  } catch {}
  return new Map()
}
function saveRetries(map: Map<number, number>) {
  try { sessionStorage.setItem(RETRY_STORAGE_KEY, JSON.stringify([...map])) } catch {}
}
const cawonceRetries = loadRetries()
const MAX_CAWONCE_RETRIES = 2

// Global callbacks for feed updates - set by Feed component
let feedRefreshCallback: (() => void) | null = null
let feedItemUpdateCallback: ((cawId: string, updates: Record<string, any>) => void) | null = null
let feedRefreshVisibleCallback: (() => void) | null = null

export function setFeedRefreshCallback(callback: (() => void) | null) {
  feedRefreshCallback = callback
}

export function setFeedItemUpdateCallback(callback: ((cawId: string, updates: Record<string, any>) => void) | null) {
  feedItemUpdateCallback = callback
}

/** Refresh all visible items in-place without resetting scroll */
export function setFeedRefreshVisibleCallback(callback: (() => void) | null) {
  feedRefreshVisibleCallback = callback
}

/**
 * Monitor txQueue status and update optimistic state accordingly
 */
export function useTxQueueMonitor() {
  const removePendingPostByTxQueueId = usePendingPostsStore(state => state.removePendingPostByTxQueueId)
  const removeOptimisticLikeByTxQueueId = useOptimisticLikesStore(state => state.removeOptimisticLikeByTxQueueId)
  const processedIds = useRef(new Set<number>())

  useEffect(() => {
    // Stable polling interval — reads current store state on each tick.
    // Previously the effect depended on pendingPosts/optimisticLikes/spendCount
    // and restarted (+ immediately re-fetched) every time any of those changed,
    // causing a burst of XHRs during thread submission.
    const getAllTxQueueIds = (): number[] => {
      const pendingPosts = usePendingPostsStore.getState().pendingPosts
      const optimisticLikes = useOptimisticLikesStore.getState().optimisticLikes
      const pendingSpendIds = Object.keys(usePendingSpendStore.getState().pendingByTxQueue).map(Number)
      const postTxQueueIds = pendingPosts
        .map(p => p.txQueueId)
        .filter((id): id is number => id !== undefined)
      const likeTxQueueIds = optimisticLikes
        .map(l => l.txQueueId)
        .filter((id): id is number => id !== undefined)
      return [...new Set([...postTxQueueIds, ...likeTxQueueIds, ...pendingSpendIds])]
    }

    const checkTxQueueStatus = async () => {
      const allTxQueueIds = getAllTxQueueIds()
      if (allTxQueueIds.length === 0) return
      try {
        // Fetch status for all txQueue entries
        const response = await apiFetch(`/api/txqueue/status?ids=${allTxQueueIds.join(',')}`)

        if (!response || !response.statuses) return

        // Process each status update
        let needsFeedRefresh = false
        let anyCompleted = false
        response.statuses.forEach((status: any) => {
          // Skip already processed IDs to avoid duplicate refreshes
          if (processedIds.current.has(status.id)) return

          if (status.status === 'failed') {
            const reason = (status.reason || '').toLowerCase()
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} failed: ${status.reason}`)
            const willRetry = reason.includes('cawonce already used') && !cawonceRetries.has(status.id)
            if (!willRetry) {
              // Only remove pending post if we're NOT going to auto-retry
              removePendingPostByTxQueueId(status.id)
            }
            removeOptimisticLikeByTxQueueId(status.id)
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)

            // Show session renewal modal for session-related failures.
            // When the failed row is part of a batched thread (status.batchId
            // is set), wire an onRetry that resubmits the WHOLE batch via
            // retryBatchByBatchId — otherwise the user has to manually
            // re-trigger each thread member individually and siblings
            // historically stayed dead in the queue (incident 2026-05-12:
            // TxQueue 64476 retried, sibling 64477 abandoned). Single-row
            // failures get the original no-retry behaviour.
            //
            // "Session expired or not found" classification has a known
            // false-positive variant (per memory feedback_session_check_decode_failure) —
            // most of the time the user's session IS valid, the retry
            // just needs a fresh cawonce and the actions land cleanly.
            const isSessionFailure = reason.includes('session expired') ||
              (reason.includes('session') && reason.includes('not found'))
            const isSpendLimitFailure = reason.includes('spend limit')
            if (isSessionFailure || isSpendLimitFailure) {
              const sessionStore = useSessionKeyStore.getState()
              if (sessionStore.enabled) {
                const failedBatchId = status.batchId ?? null
                const failedRowId = status.id
                const onRetry = failedBatchId
                  ? async () => {
                      try {
                        const result = await retryBatchByBatchId(failedBatchId, failedRowId)
                        if (result.resubmitted > 0) {
                          console.log(`[TxQueueMonitor] Batch retry recovered ${result.resubmitted} row(s) for batch ${failedBatchId}`)
                        } else {
                          console.log(`[TxQueueMonitor] Batch retry no-op (${result.reason ?? 'unknown'}) for batch ${failedBatchId}`)
                        }
                      } catch (err) {
                        console.warn(`[TxQueueMonitor] Batch retry threw for batch ${failedBatchId}:`, err)
                      }
                    }
                  : undefined
                useQuickSignRenewStore.getState().show(
                  isSpendLimitFailure ? 'spend_limit' : 'expired',
                  onRetry,
                )
              }
            } else if (reason.includes('cawonce already used')) {
              // Cawonce collision — auto-retry with a fresh cawonce using Quick Sign.
              // Each txqueue ID gets exactly one retry attempt.
              if (cawonceRetries.has(status.id)) {
                console.log(`[TxQueueMonitor] TxQueue ${status.id} already retried, skipping`)
              } else {
                // Mark as retried IMMEDIATELY so a page refresh or subsequent
                // poll during the async retry won't start another attempt.
                cawonceRetries.set(status.id, MAX_CAWONCE_RETRIES)
                saveRetries(cawonceRetries)
                console.log(`[TxQueueMonitor] Cawonce collision for TxQueue ${status.id}, auto-retrying`)

                // Flip the "retrying" flag BEFORE kicking off the async work so
                // the Notifications UI can swap its Retry button for a
                // "Retrying…" state immediately. The flag keyed by the original
                // TxQueue ID matches the ACTION_FAILED notification's
                // actionPayload.originalTxQueueId.
                useAutoRetryStore.getState().startRetry(status.id)

                // Async retry — fetch fresh cawonce, re-sign with session key, resubmit
                ;(async () => {
                  let retrySucceeded = false
                  try {
                    const senderId = status.senderId
                    const originalData = status.payload?.data
                    if (!senderId || !originalData) return

                    // Pre-flight: did the action ACTUALLY land already?
                    // The validator's "Cawonce already used" rejection just
                    // means the chain bitmap was set — but if a peer mirror
                    // (or an earlier same-content submission from another
                    // tab) already landed OUR exact payload, retrying would
                    // create a duplicate post at a fresh cawonce. The
                    // server-side check looks at the local Action table for
                    // a content match.
                    //
                    // Three verdicts:
                    //   'ours'      → action already on chain, mark this
                    //                 row done client-side and skip retry.
                    //   'collision' → slot used by different content; real
                    //                 retry needed.
                    //   'unknown'   → indexer hasn't caught up; proceed with
                    //                 retry (same behaviour as today —
                    //                 worst case stays no worse than the
                    //                 status quo).
                    try {
                      const landedRes = await apiFetch<{ landed: 'ours' | 'collision' | 'unknown' }>(
                        `/api/txqueue/check-landed/${status.id}`,
                      )
                      if (landedRes?.landed === 'ours') {
                        console.log(`[TxQueueMonitor] TxQueue ${status.id} action already landed on chain — skipping retry to avoid duplicate`)
                        // Clean up the failed-state UI for this row. The
                        // server keeps TxQueue.status='failed' (the row
                        // never made it through the validator's success
                        // path) but the user-visible truth is "this
                        // succeeded" — hide the failure notification and
                        // drop the pending post tracking so the indexed
                        // Caw row (which already has status=SUCCESS) is
                        // the only copy the feed dedup sees.
                        try {
                          await apiFetch('/api/notifications/hide-by-original-tx', {
                            method: 'POST',
                            body: JSON.stringify({ userId: senderId, txQueueId: status.id }),
                          })
                        } catch { /* non-fatal */ }
                        // The pending post was kept earlier under the
                        // assumption a retry would hook into it. Since we
                        // ARE NOT retrying, drop it now — the chain Caw
                        // row is the canonical post.
                        removePendingPostByTxQueueId(status.id)
                        retrySucceeded = true // for the cleanup flag below
                        return
                      }
                      // 'collision' or 'unknown' → fall through to the
                      // existing retry flow below.
                    } catch (err) {
                      // check-landed failure is non-fatal — fall through to
                      // the original retry path. The dedup safety here is
                      // strictly additive; if the check errors we're no
                      // worse off than before this commit.
                      console.warn(`[TxQueueMonitor] check-landed failed for ${status.id}, proceeding with retry:`, err)
                    }

                    // Allocate a fresh cawonce via the same allocator
                    // the original-submission path uses. /api/users/
                    // min-cawonce only sees pending/processing/scheduled
                    // rows — when multiple failed retries fire in
                    // parallel right after a deposit lands, each one
                    // sees the same picture and gets the same cawonce.
                    // allocateCawonces uses chain.nextCawonce + a
                    // per-tab promise chain + Web Lock + BroadcastChannel
                    // high-watermark, so concurrent retries within or
                    // across tabs each get a unique value.
                    const [freshCawonce] = await allocateCawonces(senderId, 1)
                    if (freshCawonce == null) return

                    // Mirror to tokenDataStore so any UI reading from it
                    // sees the new high watermark.
                    useTokenDataStore.getState().setCawonce(senderId, freshCawonce + 1)

                    // Find the session key for the token owner
                    const user = await apiFetch(`/api/users/by-token/${senderId}`)
                    const ownerAddress = user?.address?.toLowerCase()
                    if (!ownerAddress) return

                    const sessionStore = useSessionKeyStore.getState()
                    const session = sessionStore.getSessionForAddress(ownerAddress)
                    if (!session || !sessionStore.enabled || session.expiry < Date.now() / 1000) {
                      console.log(`[TxQueueMonitor] No active session key for auto-retry`)
                      return
                    }

                    // Re-use the original message but swap in the fresh cawonce.
                    // Do NOT go through buildTypedData — the original amounts already
                    // include the validator tip, and buildTypedData would add a second one.
                    const message = { ...originalData, cawonce: freshCawonce }
                    const domain = DOMAIN
                    const types = TYPES
                    const primaryType = 'ActionData' as const

                    // Sign with session key
                    const sessionAccount = privateKeyToAccount(session.privateKey)
                    const signature = await sessionAccount.signTypedData({
                      domain,
                      types: { ActionData: TYPES.ActionData },
                      primaryType,
                      message,
                    })

                    // Submit new action
                    const retryResult = await apiFetch<{ txQueueId?: number }>('/api/actions', {
                      method: 'POST',
                      body: JSON.stringify({ data: message, domain, types, signature, retriedTxQueueId: status.id }),
                    })

                    // Update the pending post to track the new txQueue ID
                    if (retryResult?.txQueueId) {
                      const store = usePendingPostsStore.getState()
                      const pending = store.pendingPosts.find(p => p.txQueueId === status.id)
                      if (pending) {
                        store.updatePostWithTxQueueId(pending.tempId, retryResult.txQueueId)
                      }
                    }

                    console.log(`[TxQueueMonitor] Auto-retried TxQueue ${status.id} with cawonce ${freshCawonce}`)
                    cawonceRetries.delete(status.id)
                    saveRetries(cawonceRetries)
                    retrySucceeded = true

                    // Hide the ACTION_FAILED notification the server created
                    // for this original TxQueue row — from the user's
                    // perspective the action didn't really fail. Best-effort:
                    // any error here is non-fatal (worst case the user sees
                    // a stale notification with a working manual Retry).
                    try {
                      await apiFetch('/api/notifications/hide-by-original-tx', {
                        method: 'POST',
                        body: JSON.stringify({ userId: senderId, txQueueId: status.id }),
                      })
                    } catch (hideErr) {
                      console.warn(`[TxQueueMonitor] Failed to hide notification for retried tx ${status.id}:`, hideErr)
                    }
                  } catch (err) {
                    console.warn(`[TxQueueMonitor] Auto-retry failed for TxQueue ${status.id}:`, err)
                  } finally {
                    // Always clear the flag — on success the notification is
                    // already hidden server-side; on failure the original
                    // notification stays visible and the manual Retry button
                    // returns. `retrySucceeded` is informational only.
                    useAutoRetryStore.getState().endRetry(status.id)
                    void retrySucceeded
                  }
                })()
              }
            }
            // Previously a generic "Action Failed" modal was shown here for
            // terminal failures. That's been replaced by ACTION_FAILED
            // notifications created server-side by the validator — they're
            // durable (survive reloads), retryable (Session B), and don't
            // interrupt the user mid-action. The modal path is intentionally
            // removed; falling through to this point means the failure is
            // already recorded as a notification that the user will see
            // the next time they open the notifications panel.
          } else if (status.status === 'done') {
            console.log(`[TxQueueMonitor] TxQueue ID ${status.id} succeeded`)
            const wasPendingPost = usePendingPostsStore.getState().pendingPosts.some(p => p.txQueueId === status.id)
            if (wasPendingPost) {
              // Mark as confirmed — stops showing "Pending" badge, keeps the
              // post visible in the feed. Feed's cleanup effect will remove it
              // once the real version arrives from the API.
              usePendingPostsStore.getState().markPostAsConfirmed(status.id)
            }
            removeOptimisticLikeByTxQueueId(status.id)
            // Fire a balance-change toast for the outgoing spend BEFORE
            // removing it from pendingSpendStore — once removed the amount
            // is gone. Duration matches the spec (10s desktop, 5s mobile).
            const spendAmount = usePendingSpendStore.getState().pendingByTxQueue[status.id]
            if (spendAmount && spendAmount > 0n) {
              const isMobile = typeof window !== 'undefined'
                && window.matchMedia('(max-width: 767px)').matches
              useBalanceChangeStore.getState().addWindow(
                -spendAmount, // outgoing → negative
                isMobile ? 5_000 : 10_000,
                `txq:${status.id}`,
              )
            }
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)
            anyCompleted = true
            if (wasPendingPost) {
              needsFeedRefresh = true
            }
            // When any action completes, refresh visible feed items to pick up
            // updated state (hasLiked, hasRecawed, etc.) without resetting scroll
            if (!wasPendingPost && feedRefreshVisibleCallback) {
              feedRefreshVisibleCallback()
            }
          } else if (status.status === 'cancelled') {
            // Defense in depth. Cancel callsites already remove their
            // optimistic state synchronously; this catches any path that
            // forgets to, so the ProfileChooser budget can't stay stuck.
            removePendingPostByTxQueueId(status.id)
            removeOptimisticLikeByTxQueueId(status.id)
            usePendingSpendStore.getState().removePendingSpend(status.id)
            processedIds.current.add(status.id)
          }
        })

        // Refresh the feed only when new posts are confirmed (not for likes/recaws/etc.)
        if (needsFeedRefresh) {
          if (feedRefreshCallback) {
            console.log('[TxQueueMonitor] Triggering feed refresh (new post confirmed)')
            feedRefreshCallback()
          }
        }
        // Refresh token data when any action completes (staked balance changes)
        if (anyCompleted) {
          const refetch = useTokenDataStore.getState().refetchTokenData
          if (refetch) {
            refetch()
          }
        }
      } catch (error) {
        console.error('Error checking txQueue status:', error)
      }
    }

    // On mount, retry up to 3 failed "Cawonce already used" entries.
    // Fetches session key and min-cawonce ONCE, then re-signs each with
    // sequential cawonces. Capped to prevent retry storms.
    const retryFailedCawonceEntries = async () => {
      try {
        const state = useTokenDataStore.getState()
        const allTokens = Object.values(state.tokensByAddress).flat()
        let activeToken = state.activeTokenId != null
          ? allTokens.find(t => t.tokenId === state.activeTokenId)
          : undefined
        if (!activeToken && state.lastAddress) {
          const norm = state.lastAddress.toLowerCase()
          const forAddr = Object.entries(state.tokensByAddress)
            .find(([a]) => a.toLowerCase() === norm)?.[1] || []
          const activeId = Object.entries(state.activeTokenIdByAddress)
            .find(([a]) => a.toLowerCase() === norm)?.[1]
          activeToken = forAddr.find(t => t.tokenId === activeId) || forAddr[0]
        }
        if (!activeToken) activeToken = allTokens[0]
        if (!activeToken?.tokenId) return

        const senderId = activeToken.tokenId
        const res = await apiFetch(`/api/txqueue/failed-cawonce/${senderId}`)
        if (!res?.entries?.length) return

        // Cap at 3 retries per page load to prevent storms
        const MAX_MOUNT_RETRIES = 3
        const entries = res.entries.slice(0, MAX_MOUNT_RETRIES)
        console.log(`[TxQueueMonitor] Found ${res.entries.length} retryable cawonce failures, retrying ${entries.length}`)

        // Fetch session key and cawonce ONCE for all retries
        const user = await apiFetch(`/api/users/by-token/${senderId}`)
        const ownerAddress = user?.address?.toLowerCase()
        if (!ownerAddress) return

        const sessionStore = useSessionKeyStore.getState()
        const session = sessionStore.getSessionForAddress(ownerAddress)
        if (!session || !sessionStore.enabled || session.expiry < Date.now() / 1000) {
          console.log(`[TxQueueMonitor] No active session key for mount-retry`)
          return
        }

        // Allocate a contiguous block of cawonces for the whole batch
        // via the shared allocator (same path as the original
        // submission). This both protects against the parallel-retry
        // race AND ensures another tab signing during this loop won't
        // collide with our reservations.
        const candidates = entries.filter((e: any) => !processedIds.current.has(e.id) && e.payload?.data)
        if (candidates.length === 0) return
        const allocated = await allocateCawonces(senderId, candidates.length)
        if (allocated.length === 0) return

        const sessionAccount = privateKeyToAccount(session.privateKey)
        let allocIdx = 0

        for (const entry of entries) {
          if (processedIds.current.has(entry.id)) continue
          const originalData = entry.payload?.data
          if (!originalData) continue

          const freshCawonce = allocated[allocIdx++]
          if (freshCawonce == null) break
          useTokenDataStore.getState().setCawonce(senderId, freshCawonce + 1)
          useAutoRetryStore.getState().startRetry(entry.id)

          try {
            const message = { ...originalData, cawonce: freshCawonce }
            const signature = await sessionAccount.signTypedData({
              domain: DOMAIN,
              types: { ActionData: TYPES.ActionData },
              primaryType: 'ActionData' as const,
              message,
            })

            await apiFetch('/api/actions', {
              method: 'POST',
              body: JSON.stringify({ data: message, domain: DOMAIN, types: TYPES, signature, retriedTxQueueId: entry.id }),
            })

            console.log(`[TxQueueMonitor] Mount-retried TxQueue ${entry.id} with cawonce ${freshCawonce}`)
            processedIds.current.add(entry.id)

            try {
              await apiFetch('/api/notifications/hide-by-original-tx', {
                method: 'POST',
                body: JSON.stringify({ userId: senderId, txQueueId: entry.id }),
              })
            } catch (_) {}
          } catch (err) {
            console.warn(`[TxQueueMonitor] Mount-retry failed for TxQueue ${entry.id}:`, err)
            break // Stop retrying if one fails — likely a systemic issue
          } finally {
            useAutoRetryStore.getState().endRetry(entry.id)
          }
        }
      } catch (err) {
        console.warn('[TxQueueMonitor] Failed to check for retryable cawonce failures:', err)
      }
    }

    retryFailedCawonceEntries()

    // Check immediately on mount
    checkTxQueueStatus()

    // Then poll every 2 seconds. Interval is stable — store reads happen
    // inside getAllTxQueueIds(), so changes to pending posts/likes/spend
    // don't restart the interval (and don't trigger a burst of immediate fetches).
    // Pause polling when the tab is hidden to reduce server load at scale.
    let interval: ReturnType<typeof setInterval> | null = setInterval(checkTxQueueStatus, 2000)

    const onVisibilityChange = () => {
      if (document.hidden) {
        if (interval) { clearInterval(interval); interval = null }
      } else {
        if (!interval) {
          checkTxQueueStatus()
          interval = setInterval(checkTxQueueStatus, 2000)
        }
      }
    }
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      if (interval) clearInterval(interval)
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}