import React, { useMemo, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignAndSubmitAction } from '~/api/actions'
import { buildVoteText } from '~/../../../tools/pollMarker'
import type { CawItem } from '~/types'

interface Props {
  caw: CawItem
}

/**
 * Renders a poll inline inside a FeedItem. Two visual states:
 *   - "vote": clickable rows when the viewer hasn't voted yet
 *   - "results": progress bars + percentages with the user's pick highlighted
 *
 * Voting submits an OTHER action (vote:N), addressed by recipients=[poll
 * author tokenId] and receiverCawonce=poll's cawonce. The local pending
 * vote (written by the API submit path) lights up the bar immediately;
 * the indexer flips pending→false later.
 *
 * Unvote uses the same flow with optionIndex=null (text "vote:"). The
 * "Remove vote" button only appears when the viewer already has a
 * confirmed vote — pending unvotes can't unvote a pending vote (would
 * race with the optimistic write).
 */
const PollDisplay: React.FC<Props> = ({ caw }) => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const { openConnectModal } = useConnectModal()
  const signAndSubmit = useSignAndSubmitAction()

  const [submitting, setSubmitting] = useState(false)
  // Hover state to give a tiny preview of what it'd look like AFTER voting,
  // even before the user clicks. Subtle but makes the widget feel alive.
  const [hovered, setHovered] = useState<number | null>(null)

  const poll = caw.poll
  const userVote = poll?.userVote
  const showResults = !!userVote // Twitter-style: voting reveals the breakdown

  const totals = useMemo(() => {
    if (!poll) return null
    const counts = poll.optionVoteCounts || []
    const sum = counts.reduce((a, b) => a + b, 0)
    return { counts, sum: sum || 0 }
  }, [poll])

  if (!poll || !totals) return null

  const submitVote = async (optionIndex: number | null) => {
    if (submitting) return
    if (!activeToken?.tokenId) {
      openConnectModal?.()
      return
    }
    setSubmitting(true)
    try {
      await signAndSubmit({
        actionType: 'other',
        senderId: activeToken.tokenId,
        receiverId: caw.user.tokenId,
        receiverCawonce: caw.cawonce,
        recipients: [caw.user.tokenId],
        amounts: [],
        text: buildVoteText(optionIndex),
      })
    } catch (err) {
      // Optimistic write was rolled back by the API/cleanup if it failed
      // before reaching the validator. We don't show an inline error here:
      // the existing ACTION_FAILED notification flow surfaces the failure
      // with a one-click retry, which is more in keeping with the rest of
      // the app's error UX.
      console.warn('[PollDisplay] vote submit failed:', err)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 mb-1 space-y-1.5">
      {poll.options.map((opt, i) => {
        const count = totals.counts[i] || 0
        const pct = totals.sum > 0 ? Math.round((count / totals.sum) * 100) : 0
        const isUserPick = userVote?.optionIndex === i
        const isHover = hovered === i

        if (showResults) {
          return (
            <button
              key={i}
              onClick={() => submitVote(i)}
              disabled={submitting || isUserPick}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              className={`relative w-full text-left px-3 py-2 rounded-lg overflow-hidden transition-colors ${
                isUserPick
                  ? (isDark ? 'cursor-default' : 'cursor-default')
                  : (submitting ? 'cursor-wait opacity-60' : 'cursor-pointer hover:opacity-95')
              }`}
              style={{
                background: 'transparent',
              }}
            >
              {/* Filled bar — base color depends on whether it's the user's pick */}
              <div
                className={`absolute inset-y-0 left-0 transition-all duration-300 ${
                  isUserPick
                    ? (isDark ? 'bg-yellow-500/30' : 'bg-yellow-200')
                    : (isDark ? 'bg-white/10' : 'bg-gray-200')
                }`}
                style={{ width: `${pct}%` }}
              />
              {/* Outline */}
              <div className={`absolute inset-0 rounded-lg pointer-events-none border ${
                isUserPick
                  ? (isDark ? 'border-yellow-500/60' : 'border-yellow-500')
                  : (isDark ? 'border-white/10' : 'border-gray-200')
              }`} />
              <div className="relative flex items-center justify-between gap-2">
                <span className={`flex-1 truncate text-sm ${
                  isUserPick
                    ? (isDark ? 'text-white font-medium' : 'text-gray-900 font-medium')
                    : (isDark ? 'text-white/80' : 'text-gray-800')
                }`}>
                  {opt}
                  {isUserPick && userVote?.pending && (
                    <span className={`ml-2 text-[10px] uppercase tracking-wide ${
                      isDark ? 'text-yellow-400/70' : 'text-yellow-600/80'
                    }`}>
                      pending
                    </span>
                  )}
                </span>
                <span className={`text-sm tabular-nums ${
                  isDark ? 'text-white/60' : 'text-gray-600'
                }`}>
                  {pct}%
                </span>
              </div>
            </button>
          )
        }

        // Vote-not-yet-cast state. Each option is a fresh button.
        return (
          <button
            key={i}
            onClick={() => submitVote(i)}
            disabled={submitting}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            className={`w-full text-left px-3 py-2 rounded-lg border text-sm transition-colors ${
              submitting
                ? 'cursor-wait opacity-60'
                : (isHover
                  ? (isDark ? 'border-yellow-500 bg-yellow-500/10 text-white' : 'border-yellow-500 bg-yellow-50 text-gray-900')
                  : (isDark ? 'border-white/10 hover:border-yellow-500/50 text-white/80' : 'border-gray-200 hover:border-yellow-500/50 text-gray-800'))
            }`}
          >
            {opt}
          </button>
        )
      })}

      <div className={`flex items-center justify-between text-xs mt-2 ${
        isDark ? 'text-white/40' : 'text-gray-500'
      }`}>
        <span>{poll.totalVotes} vote{poll.totalVotes === 1 ? '' : 's'}</span>
        {showResults && !userVote?.pending && (
          <button
            onClick={() => submitVote(null)}
            disabled={submitting}
            className={`hover:underline ${submitting ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
          >
            Remove vote
          </button>
        )}
      </div>
    </div>
  )
}

export default PollDisplay
