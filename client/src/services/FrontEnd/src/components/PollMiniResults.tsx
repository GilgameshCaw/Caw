import React from 'react'
import { useTheme } from '~/hooks/useTheme'
import type { CawItem } from '~/types'
import { useT } from '~/i18n/I18nProvider'

interface Props {
  poll: NonNullable<CawItem['poll']>
  /** Width of the widget (default 200px). The bar fills end at this width. */
  width?: number
  /** Height of each option row (default 20px). */
  rowHeight?: number
}

/**
 * Read-only, click-disabled poll snapshot. Used in places that
 * REFERENCE another caw — reply previews, quote embeds, modals showing
 * the parent post — so the viewer sees results without having a way to
 * vote (voting belongs to the canonical PollDisplay on the post itself).
 *
 * Visual: 200×20 per row by default. Each row is a horizontal bar with
 * the option text overlaid and a right-aligned percentage. Whichever
 * option is winning gets the slightly more-saturated fill; user's pick
 * (when known) gets the yellow accent — matching PollDisplay's results
 * state but tighter and non-interactive.
 *
 * No images, no thumbnails: this is the compact "at-a-glance" version.
 * The full PollDisplay still renders on the post the poll lives on.
 */
const PollMiniResults: React.FC<Props> = ({ poll, width = 200, rowHeight = 20 }) => {
  const t = useT()
  const { isDark } = useTheme()
  const counts = poll.optionVoteCounts || []
  const sum = counts.reduce((a, b) => a + b, 0)
  const winningIdx = sum > 0
    ? counts.reduce((best, c, i) => (c > counts[best] ? i : best), 0)
    : -1
  const userPickIdx = poll.userVote?.optionIndex ?? -1

  return (
    <div
      className="space-y-1 select-none"
      style={{ width, maxWidth: '100%' }}
      // Eat clicks so this never accidentally navigates / opens parent links
      // when nested inside an outer Link or onClick-bearing wrapper.
      onClick={e => e.stopPropagation()}
    >
      {poll.options.map((opt, i) => {
        const count = counts[i] || 0
        const pct = sum > 0 ? (count / sum) * 100 : 0
        const isUserPick = userPickIdx === i
        const isWinning = winningIdx === i && sum > 0
        return (
          <div
            key={i}
            className="relative rounded overflow-hidden"
            style={{ height: rowHeight }}
          >
            {/* Background fill */}
            <div
              className={`absolute inset-y-0 left-0 transition-[width] duration-300 ${
                isUserPick
                  ? (isDark ? 'bg-yellow-500/30' : 'bg-yellow-200')
                  : isWinning
                    ? (isDark ? 'bg-white/15' : 'bg-gray-300')
                    : (isDark ? 'bg-white/8' : 'bg-gray-200')
              }`}
              style={{ width: `${pct}%` }}
            />
            {/* Outline */}
            <div className={`absolute inset-0 rounded pointer-events-none ${
              isUserPick
                ? (isDark ? 'border border-yellow-500/40' : 'border border-yellow-500/60')
                : (isDark ? 'border border-white/10' : 'border border-gray-200')
            }`} />
            {/* Option text + percent */}
            <div className="relative h-full flex items-center justify-between gap-2 px-2">
              <span className={`flex-1 truncate text-[10px] leading-none ${
                isDark ? 'text-white/80' : 'text-gray-700'
              }`}>
                {opt}
              </span>
              <span className={`text-[10px] tabular-nums leading-none ${
                isDark ? 'text-white/60' : 'text-gray-500'
              }`}>
                {Math.round(pct)}%
              </span>
            </div>
          </div>
        )
      })}
      {/* Total — small footer beneath the rows */}
      <div className={`text-[10px] leading-none ${
        isDark ? 'text-white/30' : 'text-gray-400'
      }`}>
        {t('poll.vote_count', { count: poll.totalVotes })}
      </div>
    </div>
  )
}

export default PollMiniResults
