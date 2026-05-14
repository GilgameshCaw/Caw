import React, { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useBalanceChangeStore } from '~/store/balanceChangeStore'
import { formatUnitsCompact } from '~/utils'

/**
 * Floating CAW balance-change indicator.
 *
 * Mobile: pill that slides up from below the bottom nav (sits ~6px above
 *         --bottom-nav-h), centered, ~25×60.
 * Desktop: same pill, fixed top-right.
 *
 * Net of currently-live windows from useBalanceChangeStore. When all
 * windows expire, slides back down (mobile) / fades out (desktop).
 *
 * We re-render whenever:
 *   - a window is added (store mutation)
 *   - a window expires (driven by a setInterval that calls store.sweep())
 */
const SWEEP_INTERVAL_MS = 250

const BalanceChangeToast: React.FC = () => {
  const windows = useBalanceChangeStore(s => s.windows)
  const sweep = useBalanceChangeStore(s => s.sweep)
  // Track whether to render the portal at all. We keep the DOM mounted
  // during slide-down so the CSS transition can play, then unmount after.
  const [visible, setVisible] = useState(false)
  const [exiting, setExiting] = useState(false)

  // Tick to drop expired windows.
  useEffect(() => {
    const id = setInterval(() => { sweep() }, SWEEP_INTERVAL_MS)
    return () => clearInterval(id)
  }, [sweep])

  const net = windows.reduce((acc, w) => acc + w.delta, 0n)

  // Visibility state machine: any live windows + net ≠ 0 → visible.
  // When windows go empty, start the exit animation, then unmount.
  useEffect(() => {
    if (windows.length > 0 && net !== 0n) {
      setVisible(true)
      setExiting(false)
    } else if (visible) {
      setExiting(true)
      const t = setTimeout(() => {
        setVisible(false)
        setExiting(false)
      }, 350) // matches CSS transition below
      return () => clearTimeout(t)
    }
  }, [windows.length, net, visible])

  if (!visible) return null

  const isPositive = net > 0n
  const abs = isPositive ? net : -net
  const sign = isPositive ? '+' : '−'
  const colorClass = isPositive ? 'text-green-400' : 'text-red-400'

  // Mobile + desktop share the same pill. Position diverges:
  //   - desktop (md+): fixed top-right, slide-from-right
  //   - mobile: fixed bottom, slide-from-below-nav
  const mobileTransform = exiting
    ? 'translateY(calc(100% + var(--bottom-nav-h, 0px) + 12px))'
    : 'translateY(0)'
  const desktopTransform = exiting ? 'translateX(120%)' : 'translateX(0)'

  return createPortal(
    <>
      {/* Mobile pill */}
      <div
        className="md:hidden fixed left-1/2 -translate-x-1/2 z-[95] pointer-events-none"
        style={{
          bottom: `calc(var(--bottom-nav-h, 0px) + 6px)`,
          transform: `translateX(-50%) ${mobileTransform}`,
          transition: 'transform 350ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <div
          className={`bg-black rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.5)] px-3 py-1 text-xs font-medium whitespace-nowrap ${colorClass}`}
          style={{ minWidth: 60, height: 25, lineHeight: '17px', textAlign: 'center' }}
        >
          {sign}{formatUnitsCompact(abs, 18)} CAW
        </div>
      </div>

      {/* Desktop pill */}
      <div
        className="hidden md:block fixed top-4 right-4 z-[95] pointer-events-none"
        style={{
          transform: desktopTransform,
          transition: 'transform 350ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        <div
          className={`bg-black rounded-full shadow-[0_4px_16px_rgba(0,0,0,0.5)] px-3 py-1 text-xs font-medium whitespace-nowrap ${colorClass}`}
          style={{ minWidth: 60, height: 25, lineHeight: '17px', textAlign: 'center' }}
        >
          {sign}{formatUnitsCompact(abs, 18)} CAW
        </div>
      </div>
    </>,
    document.body
  )
}

export default BalanceChangeToast
