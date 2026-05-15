import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignAndSubmitAction } from '~/api/actions'
import { buildVoteText } from '~/../../../tools/pollMarker'
import type { CawItem } from '~/types'
import { useT } from '~/i18n/I18nProvider'

interface Props {
  caw: CawItem
  optionLabelsOverride?: string[] | null
}

/**
 * The square that sits left of every option row. Three states:
 *   - imageUrl present + loads → renders the image
 *   - imageUrl present + 404s / errors → falls back to the numbered SVG
 *   - imageUrl absent → numbered SVG from the start
 *
 * We keep the slot rendered in all states so option rows align cleanly
 * even when only some options have images. The numbered SVG also
 * doubles as a visual cue for keyboard navigation / screen readers
 * (number === option position).
 */
function PollOptionThumb({
  imageUrl,
  number,
  isDark,
  size = 50,
}: {
  imageUrl: string
  number: number
  isDark: boolean
  size?: number
}) {
  const [errored, setErrored] = useState(false)
  // Reset the error flag whenever the URL changes — important when the
  // indexer flips a mirror-origin poll's URL from empty to populated:
  // a previously-errored slot should re-attempt with the new URL.
  useEffect(() => { setErrored(false) }, [imageUrl])

  const showImage = imageUrl && !errored
  return (
    <div
      className="relative shrink-0 rounded-md overflow-hidden"
      style={{ width: size, height: size }}
    >
      {showImage && (
        <img
          src={imageUrl}
          alt=""
          loading="lazy"
          onError={() => setErrored(true)}
          className="w-full h-full object-cover"
        />
      )}
      {!showImage && (
        // Numbered fallback. Centered numeral on a soft background that
        // matches the surrounding poll-row style. SVG (not text) so the
        // numeral never gets selected, copied, or wrap-broken when the
        // row is narrow.
        <svg
          viewBox="0 0 50 50"
          xmlns="http://www.w3.org/2000/svg"
          className={`w-full h-full ${
            isDark ? 'text-white/50' : 'text-gray-500'
          }`}
        >
          <rect
            x="0" y="0" width="50" height="50" rx="6"
            className={isDark ? 'fill-white/[0.06]' : 'fill-gray-100'}
          />
          <text
            x="25" y="25"
            textAnchor="middle"
            dominantBaseline="central"
            fontSize="22"
            fontWeight="600"
            fill="currentColor"
          >
            {number}
          </text>
        </svg>
      )}
    </div>
  )
}

interface LocalVote {
  optionIndex: number | null  // null = unvoted (after a confirmed vote was removed)
  pending: boolean
  // The vote count we're displaying for each option, kept in sync with the
  // server's snapshot but allowed to bump optimistically on click. Indexed
  // positionally; same length as poll.options.
  counts: number[]
  total: number
}

/**
 * Renders a poll inline inside a FeedItem.
 *
 * Voting flow (designed to feel instant):
 *   1. User clicks an option.
 *   2. Local state immediately bumps that option's count (and decrements
 *      the previous pick if they're changing) — switching the widget
 *      from "vote rows" to "results bars" in the same render. Bars
 *      transition to their new widths via CSS, so the fill animates.
 *   3. signAndSubmit kicks off the on-chain action; the API submit path
 *      already wrote the pending Vote row, so a refresh re-renders the
 *      same state we're showing locally.
 *   4. When the indexer eventually flips pending → false and the parent
 *      refetches, the prop's poll.optionVoteCounts arrives and we sync
 *      back to it (in case other voters joined since the click).
 *
 * Unvote (text "vote:") works the same way in reverse — local state
 * resets to the no-vote view immediately.
 */
