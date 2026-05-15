import { useEffect, useRef } from 'react'
import { useActiveToken } from '~/store/tokenDataStore'
import { useAuthStore } from '~/store/authStore'
import { useBalanceChangeStore } from '~/store/balanceChangeStore'
import { apiFetch } from '~/api/client'

/**
 * Watches for incoming CAW value (likes, recaws, follows, tips landing on
 * the user's caws) and fires balance-change toast windows.
 *
 * Strategy: keep a high-water-mark notification id locally. Every 30s
 * (paused when the tab is hidden) ask the server for notifications with
 * id > lastSeenId. For each one that carries CAW value, compute the
 * delta and push a window onto useBalanceChangeStore.
 *
 * The "since cursor" is in-memory only. On a fresh session we seed it to
 * the newest notification id on the first poll *without* firing toasts
 * for those, so the user doesn't get bombarded with their entire history
 * on first load. After that, any newer id fires a window.
 *
 * Source dedup in balanceChangeStore protects against the same
 * notification id surviving a refresh and re-arriving — but with the
 * in-memory cursor that shouldn't happen in normal operation.
 */

// Per-action receive amounts (CAW, before *10^18). Mirrors the on-chain
// constants in CawActions.sol. Keep in sync with cawActionCosts.ts if/when
// that file gets shared.
const RECEIVE_BY_TYPE: Record<string, bigint> = {
  LIKE:   1600n,
  REPOST: 2000n,
  QUOTE:  2000n,
  FOLLOW: 24000n,
  // TIP amount comes from notification.actionPayload.tipAmount (whole CAW string)
}

const POLL_INTERVAL_MS = 30_000

interface NotificationLite {
  id: number
  type: string
  actionPayload?: { tipAmount?: string } | null
  createdAt: string
}

export function useIncomingBalanceWatcher() {
  const activeToken = useActiveToken()
  const tokenId = activeToken?.tokenId
  const isAuthorized = useAuthStore(s => tokenId ? s.isTokenAuthorized(tokenId) : false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const lastSeenIdRef = useRef<number | null>(null)
  const seededRef = useRef(false)
  const cancelledRef = useRef(false)

  useEffect(() => {
    if (!tokenId || !isAuthorized) return

    cancelledRef.current = false
    // Reset cursor when the token changes — different user, different history.
    lastSeenIdRef.current = null
    seededRef.current = false

    const poll = async () => {
      if (cancelledRef.current) return
      try {
        const data = await apiFetch<{ notifications: NotificationLite[] }>(
          `/api/notifications?userId=${tokenId}&limit=20`
        )
        if (cancelledRef.current) return
        const notifications = data?.notifications || []

        // First poll: seed the cursor without firing toasts. Anything past
        // this point that arrives is "new during this session" and gets
        // toasted.
        if (!seededRef.current) {
          lastSeenIdRef.current = notifications[0]?.id ?? 0
          seededRef.current = true
          return
        }

        const cursor = lastSeenIdRef.current ?? 0
        // Notifications come back desc by createdAt — walk them, fire on
        // any with id > cursor, then advance cursor to the max id seen.
        let newMax = cursor
        const durationMs = 5_000

        for (const n of notifications) {
          if (n.id <= cursor) continue
          if (n.id > newMax) newMax = n.id

          let cawAmount: bigint | null = null
          if (n.type === 'TIP') {
            // tipAmount in actionPayload is whole-CAW string. Multiply to wei.
            const raw = n.actionPayload?.tipAmount
            if (raw) {
              try { cawAmount = BigInt(raw) * 10n ** 18n } catch { /* malformed */ }
            }
          } else {
            const whole = RECEIVE_BY_TYPE[n.type]
            if (whole !== undefined) cawAmount = whole * 10n ** 18n
          }

          if (cawAmount && cawAmount > 0n) {
            useBalanceChangeStore.getState().addWindow(
              cawAmount,
              durationMs,
              `notif:${n.id}`,
              { tokenId },
            )
          }
        }

        lastSeenIdRef.current = newMax
      } catch {
        // Silently fail — balance toasts are non-critical
      }
    }

    const start = () => {
      if (intervalRef.current) return
      intervalRef.current = setInterval(poll, POLL_INTERVAL_MS)
    }
    const stop = () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop()
      } else {
        poll()
        start()
      }
    }

    poll()
    start()
    document.addEventListener('visibilitychange', onVisibilityChange)

    return () => {
      cancelledRef.current = true
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
  }, [tokenId, isAuthorized])
}
