import React, { useRef, useEffect, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { TAG_CHAR_CLASS, HASHTAG_SIGIL_CLASS, MENTION_SIGIL_CLASS } from '~/../../../tools/hashtagRegex'

interface HighlightedTextareaProps {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  // Fired when an IME composition session begins. Used by PostForm to set
  // its own isComposingRef so it can reliably skip onChange events during
  // genuine CJK composition without trusting e.nativeEvent.isComposing,
  // which Android WebView (Rabby, etc.) mis-reports for plain Latin typing.
  onCompositionStart?: (e: React.CompositionEvent<HTMLTextAreaElement>) => void
  // Fired when an IME composition (CJK candidate selection) commits. The
  // textarea's normal onChange events are skipped by the parent while a
  // composition is open (#322); this is how the parent learns the final
  // composed text. Optional — non-IME callers can ignore it.
  onCompositionEnd?: (e: React.CompositionEvent<HTMLTextAreaElement>) => void
  // Fired on every intermediate IME candidate update DURING composition
  // (i.e. between compositionstart and compositionend). Optional — used by
  // PostForm to keep the visible highlight overlay in sync with in-progress
  // CJK composition on iOS WebKit, where compositionend is unreliable (see
  // handler comment in PostForm for the zinsanjp iOS report this fixes).
  onCompositionUpdate?: (e: React.CompositionEvent<HTMLTextAreaElement>) => void
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
  /**
   * Character offsets in `value` where the post will be split into chunks
   * for a thread. Each non-zero entry renders as a 1px horizontal hairline
   * in the highlight overlay so the user can see where the on-chain post
   * boundary lands while typing. Boundaries[0] is conventionally 0 and is
   * ignored (no break before the first chunk). Empty / undefined = no breaks.
   */
  chunkBoundaries?: number[]
  /** Zebra-stripe chunk backgrounds, reusing the same boundaries as the hairlines. */
  showZebra?: boolean
  /** Opacity of the zebra fill (0-1). Kept low so glyphs stay readable. */
  zebraOpacity?: number
  /** Draw an (n/N) badge at each chunk boundary. */
  showChunkBadge?: boolean
  /**
   * Parent-owned ref that we write the raw DOM `input` value+caret into during
   * an IME composition. React suppresses its synthetic onChange mid-composition
   * on Firefox, so the parent's onChange never sees the composed text; the
   * native input event does fire, and this ref is how the parent reads it at
   * compositionend. Stable ref → no listener churn.
   */
  composedValueRef?: React.MutableRefObject<{ value: string; caret: number } | null>
}

/**
 * Textarea with syntax highlighting for @mentions and #hashtags
 * Uses a mirror div technique: styled div behind transparent textarea
 */
// Firefox (real Gecko) is the ONLY engine that aborts an IME composition when
// React re-applies the controlled `value` mid-composition — there we drop the
// textarea to uncontrolled for the duration of a composition. WebKit/Blink
// keep the controlled value applied, but ONLY as long as the parent commits
// every mid-composition onChange to state (see PostForm.handleTextChange):
// if the parent skips those events instead, React's controlled-state restore
// resets textarea.value back to the frozen prop after EVERY composition
// keystroke on Blink — wiping the 変換中 text and killing the IME session,
// which made Japanese input impossible on Chrome/Edge (measured on the live
// bundle, 2026-07-30). Going uncontrolled was long believed to break the IME
// on WebKit and Blink; measured on an iPhone 2026-08-26, it does not on iOS.
// Exported because PostForm gates its composition-freeze with the same tests.
// Firefox-for-iOS ("FxiOS") is WebKit, not Gecko, and correctly does NOT match.
export const IS_GECKO =
  typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)

export const IS_IOS =
  typeof navigator !== 'undefined' && /iP(hone|ad|od)/.test(navigator.userAgent)