const PollDisplay: React.FC<Props> = ({ caw, optionLabelsOverride }) => {
  const { isDark } = useTheme()
  const t = useT()
  const activeToken = useActiveToken()
  const { openConnectModal } = useConnectModal()
  const signAndSubmit = useSignAndSubmitAction()

  const [submitting, setSubmitting] = useState(false)
  const [hovered, setHovered] = useState<number | null>(null)

  const poll = caw.poll

  // Initialize local state from the server snapshot. Re-syncs whenever the
  // server snapshot changes (e.g. another user voted, or the indexer
  // confirmed our pending vote). The localVote.optionIndex `null` value is
  // distinct from the server-side absence of a vote: when the user just
  // clicked "Remove vote" we want to show the no-vote rows even though the
  // server still has a row until the action confirms.
  const buildInitialLocal = (): LocalVote => ({
    optionIndex: poll?.userVote?.optionIndex ?? null,
    pending: poll?.userVote?.pending ?? false,
    counts: poll?.optionVoteCounts ? poll.optionVoteCounts.slice() : (poll?.options || []).map(() => 0),
    total: poll?.totalVotes || 0,
  })
  const [local, setLocal] = useState<LocalVote>(buildInitialLocal)

  // Track whether the user has interacted locally this session — once they
  // have, we trust local state over the server snapshot until the next
  // confirmed sync (avoids the bars resetting if the parent re-renders
  // before the indexer round-trip completes).
  const userTouchedRef = useRef(false)

  // Re-sync from server when the snapshot looks "more authoritative" —
  // server total >= our local total (someone else's votes can only add)
  // AND either the server confirmed our pending vote or we haven't
  // touched it locally. Errs on the side of trusting the server when the
  // pending state matches.
  useEffect(() => {
    if (!poll) return
    const serverConfirmedOurVote = poll.userVote && !poll.userVote.pending
    const ourLocalIsPending = local.pending
    if (!userTouchedRef.current || (serverConfirmedOurVote && ourLocalIsPending)) {
      setLocal(buildInitialLocal())
    } else if ((poll.totalVotes ?? 0) > local.total) {
      // Other voters joined — refresh the counts but keep our optimistic pick.
      setLocal(prev => ({
        ...prev,
        counts: poll.optionVoteCounts ? poll.optionVoteCounts.slice() : prev.counts,
        total: poll.totalVotes ?? prev.total,
      }))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [poll?.userVote?.optionIndex, poll?.userVote?.pending, poll?.totalVotes, JSON.stringify(poll?.optionVoteCounts)])

  // Mount-once flag so bars get a "fill from 0" entry animation the first
  // time results render. Without this the bars would snap to width on
  // first paint with no transition (you can't transition from undefined).
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  const totals = useMemo(() => {
    if (!poll) return null
    const sum = local.total || 0
    return { counts: local.counts, sum }
  }, [poll, local])

  if (!poll || !totals) return null

  const showResults = local.optionIndex !== null  // viewer has voted (or just voted)

  const submitVote = async (optionIndex: number | null) => {
    if (submitting) return
    if (!activeToken?.tokenId) {
      openConnectModal?.()
      return
    }

    // Optimistic local update FIRST so the bars start animating before
    // the wallet pop-up. If the user rejects the sig we revert.
    const prev = local
    userTouchedRef.current = true
    setLocal(curr => {
      const counts = curr.counts.slice()
      let total = curr.total
      // Decrement previous pick (only if it was confirmed locally — a
      // pending pick wasn't reflected in `total` to begin with).
      if (curr.optionIndex !== null && !curr.pending) {
        counts[curr.optionIndex] = Math.max(0, counts[curr.optionIndex] - 1)
        total = Math.max(0, total - 1)
      }
      if (optionIndex === null) {
        // Unvote: just leave the decrement in place.
        return { optionIndex: null, pending: true, counts, total }
      }
      counts[optionIndex] = (counts[optionIndex] || 0) + 1
      total = total + 1
      return { optionIndex, pending: true, counts, total }
    })

    setSubmitting(true)
    try {
      await signAndSubmit({
        actionType: 'other',
        senderId: activeToken.tokenId,
        // The poll's caw is identified by (receiverId, receiverCawonce) —
        // the on-chain canonical pointers. NOT recipients[] — that's the
        // value-distribution list and must satisfy
        //   amounts.length == recipients.length        (no validator tip)
        // OR
        //   amounts.length == recipients.length + 1    (last amount = tip)
        // (CawActions.sol _distributeAmountsMem). Votes don't move CAW
        // between users, so recipients stays empty and buildTypedData
        // auto-appends the validator tip as the only amount.
        receiverId: caw.user.tokenId,
        receiverCawonce: caw.cawonce,
        recipients: [],
        amounts: [],
        text: buildVoteText(optionIndex),
      })
    } catch (err) {
      // Roll back the optimistic bump. ACTION_FAILED notification covers
      // the user-facing retry path elsewhere.
      console.warn('[PollDisplay] vote submit failed:', err)
      setLocal(prev)
      userTouchedRef.current = false
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="mt-3 mb-1 space-y-1.5">
      {poll.options.map((opt, i) => {
        const useOverride = optionLabelsOverride && optionLabelsOverride.length === poll.options.length
        const displayOpt = useOverride ? optionLabelsOverride![i] : opt
        const count = totals.counts[i] || 0
        const rawPct = totals.sum > 0 ? (count / totals.sum) * 100 : 0
        const pct = Math.round(rawPct)
        const isUserPick = local.optionIndex === i
        const isHover = hovered === i
        // Optional per-option thumbnail. The image lives off-chain so polls
        // mirrored from another node arrive without one — render text-only
        // in that case (the slot is just an empty string).
        const imgUrl = poll.optionImages?.[i] || ''

        if (showResults) {
          // Width animates from 0 on the very first render with results
          // visible. After that, transitions handle subsequent changes.
          const targetWidth = mounted ? `${rawPct}%` : '0%'
          return (
            <button
              key={i}
              onClick={() => submitVote(i)}
              disabled={submitting || isUserPick}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{ background: 'transparent', minHeight: 50 }}
              className={`relative w-full text-left px-3 py-2 rounded-lg overflow-hidden ${
                isUserPick
                  ? 'cursor-default'
                  : (submitting ? 'cursor-wait opacity-60' : 'cursor-pointer hover:opacity-95')
              }`}
            >
              {/* Filled bar — width transitions to its target percentage.
                  The 700ms duration + ease-out feels like a proper "filling"
                  motion rather than a snap. */}
              <div
                className={`absolute inset-y-0 left-0 transition-[width] duration-700 ease-out ${
                  isUserPick
                    ? (isDark ? 'bg-yellow-500/30' : 'bg-yellow-200')
                    : (isDark ? 'bg-white/10' : 'bg-gray-200')
                }`}
                style={{ width: targetWidth }}
              />
              {/* Outline */}
              <div className={`absolute inset-0 rounded-lg pointer-events-none border transition-colors ${
                isUserPick
                  ? (isDark ? 'border-yellow-500/60' : 'border-yellow-500')
                  : (isDark ? 'border-white/10' : 'border-gray-200')
              }`} />
              <div className="relative flex items-center gap-3">
                <PollOptionThumb imageUrl={imgUrl} number={i + 1} isDark={isDark} />
                <span className={`flex-1 break-words text-base transition-colors ${
                  isUserPick
                    ? (isDark ? 'text-white font-medium' : 'text-gray-900 font-medium')
                    : (isDark ? 'text-white/80' : 'text-gray-800')
                }`}>
                  {displayOpt}
                  {isUserPick && local.pending && (
                    <span className={`ml-2 text-[10px] uppercase tracking-wide ${
                      isDark ? 'text-yellow-400/70' : 'text-yellow-600/80'
                    }`}>
                      {t('poll.pending')}
                    </span>
                  )}
                </span>
                {/* Percentage also animates by counting up via key change */}
                <span className={`text-base tabular-nums transition-colors ${
                  isDark ? 'text-white/60' : 'text-gray-600'
                }`}>
                  {pct}%
                </span>
              </div>
            </button>
          )
        }

        // Pre-vote state. Each option is a fresh button.
        return (
          <button
            key={i}
            onClick={() => submitVote(i)}
            disabled={submitting}
            onMouseEnter={() => setHovered(i)}
            onMouseLeave={() => setHovered(null)}
            style={{ minHeight: 50 }}
            className={`w-full text-left px-3 py-2 rounded-lg border text-base transition-colors flex items-center gap-3 ${
              submitting
                ? 'cursor-wait opacity-60'
                : (isHover
                  ? (isDark ? 'border-yellow-500 bg-yellow-500/10 text-white' : 'border-yellow-500 bg-yellow-50 text-gray-900')
                  : (isDark ? 'border-white/10 hover:border-yellow-500/50 text-white/80' : 'border-gray-200 hover:border-yellow-500/50 text-gray-800'))
            }`}
          >
            <PollOptionThumb imageUrl={imgUrl} number={i + 1} isDark={isDark} />
            <span className="flex-1 break-words">{displayOpt}</span>
          </button>
        )
      })}

      <div className={`flex items-center justify-between text-xs mt-2 ${
        isDark ? 'text-white/40' : 'text-gray-500'
      }`}>
        <span>{t('poll.vote_count', { count: local.total })}</span>
        {showResults && !local.pending && (
          <button
            onClick={() => submitVote(null)}
            disabled={submitting}
            className={`hover:underline ${submitting ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
          >
            {t('poll.remove_vote')}
          </button>
        )}
      </div>
    </div>
  )
}

export default PollDisplay
