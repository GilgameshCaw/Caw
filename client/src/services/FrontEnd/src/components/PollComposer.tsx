import React, { useRef, useState } from 'react'
import { HiOutlineX, HiPlus, HiOutlinePhotograph } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { uploadMedia } from '~/api/upload'
import {
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_BYTES,
  POLL_MAX_OPTION_BYTES_WITH_IMAGES,
} from '~/../../../tools/pollMarker'

// byteLen mirrors the on-chain byte counter — we use it here so the per-
// option budget the composer enforces matches what the post char counter
// reserves. Inlined to avoid a wider util import; the math is small.
const byteLen = (s: string) => new TextEncoder().encode(s).length

interface Props {
  options: string[]
  onChange: (options: string[]) => void
  /** Optional per-option image URLs, positional. Always passed; empty
   * string in slot i = no image. Parent owns this state so the value
   * persists across re-renders + travels through to the submit path. */
  optionImages: string[]
  onChangeImages: (imgs: string[]) => void
  onClose: () => void
  /** When threading, where in the thread the poll should land. */
  position: 'start' | 'end'
  onChangePosition: (p: 'start' | 'end') => void
  /** Show the start/end picker (only relevant when the post will thread). */
  showPositionPicker: boolean
}

/**
 * Inline poll editor. Lives below the post textarea when the user has
 * opened "Add poll" — they edit option strings in a flat list, click
 * "+ option" to add up to POLL_MAX_OPTIONS, and the parent composes the
 * actual ::poll:opt1:opt2:...:: marker on submit (PostForm.tsx).
 *
 * Validation surfaces inline:
 *   - per-option byte counter, with red overflow above POLL_MAX_OPTION_BYTES
 *   - banner when option count is below the 2-option floor
 *   - banner when an option contains ":" or "\n" (the marker delimiters)
 *
 * The composer doesn't write into the post text directly — the parent
 * keeps the body in `text` state and the poll options separate, splicing
 * the marker into finalText only on submit. That keeps char-counter logic
 * simple (body + poll byte cost) and avoids the user accidentally typing
 * inside the marker.
 */
