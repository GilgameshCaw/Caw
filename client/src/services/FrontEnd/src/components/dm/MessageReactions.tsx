import React, { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { HiOutlineEmojiHappy, HiOutlinePencil } from 'react-icons/hi'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import ModalWrapper from '~/components/modals/ModalWrapper'
import ModalHeader from '~/components/modals/ModalHeader'
import type { UiReaction } from '~/hooks/useDm'

/**
 * Server defaults for the quick-reaction strip. Five slots — sixth+seventh
 * are the `+` (full picker) and ✏️ (customize) buttons. User-customized
 * choices live on the DmIdentity row (defaultDmReactions) and override
 * these when set.
 */
export const DEFAULT_DM_REACTIONS = ['❤️', '😆', '😮', '😢', '🌙']

interface ReactionStripProps {
  // Resolved defaults — caller decides whether to pass server-side
  // customization or fall through to DEFAULT_DM_REACTIONS.
  emojis: string[]
  /** Existing reactions on the message — used to highlight ones the
   *  current user has already added. */
  reactions: UiReaction[]
  /** Active token id of the current user, for "is this mine?" checks. */
  currentUserId: number
  onReact: (emoji: string) => void
  /** Open the full picker (caller manages the modal). */
  onOpenPicker: () => void
  /** Open the customization modal. */
  onOpenCustomize: () => void
  /** Pass true on the bubble's "isFromCurrentUser" branch so we anchor
   *  the strip to the right edge instead of the left. */
  alignRight?: boolean

  /** Controlled open state (optional). */
  open?: boolean
  /** Controlled open setter (optional). */
  onOpenChange?: (open: boolean) => void

  /**
   * Anchor strategy for the portal strip positioning.
   * - 'bubble': anchor to the message bubble element (recommended)
   * - 'trigger': anchor to the smiley trigger element
   */
  anchor?: 'bubble' | 'trigger'
}

/**
 * Two-stage hover UX. At rest a small smiley trigger sits next to the
 * bubble; click it and the full strip slides out with the 5 quick
 * reactions, a + button (opens the full picker) and a pencil button
 * (opens the customize modal). Click outside the strip closes it.
 *
 * The smiley itself reveals on `group-hover` so the message bubble is
 * uncluttered until the user reaches for it.
 */
export const MessageReactionStrip: React.FC<ReactionStripProps> = ({
  emojis,
  reactions,
  currentUserId,
  onReact,
  onOpenPicker,
  onOpenCustomize,
  alignRight,
  open: controlledOpen,
  onOpenChange,
  anchor = 'bubble',
}) => {
  const { isDark } = useTheme()
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false)
  const open = controlledOpen ?? uncontrolledOpen
  const setOpen = (next: boolean | ((prev: boolean) => boolean)) => {
    const resolved = typeof next === 'function' ? (next as any)(open) : next
    if (controlledOpen !== undefined) {
      onOpenChange?.(resolved)
      return
    }
    setUncontrolledOpen(resolved)
    onOpenChange?.(resolved)
  }
  const wrapperRef = useRef<HTMLDivElement>(null)
  const stripRef = useRef<HTMLDivElement>(null)
  const [coords, setCoords] = useState({ top: 0, left: 0 })
  const myEmojis = new Set(reactions.filter(r => r.userId === currentUserId).map(r => r.emoji))

  // Close on click outside or Escape — same UX as the dot-menu.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node
      if (wrapperRef.current?.contains(target)) return
      if (stripRef.current?.contains(target)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Position the portal-rendered strip so it stays inside the viewport.
  // Anchor below the trigger; if there's not enough room below, flip to
  // above. Horizontal: prefer aligning to the trigger's leading edge
  // (right edge for our-side bubbles, left for theirs), then clamp to
  // viewport bounds with an 8px margin.
  const reposition = () => {
    const trigger = wrapperRef.current
    const strip = stripRef.current
    if (!trigger || !strip) return
    const anchorEl = anchor === 'bubble'
      ? (trigger.previousElementSibling as HTMLElement | null)
      : trigger

    const tRect = (anchorEl ?? trigger).getBoundingClientRect()
    const sRect = strip.getBoundingClientRect()
    const margin = 8

    // Vertical: below by default. Flip above if it would overflow.
    let top = tRect.bottom + margin
    if (top + sRect.height > window.innerHeight - margin) {
      const above = tRect.top - sRect.height - margin
      // Only flip if "above" itself fits — otherwise clamp to viewport.
      top = above >= margin ? above : Math.max(margin, window.innerHeight - sRect.height - margin)
    }

    // Horizontal: align by alignRight — own bubble = right edge of strip
    // sits at trigger right; their bubble = left edges align. Clamp to
    // viewport so the strip can't run off either side.
    let left = alignRight
      ? tRect.right - sRect.width
      : tRect.left
    left = Math.max(margin, Math.min(left, window.innerWidth - sRect.width - margin))

    setCoords({ top, left })
  }

  useLayoutEffect(() => {
    if (open) reposition()
    // We deliberately don't put `alignRight` in deps — when the trigger
    // moves (resize, scroll), reposition runs anyway via the listeners
    // below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (!open) return
    const onScrollOrResize = () => reposition()
    // Capture-phase scroll listener so nested scrolling containers
    // (the messages list itself, primarily) trigger repositioning.
    window.addEventListener('scroll', onScrollOrResize, true)
    window.addEventListener('resize', onScrollOrResize)
    return () => {
      window.removeEventListener('scroll', onScrollOrResize, true)
      window.removeEventListener('resize', onScrollOrResize)
    }
  }, [open])

  // Helper that closes the strip after performing an action — keeps the
  // hover-strip from sticking open after the user picks something.
  const performAndClose = (fn: () => void) => () => { fn(); setOpen(false) }

  return (
    <div ref={wrapperRef} className="relative self-center flex-shrink-0">
      {/* Trigger — small smiley that fades in on hover, like the dot-menu. */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`p-1.5 rounded-full transition-opacity cursor-pointer ${
          open
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto'
        } ${isDark ? 'hover:bg-white/10 text-white/40 hover:text-white/80' : 'hover:bg-gray-200 text-gray-400 hover:text-gray-700'}`}
        title="Add reaction"
      >
        <HiOutlineEmojiHappy className="w-5 h-5" />
      </button>

      {/* Portal-render so the strip can never be clipped by a parent
          with overflow:hidden (the messages list scroll container) and
          can self-clamp to the viewport on narrow screens. */}
      {open && createPortal(
        <div
          ref={stripRef}
          className={`fixed z-[9000] flex items-center gap-1 px-2 py-1.5 rounded-full ${
            isDark ? 'bg-black border border-white/15 shadow-lg' : 'bg-white border border-gray-200 shadow-lg'
          }`}
          style={{ top: coords.top, left: coords.left }}
        >
          {emojis.map(emoji => {
            const mine = myEmojis.has(emoji)
            return (
              <button
                key={emoji}
                type="button"
                onClick={performAndClose(() => onReact(emoji))}
                className={`text-3xl leading-none w-12 h-12 rounded-full flex items-center justify-center transition-transform hover:scale-125 cursor-pointer ${
                  mine ? (isDark ? 'bg-yellow-500/30' : 'bg-yellow-200/70') : ''
                }`}
                title={mine ? 'Remove reaction' : 'React'}
              >
                {emoji}
              </button>
            )
          })}

          {/* Divider between the 5 defaults and the meta buttons */}
          <span className={`w-px self-stretch mx-1 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} aria-hidden />

          <button
            type="button"
            onClick={performAndClose(onOpenPicker)}
            className={`w-11 h-11 rounded-full flex items-center justify-center text-2xl transition-colors cursor-pointer ${
              isDark ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
            }`}
            title="More reactions"
          >
            +
          </button>
          <button
            type="button"
            onClick={performAndClose(onOpenCustomize)}
            className={`w-11 h-11 rounded-full flex items-center justify-center transition-colors cursor-pointer ${
              isDark ? 'text-white/60 hover:bg-white/10 hover:text-white' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
            }`}
            title="Customize default reactions"
          >
            <HiOutlinePencil className="w-5 h-5" />
          </button>
        </div>,
        document.body
      )}
    </div>
  )
}

interface ReactionsBarProps {
  reactions: UiReaction[]
  currentUserId: number
  onToggle: (emoji: string) => void
  alignRight?: boolean
}

/**
 * Inline display below the message bubble. Reactions group by emoji with
 * a count; tapping a chip toggles your own reaction. Mine are highlighted
 * so the user can tell what they've already left at a glance.
 */
export const MessageReactionsBar: React.FC<ReactionsBarProps> = ({
  reactions,
  currentUserId,
  onToggle,
  alignRight,
}) => {
  const { isDark } = useTheme()
  const grouped = useMemo(() => {
    const m = new Map<string, { count: number; mine: boolean }>()
    for (const r of reactions) {
      const cur = m.get(r.emoji) || { count: 0, mine: false }
      cur.count++
      if (r.userId === currentUserId) cur.mine = true
      m.set(r.emoji, cur)
    }
    // Insertion order = first-seen — close enough to chronological for UI.
    return [...m.entries()]
  }, [reactions, currentUserId])

  if (grouped.length === 0) return null

  return (
    <div className={`flex flex-wrap gap-1 mt-1 px-2 ${alignRight ? 'justify-end' : 'justify-start'}`}>
      {grouped.map(([emoji, { count, mine }]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji)}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-full text-xs transition-colors cursor-pointer ${
            mine
              ? (isDark ? 'bg-yellow-500/25 text-yellow-200 border border-yellow-500/40' : 'bg-yellow-200 text-yellow-900 border border-yellow-300')
              : (isDark ? 'bg-white/5 text-white/80 border border-white/10 hover:bg-white/10' : 'bg-gray-100 text-gray-700 border border-gray-200 hover:bg-gray-200')
          }`}
        >
          <span className="text-sm leading-none">{emoji}</span>
          {/* DM is always 1:1 — hide the count when it's just one
              reaction, since "❤️ 1" is redundant. Show it the moment a
              second reaction lands so the user can tell the difference
              between "they reacted" and "we both reacted". */}
          {count > 1 && <span className="font-medium">{count}</span>}
        </button>
      ))}
    </div>
  )
}

