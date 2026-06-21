/**
 * QuickSignCard — the "Quick Sign — one-click actions" element from
 * /usernames/new (Profile/New.tsx), extracted so the onboarding username step
 * reuses the EXACT same card rather than rebuilding (or omitting) it.
 *
 * Owns: the bordered card shell, the enable toggle (or an "already enabled"
 * checkmark when the owner address already has a session), the (i) popover
 * (QuickSignInfoPopover, also lifted here), and the QuickSignOptions picker
 * (spend limit / tip-per-action / expiry / wallet-protect).
 *
 * Fully controlled — the parent owns every piece of QS state and passes it +
 * setters in. The component adds no state of its own except the popover's
 * open/close (which is self-contained in QuickSignInfoPopover).
 *
 * The `giftGate` slot is rendered ABOVE the card and is only used by the
 * sponsored/onboarding flow (the invite-gift summary / "name too expensive for
 * your gift" / auto-deposit lines have no equivalent on /usernames/new). On the
 * plain /usernames/new flow it's simply omitted.
 */

import { useState, useRef, useEffect } from 'react'
import { HiCheckCircle, HiInformationCircle } from 'react-icons/hi'
import QuickSignHowItWorks from '~/components/QuickSignHowItWorks'
import QuickSignOptions from '~/components/QuickSignOptions'
import { useTheme } from '~/hooks/useTheme'

/**
 * Tap-aware popover for the (i) next to "Quick Sign — one-click actions".
 * Sits inside the wrapping <label>, so the click handler stops propagation to
 * avoid toggling the Quick Sign switch when the user taps the icon. Lifted
 * verbatim from New.tsx so both callsites share one implementation.
 */
const QuickSignInfoPopover: React.FC = () => {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null
      if (!target || !ref.current?.contains(target)) setOpen(false)
    }
    const onScroll = () => setOpen(false)
    // 12s is plenty of reading time without the popover lingering forever.
    const autoHide = setTimeout(() => setOpen(false), 12000)
    document.addEventListener('pointerdown', onPointerDown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      window.removeEventListener('scroll', onScroll, true)
      clearTimeout(autoHide)
    }
  }, [open])

  return (
    <div ref={ref} className="relative inline-flex">
      <button
        type="button"
        aria-label="How Quick Sign works"
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setOpen((v) => !v)
        }}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        className="flex items-center cursor-help"
      >
        <HiInformationCircle className="w-4 h-4 text-gray-400" />
      </button>
      {open && (
        // Mobile: right-anchor the popover (icon sits near the right edge, so
        // centering a 90vw box over it clips the right side). sm+: center over
        // the icon as before.
        <div
          className="absolute bottom-full right-0 mb-2 z-50 w-[min(450px,90vw)] bg-gray-900 rounded-lg shadow-lg sm:right-auto sm:left-1/2 sm:-translate-x-1/2"
          onClick={(e) => e.stopPropagation()}
        >
          <QuickSignHowItWorks isDark />
        </div>
      )}
    </div>
  )
}

export interface QuickSignCardProps {
  /** Whether the Quick Sign toggle is on. */
  enabled: boolean
  onEnabledChange: (next: boolean) => void
  /** Whether the QuickSignOptions picker is expanded below the toggle. */
  expanded: boolean
  onExpandedChange: (next: boolean) => void
  /**
   * True when the owner address ALREADY has a Quick Sign session (delegated
   * per-address). Renders a checkmark + "already enabled" copy instead of the
   * toggle — there's nothing to configure.
   */
  hasExistingSession?: boolean

  // QuickSignOptions state (all controlled by the parent)
  spendLimit: bigint
  onSpendLimitChange: (v: bigint) => void
  duration: number
  onDurationChange: (v: number) => void
  tipCeiling: bigint
  onTipCeilingChange: (v: bigint) => void
  walletProtect: boolean
  onWalletProtectChange: (v: boolean) => void

  /**
   * Sponsored/onboarding-only content rendered ABOVE the card (invite-gift
   * summary, gift-gate warnings, auto-deposit line). Omitted on /usernames/new.
   */
  giftGate?: React.ReactNode
}

export default function QuickSignCard({
  enabled,
  onEnabledChange,
  expanded,
  onExpandedChange,
  hasExistingSession = false,
  spendLimit,
  onSpendLimitChange,
  duration,
  onDurationChange,
  tipCeiling,
  onTipCeilingChange,
  walletProtect,
  onWalletProtectChange,
  giftGate,
}: QuickSignCardProps) {
  const { isDark } = useTheme()

  return (
    <>
      {giftGate}

      <div className={`border rounded-xl p-4 space-y-3 ${
        isDark ? 'border-white/10 bg-[#0D0D0D]/85' : 'border-gray-200 bg-gray-50'
      }`}>
        {/* Override space-y-3 gap below this label to 5px */}
        <label className={`flex items-center gap-3 [&+*]:!mt-[5px] ${hasExistingSession ? 'cursor-default' : 'cursor-pointer'}`}>
          {hasExistingSession ? (
            // Already enabled for this owner address — Quick Sign is delegated
            // per address and the new profile inherits the existing session, so
            // there's nothing to toggle. Show a checkmark instead of a switch.
            <HiCheckCircle className="w-6 h-6 text-yellow-500 flex-shrink-0" aria-label="Quick Sign already enabled" />
          ) : (
            <button
              type="button"
              onClick={() => { onEnabledChange(!enabled); onExpandedChange(true) }}
              className={`relative w-10 min-w-[40px] h-6 rounded-full transition-colors duration-200 cursor-pointer flex-shrink-0 ${
                enabled ? 'bg-yellow-500' : 'bg-gray-600'
              }`}
            >
              <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${
                enabled ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </button>
          )}
          <div className="flex-1">
            {/* Title row — plain span so a click bubbles to the wrapping <label>
                and toggles the switch. The (i) popover and the QuickSignOptions
                pencil both stopPropagation so they open without flipping QS off. */}
            <div className="flex items-center gap-1.5">
              <span className={`text-sm font-medium ${isDark ? 'text-white' : 'text-gray-900'}`}>Quick Sign — one-click actions</span>
              <QuickSignInfoPopover />
            </div>
            {hasExistingSession ? (
              <p className="text-yellow-500/80 text-xs mt-0.5">
                Already enabled — Quick Sign works across all profiles on this wallet.
              </p>
            ) : (
              <>
                <p className="text-yellow-500/80 text-xs mt-0.5">
                  Delegate funds to your device to skip wallet sigs
                </p>
                <p className="text-gray-500 text-xs mt-0.5">You can configure later in settings</p>
              </>
            )}
          </div>
        </label>
        {enabled && expanded && (
          // QuickSignOptions owns both states: a 3-column summary (spend limit /
          // tip per action / expiry) when collapsed, and the full editable
          // picker when its pencil is clicked.
          <QuickSignOptions
            spendLimit={spendLimit}
            onSpendLimitChange={onSpendLimitChange}
            duration={duration}
            onDurationChange={onDurationChange}
            tipCeiling={tipCeiling}
            onTipCeilingChange={onTipCeilingChange}
            walletProtect={walletProtect}
            onWalletProtectChange={onWalletProtectChange}
            themed
            isDark={isDark}
          />
        )}
      </div>
    </>
  )
}
