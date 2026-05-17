import React, { useRef, useEffect, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { TAG_CHAR_CLASS, HASHTAG_SIGIL_CLASS, MENTION_SIGIL_CLASS } from '~/../../../tools/hashtagRegex'

interface HighlightedTextareaProps {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onClick?: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  onKeyUp?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onBeforeInput?: (e: React.FormEvent<HTMLTextAreaElement>) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  placeholder?: string
  rows?: number
  className?: string
  // Accepts either a RefObject (useRef) or a callback ref (e.g. the
  // chunkRefs.current[i] = el pattern used by the threaded composer).
  textareaRef?: React.Ref<HTMLTextAreaElement>
  fontSize?: 'base' | 'xl'
  /** Tighter vertical padding for compact composers (e.g. replies). */
  compact?: boolean
  /**
   * Even tighter top + bottom padding — used by per-chunk textareas in the
   * threaded composer where adjacent textareas are separated by a divider
   * line and the default 10px bottom padding would stack into ~20px of
   * white space around the divider.
   */
  denser?: boolean
  /** When true, grows textarea height to fit content (no internal scroll). */
  autoResize?: boolean
}

/**
 * Textarea with syntax highlighting for @mentions and #hashtags
 * Uses a mirror div technique: styled div behind transparent textarea
 */
const HighlightedTextarea: React.FC<HighlightedTextareaProps> = ({
  value,
  onChange,
  onClick,
  onKeyUp,
  onKeyDown,
  onBeforeInput,
  onDragOver,
  onDragLeave,
  onDrop,
  placeholder,
  rows = 3,
  className = '',
  textareaRef: externalRef,
  fontSize = 'xl',
  compact = false,
  denser = false,
  autoResize = false
}) => {
  const { isDark } = useTheme()
  // Each instance keeps its OWN ref to its OWN textarea — required so
  // autoResize finds the right element when the same external ref is
  // shared across mobile + desktop instances of this component (the
  // mounted-but-display:none one would steal the ref otherwise and
  // scrollHeight would be 0). The external ref is forwarded via a
  // callback ref attached to the textarea, so it points at whichever
  // instance is visible (or the last-rendered one when both are
  // mounted — caller decides which path is the active path).
  const internalRef = useRef<HTMLTextAreaElement | null>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  // Hidden measurement mirror — same width/font/padding/wrap as the
  // textarea but with NO explicit height. Reading its offsetHeight
  // gives us the textarea's natural content height without the
  // height='0px' collapse trick. See the autoResize effect below.
  const mirrorRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  // Bumped on window resize so the autoResize effect re-runs and remeasures
  // the mirror against the new viewport width. Without this, soft-wrap
  // changes on viewport-rotate / browser-resize / virtual-keyboard-show
  // leave the textarea at its old height.
  const [resizeTick, setResizeTick] = useState(0)
  useEffect(() => {
    if (!autoResize) return
    const onResize = () => setResizeTick(t => t + 1)
    window.addEventListener('resize', onResize)
    // visualViewport fires on iOS keyboard show/hide and orientation change
    // when `resize` doesn't (Safari's quirk).
    const vv = (window as unknown as { visualViewport?: VisualViewport }).visualViewport
    vv?.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      vv?.removeEventListener('resize', onResize)
    }
  }, [autoResize])

  // Mobile uses an explicit 16px to avoid iOS Safari's focus-zoom on
  // inputs below 16px. Root font-size is 15px (index.css), so plain
  // `text-base` resolves to 15px and trips the zoom. Desktop keeps 15px.
  const textSizeClass = fontSize === 'xl' ? 'text-xl' : 'text-[16px] md:text-base'
  const lineHeight = fontSize === 'xl' ? '1.75rem' : '1.5rem'
  // denser (per-chunk in thread mode): no vertical padding at all — adjacent
  // chunks sit right against the divider line, no stacked whitespace.
  // compact (replies, media-attached): 10px bottom.
  // default: 26px bottom for the give-it-room single-post layout.
  const paddingTop = denser ? '0px' : '2px'
  const paddingBottom = denser ? '0px' : compact ? '10px' : '26px'
  const padding = `${paddingTop} 8px ${paddingBottom} 8px`

  // Sync scroll between textarea and highlight div
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }

  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop
    }
  }, [scrollTop])

  // Mirrors the textarea's rendered height so the absolute-positioned
  // highlight overlay can follow it on autoResize without relying on the
  // parent's auto-height to catch up. Tracked in state so the inline style
  // re-applies on every resize the same render the textarea grows.
  const [overlayHeight, setOverlayHeight] = useState<number | null>(null)

  // Auto-grow to fit content (handles soft-wrapped long lines too).
  // Deferred to rAF so the browser finishes any pending reflow (e.g.
  // flex parent re-layout on a keystroke) before we read scrollHeight.
  // A same-frame measure-and-set was reportedly causing the mobile reply
  // textarea to shrink after ~2 lines (#221) because the height='0px'
  // collapse + scrollHeight read happened before the flex row had
  // re-measured, yielding a stale (smaller) scrollHeight.
  useEffect(() => {
    if (!autoResize) return
    const el = internalRef.current
    if (!el) return
    // scrollHeight is 0 on a display:none element, which would yield
    // height: 2px and visibly squash the textarea. Skip resize when the
    // element isn't laid out — the visible instance will recalc on its
    // own when typing happens.
    if (el.offsetParent === null) return

    const rafId = requestAnimationFrame(() => {
      // Re-check inside rAF: the element may have unmounted or gone
      // offscreen between the effect run and the next frame.
      if (!el.isConnected || el.offsetParent === null) return
      // Read the natural content height from the hidden measurement
      // mirror (mirrorRef below). The mirror has no explicit height
      // and the same font/padding/width/word-wrap as the textarea,
      // so its offsetHeight is the textarea's natural unconstrained
      // height. Using this instead of the previous "height='0px' →
      // re-read scrollHeight" trick avoids the per-keystroke
      // document scroll that bug #211 surfaced: collapsing the
      // textarea to 0px briefly, even for one paint frame, caused
      // iOS Safari (and to a lesser degree Chrome) to scroll the
      // document by ~15px each keystroke as the browser re-anchored
      // the caret against a momentarily-empty layout.
      const mirror = mirrorRef.current
      if (!mirror) return
      const next = mirror.offsetHeight + 2 // tiny buffer to avoid 1px flicker
      // Apply the new height directly with no transient collapse.
      el.style.height = `${next}px`
      // Snap the highlight overlay to the same height. Without this, when the
      // textarea grew the overlay sometimes lagged a frame and lines 1-2
      // disappeared while line 3 was being typed (reported by Japanese users
      // in the reply composer, where soft-wrap fires earlier with CJK chars).
      setOverlayHeight(next)
    })
    return () => cancelAnimationFrame(rafId)
  }, [autoResize, value, compact, lineHeight, fontSize, resizeTick])

  // Parse text and apply highlighting for @mentions, #hashtags, $cashtags, and URLs
  const getHighlightedText = (text: string) => {
    if (!text) return null

    // Match @mentions, #hashtags, $cashtags, and URLs. Hashtags/cashtags must
    // contain at least one non-digit char; pure-numeric runs like `#5` or
    // `$100` stay plain text. Char class allows any Unicode letter/digit/mark
    // so e.g. `#テスト` and `#你好` highlight the same as `#foo`.
    try {
      const tagAlt = `${HASHTAG_SIGIL_CLASS}(?=${TAG_CHAR_CLASS}*[\\p{L}\\p{M}_])${TAG_CHAR_CLASS}+`
      const mentionAlt = `${MENTION_SIGIL_CLASS}${TAG_CHAR_CLASS}+`
      const urlAlt = `https?:\\/\\/[^\\s<>"'{}|\\\\^\`\\[\\]]+[^\\s<>"'{}|\\\\^\`\\[\\].,!?;:)\\]]`
      const regex = new RegExp(`(${mentionAlt}|${tagAlt}|${urlAlt})`, 'gu')
      const parts = text.split(regex)
      const isMentionOrTag = new RegExp(`^(${mentionAlt}|${tagAlt})$`, 'u')
      const isUrl = /^https?:\/\//

      return parts.map((part, index) => {
        if (isMentionOrTag.test(part) || isUrl.test(part)) {
          return (
            <span key={index} className={isDark ? 'text-yellow-400' : 'text-amber-800'}>
              {part}
            </span>
          )
        }
        return part
      })
    } catch (err) {
      // Defensive: a malformed regex run shouldn't take down the
      // post form. Bug #82 reported a "screen goes black + error
      // occurred" symptom — most likely an unrelated cause, but
      // falling back to plain text here means the highlighter can
      // never be the trigger for an unrecoverable React crash.
      console.warn('[HighlightedTextarea] highlight parse failed, falling back to plain text:', err)
      return text
    }
  }

  return (
    <div className="relative w-full">
      {/* Highlight layer - renders behind textarea */}
      <div
        ref={highlightRef}
        className={`absolute left-0 right-0 top-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words ${textSizeClass} ${
          isDark ? 'text-white' : 'text-black'
        }`}
        style={{
          padding,
          lineHeight,
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
          // Anchor the overlay to the textarea's exact rendered height
          // when autoResize is on. inset-0 used to defer to the parent's
          // height, which lagged a layout pass on Safari iOS — lines 1-2
          // visually disappeared while line 3 was being typed.
          ...(autoResize && overlayHeight != null ? { height: overlayHeight } : { bottom: 0 }),
        }}
        aria-hidden="true"
      >
        {getHighlightedText(value)}
        {/* Add invisible character to maintain height when empty */}
        {!value && <span className="invisible">.</span>}
      </div>

      {/* Actual textarea - transparent text, handles input */}
      <textarea
        ref={(node) => {
          internalRef.current = node
          // External ref is shared across mobile + desktop instances of
          // this component (PostForm passes the same useRef). Only the
          // visible instance (offsetParent !== null) should claim the
          // shared ref so focus / cursor / selection ops land on the
          // textarea the user is actually looking at. RefObject.current
          // is readonly in the type; the mutable assignment is fine at
          // runtime — useRef returns a mutable object.
          if (externalRef) {
            if (typeof externalRef === 'function') {
              // Callback ref: pass node directly. Mount fires with the node,
              // unmount with null. No visible-instance gating — the threaded
              // composer expects every chunk's ref to fire so the array stays
              // dense.
              externalRef(node)
            } else {
              // RefObject case (useRef): the same external ref may be shared
              // across mobile + desktop instances of this component, so only
              // the visible instance (offsetParent !== null) should claim the
              // shared ref so focus / cursor / selection ops land on the
              // textarea the user is actually looking at. RefObject.current
              // is readonly in the type; the mutable assignment is fine at
              // runtime — useRef returns a mutable object.
              const r = externalRef as { current: HTMLTextAreaElement | null }
              if (node && node.offsetParent !== null) {
                r.current = node
              } else if (!node && r.current === internalRef.current) {
                r.current = null
              }
            }
          }
        }}
        // placeholder-transparent suppresses the native ::placeholder
        // text — the overlay div below renders our own placeholder.
        // Without this, browsers paint a default-styled placeholder on
        // top of the overlay so the two strings overlap (especially
        // visible with an image attached + empty text, when the form
        // doesn't auto-expand to hide the overlap).
        className={`w-full resize-none border-none outline-none bg-transparent placeholder-transparent ${textSizeClass} ${className}`}
        style={{
          boxShadow: 'none',
          padding,
          lineHeight,
          overflow: autoResize ? 'hidden' : undefined,
          color: 'transparent',
          caretColor: isDark ? 'white' : 'black',
          WebkitTextFillColor: 'transparent',
        }}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onClick={onClick}
        onKeyUp={onKeyUp}
        onKeyDown={onKeyDown}
        onBeforeInput={onBeforeInput}
        onScroll={handleScroll}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      />

      {/* Placeholder overlay when empty */}
      {!value && placeholder && (
        <div
          className={`absolute pointer-events-none ${textSizeClass} ${
            isDark ? 'text-gray-500' : 'text-gray-600'
          }`}
          style={{
            top: '2px',
            left: '8px',
            lineHeight,
          }}
        >
          {placeholder}
        </div>
      )}

      {/* Hidden measurement mirror — autoResize only. Same width and
          inline-styling as the textarea so its layout-driven height
          mirrors the textarea's natural unconstrained height. Anchored
          absolutely (so it doesn't push other content) and visually
          hidden via visibility:hidden (still laid out — `display:none`
          would zero its offsetHeight). aria-hidden + pointer-events-none
          keep it out of every interaction path. */}
      {autoResize && (
        <div
          ref={mirrorRef}
          aria-hidden="true"
          className={`absolute left-0 right-0 top-0 pointer-events-none whitespace-pre-wrap break-words ${textSizeClass}`}
          style={{
            visibility: 'hidden',
            padding,
            lineHeight,
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
          }}
        >
          {/* Trailing space + zero-width joiner so a value ending in
              \n still counts the trailing empty line in offsetHeight. */}
          {value || '.'}
          {value.endsWith('\n') ? '​' : ''}
        </div>
      )}
    </div>
  )
}

export default HighlightedTextarea