interface EmojiPickerModalProps {
  open: boolean
  onClose: () => void
  onPick: (emoji: string) => void
}

// Lazy boundary for emoji-mart. The combined picker + data set is ~400KB
// minified — too heavy to ship in the entry bundle, especially since the
// picker is only opened from one spot in the DM flow. Both modules are
// fetched together on first picker open and cached for the rest of the
// session. Wrapped at the lowest level (the Picker render itself) so the
// outer modal chrome still renders synchronously and can show a backdrop
// while the chunk loads.
const LazyEmojiPicker = lazy(async () => {
  const [{ default: Picker }, { default: data }] = await Promise.all([
    import('@emoji-mart/react'),
    import('@emoji-mart/data'),
  ])
  return {
    default: (props: { isDark: boolean; onPick: (emoji: string) => void; onClose: () => void }) => (
      <Picker
        data={data}
        theme={props.isDark ? 'dark' : 'light'}
        onEmojiSelect={(e: any) => { props.onPick(e.native); props.onClose() }}
      />
    ),
  }
})

/**
 * Full emoji picker. Closed by clicking the backdrop or pressing Escape.
 */
export const EmojiPickerModal: React.FC<EmojiPickerModalProps> = ({ open, onClose, onPick }) => {
  const { isDark } = useTheme()
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-[9000] flex items-center justify-center bg-black/40"
      onMouseDown={onClose}
    >
      <div onMouseDown={e => e.stopPropagation()}>
        <Suspense fallback={<div className="w-80 h-96 rounded-lg bg-black/60 animate-pulse" />}>
          <LazyEmojiPicker isDark={isDark} onPick={onPick} onClose={onClose} />
        </Suspense>
      </div>
    </div>
  )
}

