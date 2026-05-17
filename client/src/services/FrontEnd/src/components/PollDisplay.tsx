import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import { useConnectModal } from '@rainbow-me/rainbowkit'
import { useSignAndSubmitAction } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { buildVoteText } from '~/../../../tools/pollMarker'
import type { CawItem } from '~/types'
import { useT } from '~/i18n/I18nProvider'

/**
 * Format a positive millisecond duration as a short countdown string —
 * "3d 4h", "5h", "23m", "<1m". Picks the two largest non-zero units so
 * a poll closing in 25 hours reads "1d 1h" instead of "25h". Used by
 * the inline poll widget's "Ends in <X>" footer.
 *
 * Negative input falls through to "<1m" — caller should swap to the
 * "Poll ended" copy before reaching here.
 */
function formatRemaining(ms: number): string {
  if (ms <= 0) return '<1m'
  const totalMin = Math.floor(ms / 60_000)
  if (totalMin < 1) return '<1m'
  const d = Math.floor(totalMin / 1440)
  const h = Math.floor((totalMin % 1440) / 60)
  const m = totalMin % 60
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`
  return `${m}m`
}

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
  /**
   * The set of options the viewer has voted for. Single-select polls
   * keep this at size 0 or 1; multi-select polls can carry any subset
   * of option indices. Empty Set = no vote (whether the user never
   * voted OR explicitly cleared their vote).
   */
  picks: Set<number>
  /**
   * Per-option pending flag. `pending.get(i) === true` means the
   * viewer's vote on option i is optimistic — local state shows it
   * but the indexer hasn't confirmed yet. Single-select polls usually
   * only have one entry; multi-select polls can have several.
   */
  pending: Map<number, boolean>
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
  // Track the TxQueue id of the most recent in-flight vote, per option.
  // When the user changes / unsets their pick while one is still
  // pending we can POST /api/txqueue/:id/cancel and submit a fresh
  // action — same pattern Like/Recaw/Follow use for cancel-on-second-
  // click. Single-select polls only have one entry at a time;
  // multi-select polls keep one entry per toggled-on option until
  // the indexer confirms.
  const pendingTxIdsRef = useRef<Map<number, number>>(new Map())

  const poll = caw.poll

  // Initialize local state from the server snapshot. Re-syncs whenever the
  // server snapshot changes (e.g. another user voted, or the indexer
  // confirmed our pending vote). The localVote.optionIndex `null` value is
  // distinct from the server-side absence of a vote: when the user just
  // clicked "Remove vote" we want to show the no-vote rows even though the
  // server still has a row until the action confirms.
  const buildInitialLocal = (): LocalVote => {
    // Prefer `userVotes` (full multi-select set) when present; fall
    // back to `userVote` for older API responses that only carried
    // the single-select shape.
    const rows = poll?.userVotes ?? (poll?.userVote ? [poll.userVote] : [])
    const picks = new Set<number>()
    const pending = new Map<number, boolean>()
    for (const r of rows) {
      picks.add(r.optionIndex)
      pending.set(r.optionIndex, r.pending)
    }
    return {
      picks,
      pending,
      counts: poll?.optionVoteCounts ? poll.optionVoteCounts.slice() : (poll?.options || []).map(() => 0),
      total: poll?.totalVotes || 0,
    }
  }
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
    // "Server confirmed at least one of our votes": any row that
    // came back with pending=false. If the user has a still-pending
    // optimistic pick we keep that until the indexer round-trips.
    const serverConfirmed = (poll.userVotes ?? (poll.userVote ? [poll.userVote] : []))
      .some(r => !r.pending)
    const ourLocalHasPending = Array.from(local.pending.values()).some(v => v)
    if (!userTouchedRef.current || (serverConfirmed && ourLocalHasPending)) {
      setLocal(buildInitialLocal())
    } else if ((poll.totalVotes ?? 0) > local.total) {
      // Other voters joined — refresh the counts but keep our optimistic pick.
      setLocal(prev => ({
        ...prev,
        counts: poll.optionVoteCounts ? poll.optionVoteCounts.slice() : prev.counts,
        total: poll.totalVotes ?? prev.total,
      }))
    }
    // Drop the txQueueId map entry for any option whose server-side
    // row is now confirmed (pending=false). After confirm we can't
    // cancel it anyway, and a stale entry would make a future "cancel
    // before resubmit" try to cancel an already-finalized action.
    for (const r of poll.userVotes ?? (poll.userVote ? [poll.userVote] : [])) {
      if (!r.pending) pendingTxIdsRef.current.delete(r.optionIndex)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(poll?.userVotes ?? poll?.userVote), poll?.totalVotes, JSON.stringify(poll?.optionVoteCounts)])

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

  // Re-render every 30s so the "Ends in Xh" countdown stays fresh
  // without polling the server. Cheap; only kicks for polls with an
  // endsAt set.
  const [, forceTick] = useState(0)
  useEffect(() => {
    if (!poll?.endsAt) return
    const id = setInterval(() => forceTick(t => t + 1), 30_000)
    return () => clearInterval(id)
  }, [poll?.endsAt])

  if (!poll || !totals) return null

  const endsAtMs = poll.endsAt ? new Date(poll.endsAt).getTime() : null
  const hasEnded = endsAtMs != null && Date.now() > endsAtMs

  const isMulti = !!poll.multiSelect
  // For single-select polls the existing "user voted → show results"
  // semantic is right. For multi-select we keep showing the option
  // rows as checkboxes regardless of whether they've voted, but flip
  // to results-style fill bars when the poll has ended (or when the
  // user wants to see results — out of scope for v1).
  const showResults = (!isMulti && local.picks.size > 0) || hasEnded

  const submitVote = async (optionIndex: number | null) => {
    if (submitting) return
    if (hasEnded) return  // Poll closed — UI disables the buttons too.
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
      const picks = new Set(curr.picks)
      const pending = new Map(curr.pending)

      if (optionIndex === null) {
        // Unvote: drop every pick this user had. Decrement counts for
        // confirmed picks only (pending picks weren't reflected in
        // total to begin with).
        for (const i of picks) {
          if (!pending.get(i)) {
            counts[i] = Math.max(0, counts[i] - 1)
            total = Math.max(0, total - 1)
          }
        }
        picks.clear()
        pending.clear()
        return { picks, pending, counts, total }
      }

      if (isMulti) {
        // Multi-select toggle. If the user already had this option
        // picked, drop it; otherwise add it. Counts adjust based on
        // whether the removed pick was confirmed.
        if (picks.has(optionIndex)) {
          if (!pending.get(optionIndex)) {
            counts[optionIndex] = Math.max(0, counts[optionIndex] - 1)
            total = Math.max(0, total - 1)
          }
          picks.delete(optionIndex)
          pending.delete(optionIndex)
        } else {
          counts[optionIndex] = (counts[optionIndex] || 0) + 1
          total = total + 1
          picks.add(optionIndex)
          pending.set(optionIndex, true)
        }
        return { picks, pending, counts, total }
      }

      // Single-select: drop the previous pick (if any) and add the new one.
      for (const i of picks) {
        if (!pending.get(i)) {
          counts[i] = Math.max(0, counts[i] - 1)
          total = Math.max(0, total - 1)
        }
      }
      picks.clear()
      pending.clear()
      counts[optionIndex] = (counts[optionIndex] || 0) + 1
      total = total + 1
      picks.add(optionIndex)
      pending.set(optionIndex, true)
      return { picks, pending, counts, total }
    })

    setSubmitting(true)
    // Snapshot the txQueueIds we need to cancel before submitting the
    // new vote: anything that's about to be replaced by this action.
    //   - unvote (optionIndex===null): cancel every pending tx the
    //     user has on this poll
    //   - multi toggle-off: cancel the pending tx for that specific
    //     option (we set pending to false on it above, but the
    //     queued TxQueue still exists until cancelled)
    //   - multi toggle-on: nothing to cancel on this option (no prior
    //     tx); other options' pending votes stay independent
    //   - single replace: cancel the pending tx on the prior option
    //     (if any) — the new vote will supersede it
    const txIdsToCancel: number[] = []
    if (optionIndex === null) {
      for (const id of pendingTxIdsRef.current.values()) txIdsToCancel.push(id)
      pendingTxIdsRef.current.clear()
    } else if (isMulti) {
      // Was this a toggle-off? local already mutated; check prev.
      if (prev.picks.has(optionIndex)) {
        const id = pendingTxIdsRef.current.get(optionIndex)
        if (id != null) { txIdsToCancel.push(id); pendingTxIdsRef.current.delete(optionIndex) }
      }
    } else {
      // Single-select: cancel any tx for a different option (replace).
      for (const [opt, id] of pendingTxIdsRef.current.entries()) {
        if (opt !== optionIndex) {
          txIdsToCancel.push(id)
          pendingTxIdsRef.current.delete(opt)
        }
      }
    }

    // Fire cancels in parallel. 409 = validator already picked it up;
    // we accept that case (the indexer's confirm-then-replace path
    // means the prior vote will be replaced on the next handleVote
    // run anyway).
    if (txIdsToCancel.length > 0) {
      await Promise.allSettled(
        txIdsToCancel.map(id =>
          apiFetch(`/api/txqueue/${id}/cancel`, { method: 'POST' })
            .catch((err: any) => {
              if (!String(err?.message || '').includes('409')) {
                console.warn(`[PollDisplay] cancel txQueueId=${id} failed:`, err)
              }
            })
        )
      )
    }

    try {
      const response: any = await signAndSubmit({
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
      // Stash the txQueueId so a future change can cancel us. Only
      // tracked for actions that ARE optimistic-on (i.e. we just
      // added this option to picks). Unvote and toggle-off don't
      // need tracking because there's nothing further to cancel.
      const txQueueId = response?.txQueueId
      if (txQueueId != null && optionIndex !== null) {
        const isAdd = isMulti
          ? !prev.picks.has(optionIndex)  // toggle-on
          : true                           // single-select always adds
        if (isAdd) pendingTxIdsRef.current.set(optionIndex, txQueueId)
      }
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
        const isUserPick = local.picks.has(i)
        const isThisPending = !!local.pending.get(i)
        const isHover = hovered === i
        // Optional per-option thumbnail. The image lives off-chain so polls
        // mirrored from another node arrive without one — render text-only
        // in that case (the slot is just an empty string).
        const imgUrl = poll.optionImages?.[i] || ''

        if (showResults) {
          // Width animates from 0 on the very first render with results
          // visible. After that, transitions handle subsequent changes.
          const targetWidth = mounted ? `${rawPct}%` : '0%'
          // In single-select results view, clicking your own pick is a
          // no-op (it would just re-submit the same vote). Multi-
          // select would toggle off so we keep it interactive.
          const lockedToPick = !isMulti && isUserPick
          return (
            <button
              key={i}
              onClick={() => submitVote(i)}
              disabled={submitting || lockedToPick || hasEnded}
              onMouseEnter={() => setHovered(i)}
              onMouseLeave={() => setHovered(null)}
              style={{ background: 'transparent', minHeight: 50 }}
              className={`relative w-full text-left px-3 py-2 rounded-lg overflow-hidden ${
                hasEnded || lockedToPick
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
                  {isUserPick && isThisPending && (
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

        // Pre-vote state. Each option is a fresh button. Multi-select
        // adds a checkbox indicator on the right; ticked when the user
        // has the option picked (whether confirmed or pending).
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
                : isUserPick
                  ? (isDark ? 'border-yellow-500 bg-yellow-500/10 text-white' : 'border-yellow-500 bg-yellow-50 text-gray-900')
                  : (isHover
                    ? (isDark ? 'border-yellow-500 bg-yellow-500/10 text-white' : 'border-yellow-500 bg-yellow-50 text-gray-900')
                    : (isDark ? 'border-white/10 hover:border-yellow-500/50 text-white/80' : 'border-gray-200 hover:border-yellow-500/50 text-gray-800'))
            }`}
          >
            <PollOptionThumb imageUrl={imgUrl} number={i + 1} isDark={isDark} />
            <span className="flex-1 break-words">
              {displayOpt}
              {isUserPick && isThisPending && (
                <span className={`ml-2 text-[10px] uppercase tracking-wide ${
                  isDark ? 'text-yellow-400/70' : 'text-yellow-600/80'
                }`}>
                  {t('poll.pending')}
                </span>
              )}
            </span>
            {isMulti && (
              <span
                className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-colors ${
                  isUserPick
                    ? 'bg-yellow-500 border-yellow-500'
                    : (isDark ? 'border-white/30' : 'border-gray-400')
                }`}
              >
                {isUserPick && (
                  <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-black" fill="none">
                    <path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </span>
            )}
          </button>
        )
      })}

      <div className={`flex items-center justify-between text-xs mt-2 ${
        isDark ? 'text-white/40' : 'text-gray-500'
      }`}>
        <span className="flex items-center gap-2">
          <span>{t('poll.vote_count', { count: local.total })}</span>
          {endsAtMs != null && (
            <span className={hasEnded ? 'text-red-400' : ''}>
              · {hasEnded
                  ? t('poll.ended')
                  : t('poll.ends_in', { remaining: formatRemaining(endsAtMs - Date.now()) })}
            </span>
          )}
        </span>
        {/* Remove-vote control appears whenever the user has at least
            one confirmed pick AND the poll is still open. For multi-
            select polls this clears every pick at once. */}
        {!hasEnded && local.picks.size > 0 && Array.from(local.pending.values()).every(v => !v) && (
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