const PollComposer: React.FC<Props> = ({
  options,
  onChange,
  optionImages,
  onChangeImages,
  onClose,
  position,
  onChangePosition,
  showPositionPicker,
}) => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()

  // One file input per option row, refs by index. Avoids the "click the
  // tiny + button" → invisible file dialog dance with a single shared
  // input where we'd have to track which index is active.
  const fileInputs = useRef<Record<number, HTMLInputElement | null>>({})
  const [uploading, setUploading] = useState<Record<number, boolean>>({})
  // Tracks which row is currently being dragged over so we can highlight
  // it. Only one row at a time, so a single index (or null) is enough —
  // sub-event onDragLeave checks containment to avoid flicker.
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null)

  const setOption = (i: number, v: string) => {
    const next = options.slice()
    next[i] = v
    onChange(next)
  }
  const setImage = (i: number, url: string) => {
    // Maintain positional alignment with options[]: pad with empty strings
    // up to the option count so a future read can index by option without
    // bounds-checking a parallel array.
    const next = options.map((_, idx) => optionImages[idx] || '')
    next[i] = url
    onChangeImages(next)
  }
  const addOption = () => {
    if (options.length >= POLL_MAX_OPTIONS) return
    onChange([...options, ''])
    onChangeImages([...optionImages, ''])
  }
  const removeOption = (i: number) => {
    if (options.length <= 1) {
      // Clearing the last option closes the composer entirely — matches the
      // "X" button. Avoids leaving a poll with zero options dangling.
      onClose()
      return
    }
    const next = options.slice()
    next.splice(i, 1)
    onChange(next)
    const nextImgs = optionImages.slice()
    nextImgs.splice(i, 1)
    onChangeImages(nextImgs)
  }

  const handlePickFile = (i: number, file: File) => {
    if (!activeToken?.tokenId) return
    setUploading(u => ({ ...u, [i]: true }))
    // uploadMedia compresses with the chosen preset (pollOption = 128px
    // WebP at 25KB target) and POSTs to /api/upload, which returns a
    // /uploads/images/... URL. The same-origin URL is what the server's
    // poll route expects.
    uploadMedia([file], activeToken.tokenId, 'pollOption')
      .then(urls => {
        if (urls[0]) setImage(i, urls[0])
      })
      .catch(err => {
        console.warn('[PollComposer] image upload failed:', err)
      })
      .finally(() => {
        setUploading(u => ({ ...u, [i]: false }))
      })
  }

  // Per-option byte cap shrinks when any option has an image — the
  // ::pi:hash:hash:: sidecar eats budget and we still want body text to
  // fit inside 420. See pollMarker.ts for the worst-case math.
  const anyImage = optionImages.some(s => s)
  const optionByteCap = anyImage ? POLL_MAX_OPTION_BYTES_WITH_IMAGES : POLL_MAX_OPTION_BYTES

  // Surface the most-actionable validation issue. Multiple errors at once
  // would be noisy; the user sees the first one, fixes it, then the next.
  const errors = options
    .map((o, i) => {
      const trimmed = o.trim()
      if (trimmed === '') return null // empty is fine while typing
      if (trimmed.includes(':')) return `Option ${i + 1}: can't contain ":"`
      if (trimmed.includes('\n')) return `Option ${i + 1}: can't contain newlines`
      if (byteLen(trimmed) > optionByteCap) {
        return `Option ${i + 1}: ${byteLen(trimmed)} / ${optionByteCap} bytes${anyImage ? ' (lower because of poll images)' : ''}`
      }
      return null
    })
    .filter(Boolean) as string[]
  const filled = options.filter(o => o.trim().length > 0).length
  const tooFew = filled < POLL_MIN_OPTIONS

  return (
    <div className={`mt-3 p-3 rounded-xl border ${
      isDark ? 'border-white/10 bg-white/[0.02]' : 'border-gray-200 bg-gray-50'
    }`}>
      <div className="flex items-center justify-between mb-2">
        <div className={`text-xs font-medium ${isDark ? 'text-white/70' : 'text-gray-700'}`}>
          Poll
        </div>
        <button
          onClick={onClose}
          className={`p-1 rounded-full transition-colors ${
            isDark ? 'text-white/40 hover:text-white/70 hover:bg-white/10' : 'text-gray-400 hover:text-gray-700 hover:bg-gray-200'
          }`}
          aria-label="Remove poll"
        >
          <HiOutlineX className="w-4 h-4" />
        </button>
      </div>

      <div className="space-y-2">
        {options.map((opt, i) => {
          const overByte = byteLen(opt) > optionByteCap
          const remaining = optionByteCap - byteLen(opt)
          const imgUrl = optionImages[i] || ''
          const isUploading = !!uploading[i]
          const isDragging = dragOverIdx === i
          return (
            <div
              key={i}
              className={`flex items-center gap-2 rounded-lg transition-colors ${
                isDragging
                  ? (isDark ? 'ring-2 ring-yellow-400/60 bg-yellow-400/5' : 'ring-2 ring-yellow-500 bg-yellow-50')
                  : ''
              }`}
              // Whole-row drop zone — gives users a generous target so they
              // don't have to land on the tiny image picker square. Same
              // pattern as MediaUpload's main drop area.
              onDragEnter={e => { e.preventDefault(); setDragOverIdx(i) }}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy' }}
              onDragLeave={e => {
                // Only clear when actually leaving the row, not when crossing
                // into a child element (relatedTarget tells us where we went).
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragOverIdx(null)
              }}
              onDrop={e => {
                e.preventDefault()
                setDragOverIdx(null)
                const file = e.dataTransfer.files?.[0]
                if (file && file.type.startsWith('image/')) handlePickFile(i, file)
              }}
            >
              {/* Image picker / preview. 50x50 square so it's a comfortable
                  drop target and matches the input row height. */}
              <div className="relative shrink-0">
                <input
                  ref={el => { fileInputs.current[i] = el }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) handlePickFile(i, file)
                    // Reset so picking the same file twice still triggers onChange.
                    e.target.value = ''
                  }}
                />
                {imgUrl ? (
                  <div className="relative" style={{ width: 50, height: 50 }}>
                    <img
                      src={imgUrl}
                      alt=""
                      className="rounded-lg border border-yellow-500/40"
                      style={{ width: 50, height: 50, objectFit: 'cover' }}
                    />
                    <button
                      type="button"
                      onClick={() => setImage(i, '')}
                      className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-black/80 text-white flex items-center justify-center hover:bg-black"
                      aria-label="Remove image"
                    >
                      <HiOutlineX className="w-3 h-3" />
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputs.current[i]?.click()}
                    disabled={isUploading}
                    aria-label="Add image to option"
                    style={{ width: 50, height: 50 }}
                    className={`rounded-lg border flex items-center justify-center transition-colors ${
                      isUploading
                        ? (isDark ? 'border-white/10 text-white/30' : 'border-gray-200 text-gray-400')
                        : (isDark
                          ? 'border-white/10 text-white/40 hover:text-yellow-400 hover:border-yellow-500/40'
                          : 'border-gray-300 text-gray-400 hover:text-yellow-600 hover:border-yellow-500')
                    }`}
                  >
                    {isUploading ? (
                      <div className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <HiOutlinePhotograph className="w-5 h-5" />
                    )}
                  </button>
                )}
              </div>
              <input
                type="text"
                value={opt}
                onChange={e => setOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                maxLength={optionByteCap * 2 /* generous: real check is byteLen */}
                style={{ height: 50 }}
                className={`flex-1 px-3 rounded-lg text-base outline-none border ${
                  overByte
                    ? 'border-red-500'
                    : isDark
                      ? 'bg-white/5 border-white/10 focus:border-yellow-500/50 text-white'
                      : 'bg-white border-gray-200 focus:border-yellow-500 text-gray-900'
                }`}
              />
              <span className={`text-[10px] tabular-nums w-8 text-right ${
                overByte ? 'text-red-500' : isDark ? 'text-white/30' : 'text-gray-400'
              }`}>
                {remaining}
              </span>
              <button
                onClick={() => removeOption(i)}
                className={`p-1 rounded transition-colors ${
                  isDark ? 'text-white/30 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'
                }`}
                aria-label="Remove option"
              >
                <HiOutlineX className="w-4 h-4" />
              </button>
            </div>
          )
        })}
      </div>

      {options.length < POLL_MAX_OPTIONS && (
        <button
          onClick={addOption}
          className={`mt-2 inline-flex items-center gap-1 text-xs px-2 py-1 rounded-full transition-colors ${
            isDark ? 'text-yellow-400 hover:bg-yellow-500/10' : 'text-yellow-600 hover:bg-yellow-50'
          }`}
        >
          <HiPlus className="w-3.5 h-3.5" /> add option
        </button>
      )}

      {(errors.length > 0 || tooFew) && (
        // Real validation problems (overlong option, illegal char) stay red;
        // the "needs more options" hint is informational — render it muted
        // so it reads as a hint, not an error.
        <div className={`mt-2 text-xs ${
          errors.length > 0
            ? (isDark ? 'text-red-400' : 'text-red-600')
            : (isDark ? 'text-white/40' : 'text-gray-500')
        }`}>
          {errors[0] || `Need at least ${POLL_MIN_OPTIONS} options to post`}
        </div>
      )}

      {showPositionPicker && (
        <div className={`mt-3 pt-3 border-t flex items-center gap-3 text-xs ${
          isDark ? 'border-white/10 text-white/60' : 'border-gray-200 text-gray-600'
        }`}>
          <span>Place in:</span>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              checked={position === 'start'}
              onChange={() => onChangePosition('start')}
              className="accent-yellow-500"
            />
            first post
          </label>
          <label className="flex items-center gap-1 cursor-pointer">
            <input
              type="radio"
              checked={position === 'end'}
              onChange={() => onChangePosition('end')}
              className="accent-yellow-500"
            />
            last post
          </label>
        </div>
      )}
    </div>
  )
}

export default PollComposer