interface CustomizeReactionsModalProps {
  open: boolean
  onClose: () => void
  /** Caller's tokenId so we can persist via /api/dm/settings. */
  userId: number
  /** Currently-saved customization (or empty array → fall through to defaults). */
  current: string[]
  /** Called after a successful save with the new list (5 emojis). */
  onSaved: (next: string[]) => void
}

/**
 * Modal that lets the user replace any of their 5 default reactions.
 * Click a slot → opens the picker → chosen emoji replaces that slot.
 * Save persists to /api/dm/settings; reset clears customization so the
 * server-side defaults take over on next read.
 *
 * Uses the shared ModalWrapper / ModalHeader so it matches the rest of
 * the site (yellow border, dark backdrop, X-button header, etc).
 */
export const CustomizeReactionsModal: React.FC<CustomizeReactionsModalProps> = ({
  open,
  onClose,
  userId,
  current,
  onSaved,
}) => {
  const { isDark } = useTheme()
  const initial = useMemo(
    () => (current.length === 5 ? current.slice(0, 5) : DEFAULT_DM_REACTIONS),
    [current],
  )
  const [draft, setDraft] = useState<string[]>(initial)
  const [pickerSlot, setPickerSlot] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Reset the draft whenever the modal re-opens — avoids leftover
  // "I started editing then closed" state from a previous open.
  useEffect(() => {
    if (open) {
      setDraft(initial)
      setError(null)
      setPickerSlot(null)
    }
  }, [open, initial])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    try {
      await apiFetch('/api/dm/settings', {
        method: 'PUT',
        body: JSON.stringify({ userId, defaultDmReactions: draft }),
      })
      onSaved(draft)
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Could not save')
    } finally {
      setSaving(false)
    }
  }

  const handleReset = async () => {
    setSaving(true)
    setError(null)
    try {
      await apiFetch('/api/dm/settings', {
        method: 'PUT',
        body: JSON.stringify({ userId, defaultDmReactions: [] }),
      })
      onSaved([])
      onClose()
    } catch (e: any) {
      setError(e?.message || 'Could not reset')
    } finally {
      setSaving(false)
    }
  }

  return (
    <ModalWrapper
      isOpen={open}
      onClose={onClose}
      maxWidth="max-w-sm"
      zIndex={80}
      backdropClass="bg-black/60"
      className="shadow-2xl"
    >
      <ModalHeader
        title="Customize reactions"
        onClose={onClose}
        icon={<HiOutlinePencil className="w-5 h-5 text-yellow-500" />}
      />

      <div className="px-4 pb-4 pt-3">
        <p className={`text-sm mb-4 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
          Tap a slot to swap it. These appear on every DM message.
        </p>

        <div className="flex justify-between gap-2 mb-4">
          {draft.map((emoji, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => setPickerSlot(idx)}
              className={`w-12 h-12 rounded-xl text-2xl flex items-center justify-center transition-all hover:scale-105 cursor-pointer ${
                isDark ? 'bg-white/10 hover:bg-white/15' : 'bg-gray-100 hover:bg-gray-200'
              } ${pickerSlot === idx ? 'ring-2 ring-yellow-500' : ''}`}
            >
              {emoji}
            </button>
          ))}
        </div>

        {error && (
          <div className={`text-sm mb-3 ${isDark ? 'text-red-400' : 'text-red-600'}`}>{error}</div>
        )}

        <div className="flex justify-between gap-2">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving}
            className={`px-3 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
              isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
            }`}
          >
            Reset to defaults
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className={`px-4 py-2 rounded-lg text-sm transition-colors cursor-pointer ${
                isDark ? 'text-white/80 hover:bg-white/10' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-lg text-sm font-semibold bg-yellow-500 hover:bg-yellow-400 text-black transition-colors cursor-pointer disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        </div>
      </div>

      {/* Slot-swap picker — separate from the message-level picker so
          opening it inside the customize modal doesn't conflict with
          react-with-any-emoji on a specific message. */}
      <EmojiPickerModal
        open={pickerSlot !== null}
        onClose={() => setPickerSlot(null)}
        onPick={(emoji) => {
          if (pickerSlot === null) return
          setDraft(prev => {
            const next = [...prev]
            next[pickerSlot] = emoji
            return next
          })
        }}
      />
    </ModalWrapper>
  )
}
