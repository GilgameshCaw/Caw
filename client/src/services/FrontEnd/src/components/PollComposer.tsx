import React from 'react'
import { HiOutlineX, HiPlus } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import {
  POLL_MIN_OPTIONS,
  POLL_MAX_OPTIONS,
  POLL_MAX_OPTION_BYTES,
} from '~/../../../tools/pollMarker'

// byteLen mirrors the on-chain byte counter — we use it here so the per-
// option budget the composer enforces matches what the post char counter
// reserves. Inlined to avoid a wider util import; the math is small.
const byteLen = (s: string) => new TextEncoder().encode(s).length

interface Props {
  options: string[]
  onChange: (options: string[]) => void
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
  onClose,
  position,
  onChangePosition,
  showPositionPicker,
}) => {
  const { isDark } = useTheme()

  const setOption = (i: number, v: string) => {
    const next = options.slice()
    next[i] = v
    onChange(next)
  }
  const addOption = () => {
    if (options.length >= POLL_MAX_OPTIONS) return
    onChange([...options, ''])
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
  }

  // Surface the most-actionable validation issue. Multiple errors at once
  // would be noisy; the user sees the first one, fixes it, then the next.
  const errors = options
    .map((o, i) => {
      const trimmed = o.trim()
      if (trimmed === '') return null // empty is fine while typing
      if (trimmed.includes(':')) return `Option ${i + 1}: can't contain ":"`
      if (trimmed.includes('\n')) return `Option ${i + 1}: can't contain newlines`
      if (byteLen(trimmed) > POLL_MAX_OPTION_BYTES) {
        return `Option ${i + 1}: ${byteLen(trimmed)} / ${POLL_MAX_OPTION_BYTES} bytes`
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
          const overByte = byteLen(opt) > POLL_MAX_OPTION_BYTES
          const remaining = POLL_MAX_OPTION_BYTES - byteLen(opt)
          return (
            <div key={i} className="flex items-center gap-2">
              <input
                type="text"
                value={opt}
                onChange={e => setOption(i, e.target.value)}
                placeholder={`Option ${i + 1}`}
                maxLength={POLL_MAX_OPTION_BYTES * 2 /* generous: real check is byteLen */}
                className={`flex-1 px-3 py-2 rounded-lg text-sm outline-none border ${
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
        <div className={`mt-2 text-xs ${isDark ? 'text-red-400' : 'text-red-600'}`}>
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