const HighlightedTextarea: React.FC<HighlightedTextareaProps> = ({
  value,
  onChange,
  onCompositionStart,
  onCompositionEnd,
  onCompositionUpdate,
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
  autoResize = false,
  chunkBoundaries,
  showZebra = false,
  zebraOpacity = 0.20,
  showChunkBadge = false,
  composedValueRef
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
  // True between compositionstart and compositionend (a live CJK/IME
  // conversion). While true we reveal the textarea's OWN glyphs (color
  // toggle below) and hide the highlight overlay, so the browser's native
  // in-progress composition — the underlined 変換中 text and the candidate
  // window — is directly visible. Without this the real glyphs are
  // color:transparent and the only visible text is the overlay, which is
  // driven by React `value`; during composition `value` is frozen (#322)
  // so the composing text appears in NEITHER layer → invisible. Toggling
  // visibility (NOT React state) fixes every IME engine without
  // re-rendering the controlled textarea mid-composition, which itself
  // ABORTS composition on Firefox (verified: setState here split か into
  // "k"+"あ"). So we drive visibility with a ref + direct DOM style writes in
  // the composition handlers — zero React re-render during a composition.
  const composingRef = useRef(false)
  // Also mirrored in React state — used ONLY to drop the controlled `value`
  // prop (→ undefined) during composition so React stops writing value onto the
  // node. Measured root cause: React re-applies value="" at compositionstart,
  // which aborts the IME on Firefox and splits か into "k"+"あ". Going
  // uncontrolled for the composition hands text ownership to the native IME;
  // compositionend re-controls with the committed value.
  const [isComposing, setIsComposing] = useState(false)
  // Bumped on window resize so the autoResize effect re-runs and remeasures
  // the mirror against the new viewport width. Without this, soft-wrap
  // changes on viewport-rotate / browser-resize / virtual-keyboard-show
  // leave the textarea at its old height.
  const [resizeTick, setResizeTick] = useState(0)
  // While uncontrolled during composition (IS_GECKO/IS_IOS below) the `value`
  // prop is frozen at its pre-composition text, so the autoResize effect and
  // the measurement mirror would size the box for the OLD content and the
  // composing lines fall outside the visible box. Read the live DOM value
  // instead; compositionupdate bumps resizeTick so this re-evaluates.
  const measuredValue = isComposing && (IS_GECKO || IS_IOS)
    ? (internalRef.current?.value ?? value)
    : value
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

  // Floor for autoResize: `rows` full text lines + vertical padding. The
  // grow effect can silently bail (offsetParent === null while the composer
  // is behind a position:fixed/transform ancestor — the mobile reply case,
  // #221), leaving the box stuck at its 1-row natural height with
  // overflow:hidden clipping the text. This CSS min-height holds even when
  // the JS never runs, so the box is always at least `rows` lines readable.
  // box-border (no border here) → padding is included in the height.
  const minBoxHeight = `calc(${lineHeight} * ${rows} + ${paddingTop} + ${paddingBottom})`

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
  }, [autoResize, measuredValue, compact, lineHeight, fontSize, resizeTick])

  // Apply mention/hashtag/URL highlighting to a single text slice. Used both
  // for the whole `value` (no chunk boundaries) and for each between-boundary
  // segment when threading is active.
  const highlightSlice = (text: string, keyPrefix: string): React.ReactNode => {
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
            <span key={`${keyPrefix}-${index}`} className={isDark ? 'text-yellow-400' : 'text-amber-800'}>
              {part}
            </span>
          )
        }
        return <React.Fragment key={`${keyPrefix}-${index}`}>{part}</React.Fragment>
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

  // Render the highlighted text with optional zero-height marker spans at
  // each chunk boundary. The markers don't disturb the text flow (so the
  // highlight overlay stays pixel-aligned with the transparent textarea
  // underneath); we read their offsetTop in an effect below and render
  // absolute-positioned hairlines on top. Boundaries are character offsets
  // into `value`; the leading 0 (if present) is ignored — we only mark
  // breaks BETWEEN chunks, not before the first one.
  const getHighlightedText = (text: string): React.ReactNode => {
    if (!text) return null

    const breaks = (chunkBoundaries ?? [])
      .filter(b => b > 0 && b < text.length)
      .sort((a, b) => a - b)
      .filter((b, i, arr) => i === 0 || b !== arr[i - 1])

    if (breaks.length === 0) return highlightSlice(text, 'h')

    const segments: React.ReactNode[] = []
    let prev = 0
    for (let i = 0; i < breaks.length; i++) {
      const at = breaks[i]
      segments.push(
        <React.Fragment key={`seg-${i}`}>{highlightSlice(text.slice(prev, at), `s${i}`)}</React.Fragment>
      )
      // Zero-width inline marker. We use `inline` (not block) so the
      // line flow is unaffected; the line itself is drawn by an absolute
      // overlay positioned from this span's offsetTop.
      segments.push(
        <span
          key={`brk-${i}`}
          data-chunk-break={i}
          aria-hidden="true"
          style={{ display: 'inline-block', width: 0, height: 0 }}
        />
      )
      prev = at
    }
    segments.push(
      <React.Fragment key={`seg-${breaks.length}`}>{highlightSlice(text.slice(prev), `s${breaks.length}`)}</React.Fragment>
    )
    return segments
  }

  // Position the hairlines by measuring the marker spans' offsetTop. Runs
  // after every render that changes value or boundaries, plus on resize.
  const [breakTops, setBreakTops] = useState<{ top: number; left: number }[]>([])
  useEffect(() => {
    const el = highlightRef.current
    if (!el) { setBreakTops([]); return }
    const breaks = (chunkBoundaries ?? []).filter(b => b > 0 && b < value.length)
    if (breaks.length === 0) { setBreakTops([]); return }
    // Measure on the next animation frame so layout has settled.
    let rafId = requestAnimationFrame(() => {
      const markers = el.querySelectorAll<HTMLElement>('[data-chunk-break]')
      const tops: { top: number; left: number }[] = []
      markers.forEach(m => {
        // offsetTop/offsetLeft are relative to the nearest positioned
        // ancestor — the highlight layer itself, which matches what we
        // need. offsetLeft is the EXACT horizontal position of the split
        // point within its line, so the hairline can start there instead
        // of spanning the whole line (which made it a rough guide only).
        tops.push({ top: m.offsetTop, left: m.offsetLeft })
      })
      setBreakTops(tops)
    })
    return () => cancelAnimationFrame(rafId)
  }, [value, chunkBoundaries, overlayHeight, fontSize, compact])

  // Reveal the textarea's own glyphs + hide the highlight overlay DURING an IME
  // composition, done with direct DOM writes (NOT setState) so nothing
  // re-renders the controlled textarea mid-composition — a re-render there
  // aborts composition on Firefox. The declarative styles stay static
  // (transparent / opacity:1); React won't overwrite our imperative values on
  // an unrelated re-render because it only writes style props that changed.
  // Bump resizeTick on every composition keystroke. While uncontrolled the
  // `value` prop never changes, so nothing else would re-render and the
  // autoResize effect (which now reads measuredValue) would never re-run.
  const handleCompositionUpdateInternal = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    if (autoResize) setResizeTick(t => t + 1)
    onCompositionUpdate?.(e)
  }
  const handleCompositionStartInternal = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = true
    setIsComposing(true)
    const ta = internalRef.current
    if (ta) {
      const c = isDark ? 'white' : 'black'
      ta.style.color = c
      ta.style.webkitTextFillColor = c
    }
    if (highlightRef.current) highlightRef.current.style.opacity = '0'
    onCompositionStart?.(e)
  }
  const handleCompositionEndInternal = (e: React.CompositionEvent<HTMLTextAreaElement>) => {
    composingRef.current = false
    setIsComposing(false)
    const ta = internalRef.current
    if (ta) {
      ta.style.color = 'transparent'
      ta.style.webkitTextFillColor = 'transparent'
    }
    if (highlightRef.current) highlightRef.current.style.opacity = '1'
    onCompositionEnd?.(e)
  }

  // React suppresses its synthetic onChange during IME composition on Firefox,
  // so the composed text never reaches the parent's onChange handler. The raw
  // DOM `input` event DOES fire mid-composition with the correct running value.
  // Capture it into the parent's ref so compositionend can commit the real
  // value instead of the browser's stale ta.value. Gated by composingRef (a
  // ref, so the listener needn't be re-bound on every composition).
  useEffect(() => {
    const el = internalRef.current
    if (!el || !composedValueRef) return
    const onNativeInput = () => {
      if (composingRef.current) {
        composedValueRef.current = { value: el.value, caret: el.selectionStart ?? el.value.length }
      }
    }
    el.addEventListener('input', onNativeInput)
    return () => el.removeEventListener('input', onNativeInput)
  }, [composedValueRef])

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
          // Static base; toggled to 0 during composition via direct DOM write
          // (see handleCompositionStartInternal) so the visible textarea glyphs
          // aren't doubled by the overlay's stale render of `value`.
          opacity: 1,
        }}
        aria-hidden="true"
      >
        {getHighlightedText(value)}
        {/* Chunk-boundary hairlines. Absolutely positioned within the
            highlight layer so they don't push any text and the overlay
            stays pixel-aligned with the transparent textarea below.
            offsetTop is measured from each marker span above; we shift
            up by a hair so the line lands on the line's baseline gap
            instead of slicing through ascenders. */}
        {/* Zebra chunk backgrounds. Same measured boundary tops as the
            hairlines => fills line up with split points. Absolutely
            positioned in the highlight layer => rides existing opacity:0
            during IME composition (no extra flicker).

            Indexed by CHUNK, not boundary: N boundaries split the text into
            N+1 chunks, where chunk c spans [top(c-1), top(c)] with 0 before
            the first boundary and the box bottom after the last. Shade every
            other chunk (odd-indexed) for a true alternating stripe — the
            single rule covers the trailing chunk too, so no special case. */}
        {showZebra && breakTops.length > 0 &&
          Array.from({ length: breakTops.length + 1 }, (_, c) => {
            if (c % 2 === 0) return null
            const chunkTop = c === 0 ? 0 : breakTops[c - 1].top
            const isLastChunk = c === breakTops.length
            return (
              <span
                key={`zebra-${c}`}
                aria-hidden="true"
                className="absolute left-0 right-0"
                style={{
                  top: `${chunkTop}px`,
                  // Last chunk runs to the box bottom (no boundary below it);
                  // interior chunks stop at their next boundary.
                  ...(isLastChunk
                    ? { bottom: 0 }
                    : { height: `${breakTops[c].top - chunkTop}px` }),
                  background: isDark
                    ? `rgba(90,160,120,${zebraOpacity})`
                    : `rgba(60,130,90,${zebraOpacity})`,
                  pointerEvents: 'none',
                }}
              />
            )
          })}
        {breakTops.map((b, i) => (
          <span
            key={`brkline-${i}`}
            aria-hidden="true"
            className="absolute right-2"
            style={{
              left: `${b.left}px`,
              top: `${b.top + 6}px`,
              borderTop: '1px dashed #f0b1005e',
              height: 0,
            }}
          />
       ))}
        {showChunkBadge && breakTops.map((b, i) => (
          <span
            key={`brkbadge-${i}`}
            aria-hidden="true"
            className="absolute right-1 text-[10px] leading-none px-1 py-0.5 rounded"
            style={{
              top: `${b.top - 4}px`,
              color: '#f0b100',
              border: '1px solid #f0b1008a',
              background: isDark ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.6)',
            }}
          >
            {`${i + 1}/${breakTops.length + 1}`}
          </span>
        ))}
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
          minHeight: autoResize ? minBoxHeight : undefined,
          // Static transparent base (overlay is the visible text); toggled to a
          // real color during composition via direct DOM write so the native
          // IME 変換中 text shows, without a re-render that aborts Firefox.
          color: 'transparent',
          caretColor: isDark ? 'white' : 'black',
          WebkitTextFillColor: 'transparent',
        }}
        rows={rows}
        placeholder={placeholder}
        // Uncontrolled during composition on Firefox (IS_GECKO) and iOS WebKit
        // (IS_IOS): there React's mid-composition value write aborts the IME.
        // Both measured on device. On Blink we keep it controlled.
        value={isComposing && (IS_GECKO || IS_IOS) ? undefined : value}
        onChange={onChange}
        onCompositionStart={handleCompositionStartInternal}
        onCompositionEnd={handleCompositionEndInternal}
        onCompositionUpdate={handleCompositionUpdateInternal}
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
      {!value && !isComposing && placeholder && (
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
            // Same floor as the textarea so the measured height (and the
            // overlay snapped to it) never reports below the visible box.
            minHeight: minBoxHeight,
            wordBreak: 'break-word',
            overflowWrap: 'break-word',
          }}
        >
          {/* Trailing space + zero-width joiner so a value ending in
              \n still counts the trailing empty line in offsetHeight. */}
          {measuredValue || '.'}
          {measuredValue.endsWith('\n') ? '​' : ''}
        </div>
      )}
    </div>
  )
}

export default HighlightedTextarea
