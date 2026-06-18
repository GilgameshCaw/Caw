/**
 * SponsorInviteSection — buy a sponsored invite code + see the ones you bought.
 *
 * The buyer signs an OTHER action that tips CAW to this server's validator
 * profile (recipients[0] = validatorTokenId from /api/sponsor/invite-quote).
 * The tip must clear the gas floor; the remainder becomes the new code's gift.
 * Only the tipped mirror mints + stores the code, retrievable here via
 * GET /api/sponsor/my-codes.
 *
 * The amount is entered + shown in USD; the input is clamped to >= the gas-floor
 * USD value. The username-min selector is floored at 8. All amounts convert to
 * whole CAW via the live price for the on-chain action.
 */

import { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { usePriceStore } from '~/store/tokenDataStore'
import { useActiveToken } from '~/store/tokenDataStore'
import { useSignAndSubmitAction, getCurrentMarketTip } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { formatUsd } from '~/utils/numberFormat'

interface InviteQuote {
  gasFloorCaw: string
  gasMarginCaw: string
  maxGiftCaw: string
  cawUsdRate: number
  // Binding per-action cost in whole CAW = max(base tip, ETH-floor→CAW). Use
  // THIS for "~N actions", not the FE base tip alone (which ignores the higher
  // ETH-pegged floor and over-counts).
  perActionCaw: string
  priceAvailable: boolean
  validatorTokenId: number | null
}

interface MyCode {
  code: string | null
  used: boolean
  // True for a purchase that's been submitted on-chain but not yet indexed —
  // the code doesn't exist server-side yet, so `code` is null. Shows as
  // "Pending" until the action is mined + indexed (then it becomes a real code).
  pending: boolean
  usesRemaining: number | null
  giftCawWei: string
  paidCawWei: string
  createdAt: string
  expiresAt: string | null
}


type BuyState = 'idle' | 'signing' | 'submitted'

export default function SponsorInviteSection() {
  const { isDark } = useTheme()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const activeToken = useActiveToken()
  const activeTokenId = activeToken?.tokenId
  const signAndSubmit = useSignAndSubmitAction()

  const [quote, setQuote] = useState<InviteQuote | null>(null)
  const [codes, setCodes] = useState<MyCode[]>([])
  // A locally-injected pending row shown the instant a purchase is signed, before
  // the server's TxQueue row is queryable. Cleared once the server returns its own
  // row (pending or minted) carrying the same gift. Keyed by giftCawWei.
  const [optimisticPending, setOptimisticPending] = useState<MyCode | null>(null)
  const [usdInput, setUsdInput] = useState('2.50')
  const [buyState, setBuyState] = useState<BuyState>('idle')
  const [error, setError] = useState<string | null>(null)
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)

  const strongClass = isDark ? 'text-white' : 'text-gray-900'
  const mutedClass = isDark ? 'text-white/50' : 'text-gray-500'
  const cardClass = `rounded-2xl p-5 ${isDark ? 'bg-white/[0.04] border border-white/10' : 'bg-black/[0.03] border border-black/10'}`

  // ── Quote (gas floor in USD) ──────────────────────────────────────────────
  useEffect(() => {
    apiFetch<InviteQuote>('/api/sponsor/invite-quote')
      .then(q => setQuote(q))
      .catch(() => setQuote(null))
  }, [])

  const loadCodes = useCallback(() => {
    apiFetch<{ codes: MyCode[] }>('/api/sponsor/my-codes')
      .then(r => {
        const list = r.codes ?? []
        setCodes(list)
        // Drop the optimistic placeholder once the server has its OWN row for the
        // same gift (pending or minted) — otherwise the same purchase double-shows.
        setOptimisticPending(prev =>
          prev && list.some(c => c.giftCawWei === prev.giftCawWei) ? null : prev,
        )
      })
      .catch(() => { /* not signed in / none — leave empty */ })
  }, [])
  useEffect(() => { loadCodes() }, [loadCodes])

  // The rendered list = server rows, plus the optimistic placeholder if it hasn't
  // been superseded yet. Optimistic row first (it's the freshest action).
  const displayCodes = optimisticPending ? [optimisticPending, ...codes] : codes

  // While any code is still pending (submitted on-chain, awaiting index) — server
  // row OR the optimistic placeholder — poll every 8s so it flips to a real code
  // on its own, including after a refresh (where the post-submit poll is gone).
  const hasPending = displayCodes.some(c => c.pending)
  useEffect(() => {
    if (!hasPending) return
    const id = setInterval(loadCodes, 8000)
    return () => clearInterval(id)
  }, [hasPending, loadCodes])

  // Gas floor + margin in whole CAW (from the quote) and their USD values.
  const gasFloorCaw = quote ? BigInt(quote.gasFloorCaw) : 0n
  const gasMarginCaw = quote ? BigInt(quote.gasMarginCaw) : 0n
  // Per-code gift ceiling (whole CAW). The server rejects a tip whose gift would
  // exceed this; clamp the input here so the buyer can't sign an over-cap action
  // that would mint no code (and not be refunded).
  const maxGiftCaw = quote ? BigInt(quote.maxGiftCaw) : 0n
  const rate = quote?.cawUsdRate ?? cawPrice // $/CAW
  // The OVERHEAD the sponsor pays before any gift = gas + LZ relay (gasMarginCaw)
  // PLUS the username BURN for the shortest name this code allows (the server
  // fronts that burn at redeem). A shorter min-length → bigger burn → higher
  // overhead → higher minimum. The gift is tip − overhead.
  //
  // GAS BUFFER: pad the gas+LZ leg by 15% so the buyer slightly over-funds. The
  // code is redeemed LATER at whatever gas costs then — the gift is settled
  // against real costs at the friend's signup, not frozen now (see note below
  // the form). The buffer keeps a modest gas rise from eating the whole gift.
  // The burn leg is a fixed CAW amount, so it gets no buffer.
  // GIFT-AWARE pot: overhead is gas + LZ ONLY. The username BURN is NOT pre-paid
  // by the sponsor — it comes out of the pot when the invitee picks a name at
  // signup (a shorter, rarer name eats more of the pot, leaving a smaller
  // deposit). So the sponsor just funds a pot; no min-username-length to choose.
  const GAS_BUFFER_NUM = 115
  const GAS_BUFFER_DEN = 100
  const bufferedGasMarginCaw = (gasMarginCaw * BigInt(GAS_BUFFER_NUM)) / BigInt(GAS_BUFFER_DEN)
  const overheadCaw = bufferedGasMarginCaw
  // Minimum the sponsor may enter: the overhead, rounded up to the next cent, plus
  // one cent of headroom so the smallest valid entry still produces a positive gift.
  const overheadUsd = Number(overheadCaw) * rate
  const minUsd = Math.max(0.01, Math.ceil(overheadUsd * 100) / 100 + 0.01)
  // Maximum: a tip whose gift hits the per-code cap = maxGift + overhead, in USD,
  // rounded DOWN to the cent so the on-chain gift stays at or under the cap.
  const maxTipCaw = maxGiftCaw + overheadCaw
  const maxUsd = maxGiftCaw > 0n ? Math.floor(Number(maxTipCaw) * rate * 100) / 100 : Infinity

  const usdAmount = parseFloat(usdInput) || 0
  // Whole CAW the sponsor will tip (their USD / price). The gift the invitee
  // receives is this minus the overhead (gas + relay + burn).
  const tipWholeCaw = rate > 0 ? Math.max(0, Math.round(usdAmount / rate)) : 0
  const giftWholeCaw = Math.max(0, tipWholeCaw - Number(overheadCaw))
  const giftUsd = giftWholeCaw * rate
  // "Sponsors ~N actions": gift ÷ the BINDING per-action cost the invitee pays.
  // The server computes this as max(validator base tip, ETH-pegged min-tip floor
  // → CAW) — the on-chain oracle charges whichever is higher per action. Using
  // the FE base tip alone (getCurrentMarketTip) ignored the ETH floor and
  // over-counted (e.g. "~9,833 actions" when the floor made each ~50x the base).
  // Fall back to the FE base tip only if the quote hasn't loaded.
  const perActionCaw = quote && Number(quote.perActionCaw) > 0
    ? Number(quote.perActionCaw)
    : Number(getCurrentMarketTip())
  const sponsoredActions = perActionCaw > 0 ? Math.floor(giftWholeCaw / perActionCaw) : 0

  const priceReady = rate > 0 && quote?.priceAvailable !== false
  const aboveFloor = usdAmount >= minUsd && tipWholeCaw > 0
  // Gift must not exceed the per-code cap (server enforces this; mirror it here).
  const belowCap = maxGiftCaw === 0n || BigInt(giftWholeCaw) <= maxGiftCaw
  const canBuy =
    priceReady &&
    aboveFloor &&
    belowCap &&
    !!activeTokenId &&
    quote?.validatorTokenId != null &&
    buyState === 'idle'

  // Diagnostic: which gate is keeping the Sponsor button disabled. Logged only
  // when disabled so it doesn't spam. Each false flag is a reason it's blocked.
  useEffect(() => {
    if (canBuy) return
    // eslint-disable-next-line no-console
    console.debug('[invite] Sponsor button DISABLED — gates:', {
      priceReady,
      aboveFloor,
      belowCap,
      hasActiveToken: !!activeTokenId,
      hasValidatorToken: quote?.validatorTokenId != null,
      buyStateIdle: buyState === 'idle',
      // raw inputs behind the gates
      usdAmount, minUsd, maxUsd,
      rate,
      tipWholeCaw, giftWholeCaw,
      overheadCaw: Number(overheadCaw),
      maxGiftCaw: maxGiftCaw.toString(),
      quoteLoaded: !!quote,
      priceAvailable: quote?.priceAvailable,
      validatorTokenId: quote?.validatorTokenId,
      activeTokenId,
    })
  }, [canBuy, priceReady, aboveFloor, belowCap, activeTokenId, quote, buyState, usdAmount, minUsd, maxUsd, rate, tipWholeCaw, giftWholeCaw, overheadCaw, maxGiftCaw])

  const handleBuy = async () => {
    if (!canBuy || !quote?.validatorTokenId || !activeTokenId) return
    setError(null)
    setBuyState('signing')
    try {
      await signAndSubmit({
        actionType: 'other',
        senderId: activeTokenId,
        recipients: [quote.validatorTokenId],
        amounts: [BigInt(tipWholeCaw)],
        // Short on-chain prefix "sp-i:" (not "sponsor-invite:") — every byte of
        // action text costs validators calldata gas forever. Must match the
        // dispatch in ActionProcessor/actionHandlers.ts. Field 3 is the floor
        // username length: the gift-aware handler ignores a sponsor-chosen value
        // and derives the affordable floor from the pot, so we just send 6.
        text: `sp-i:${giftWholeCaw}:6`,
      })
      setBuyState('submitted')
      // Optimistically show a PENDING entry the instant we've signed — before the
      // server's TxQueue row is even queryable — so the user never sees an empty
      // list after a successful submit. The server-derived pending row (and then
      // the real minted code) supersedes it on the next loadCodes() via dedup on
      // giftCawWei. Cleared once a server row with the same gift shows up.
      const optimisticGiftWei = (BigInt(giftWholeCaw) * 10n ** 18n).toString()
      setOptimisticPending({
        code: null,
        used: false,
        pending: true,
        usesRemaining: null,
        giftCawWei: optimisticGiftWei,
        paidCawWei: optimisticGiftWei,
        createdAt: new Date().toISOString(),
        expiresAt: null,
      })
      // Refetch right away (server should have the TxQueue row by now), then keep
      // polling so it advances pending → minted without a manual refresh.
      loadCodes()
      let tries = 0
      const poll = setInterval(() => {
        tries++
        loadCodes()
        if (tries >= 12) { clearInterval(poll); setBuyState('idle') }
      }, 5000)
    } catch (err: any) {
      console.error('[buy-invite] failed:', err)
      setBuyState('idle')
      setError(
        err?.message?.includes('rejected') || err?.message?.includes('denied')
          ? 'Transaction rejected.'
          : 'Could not submit. Please try again.',
      )
    }
  }

  // The full shareable invite link the buyer sends to a friend. Onboarding reads
  // ?code=<CODE> from the URL (see Onboarding.tsx), so this is the only thing the
  // recipient needs — no separate code entry.
  const inviteLink = (code: string) => `${window.location.origin}/onboarding?code=${encodeURIComponent(code)}`

  const copy = (code: string, idx: number) => {
    navigator.clipboard?.writeText(inviteLink(code)).then(() => {
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 1500)
    }).catch(() => { /* clipboard blocked — user can select manually */ })
  }

  return (
    <div className="space-y-6">
      {/* ── Buy a code ───────────────────────────────────────────────────── */}
      <div className={cardClass}>
        <h3 className={`text-lg font-bold mb-1 ${strongClass}`}>Sponsor an invite code</h3>
        <p className={`text-sm mb-4 ${mutedClass}`}>
          Pay CAW to mint a sponsored invite code you can give to a friend. Your
          payment covers the gas, their username, and network fees — anything above
          is given to the invitee as a gift.{' '}
          <span className={isDark ? 'text-yellow-400' : 'text-yellow-600'}>
            This lets your friends create an account even if they don't have a wallet.
          </span>
        </p>

        {!priceReady ? (
          <p className={`text-sm ${mutedClass}`}>Loading price…</p>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <label className={`text-sm font-medium ${strongClass}`}>Amount (USD)</label>
              <span className={`text-xs ${mutedClass}`}>
                Minimum ${minUsd.toFixed(2)} (covers gas + username + network fees)
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className={mutedClass}>$</span>
              <input
                type="number"
                min={minUsd}
                max={Number.isFinite(maxUsd) ? maxUsd : undefined}
                step="0.01"
                value={usdInput}
                onChange={e => setUsdInput(e.target.value)}
                onBlur={() => {
                  if (usdAmount < minUsd) setUsdInput(minUsd.toFixed(2))
                  else if (Number.isFinite(maxUsd) && usdAmount > maxUsd) setUsdInput(maxUsd.toFixed(2))
                }}
                className={`flex-1 px-3 py-2 rounded-xl border text-sm outline-none ${
                  isDark ? 'bg-white/5 border-white/20 text-white' : 'bg-white border-gray-300 text-gray-900'
                } ${aboveFloor && belowCap ? 'focus:border-yellow-500' : 'border-red-500'}`}
              />
            </div>
            {!belowCap ? (
              <p className="text-xs mt-1 text-red-500">
                Maximum ${Number.isFinite(maxUsd) ? maxUsd.toFixed(2) : '—'} per code.
              </p>
            ) : !aboveFloor ? (
              <p className="text-xs mt-1 text-red-500">
                Enter at least ${minUsd.toFixed(2)}.
              </p>
            ) : giftUsd > 0 ? (
              <p className={`text-xs mt-1 ${mutedClass}`}>
                ~${giftUsd.toFixed(2)} will be given as a gift to the user, which will
                cover their first ~{sponsoredActions.toLocaleString()} action{sponsoredActions === 1 ? '' : 's'}.{' '}
                <span className={isDark ? 'text-white/40' : 'text-gray-400'}>
                  The exact gift is settled when your friend signs up, so it may shift a little with gas prices.
                </span>
              </p>
            ) : null}

            <p className={`text-xs mt-4 ${mutedClass}`}>
              Your friend picks any username at signup. A shorter, rarer name costs
              more to mint and leaves them a smaller deposit — they spend the gift
              however they like.
            </p>

            {error && <p className="text-sm text-red-500 mt-3">{error}</p>}

            <button
              onClick={handleBuy}
              disabled={!canBuy}
              className={`mt-4 w-full py-3 rounded-full font-semibold text-sm transition-all ${
                canBuy
                  ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
                  : isDark ? 'bg-gray-700 text-gray-400 cursor-not-allowed' : 'bg-gray-300 text-gray-600 cursor-not-allowed'
              }`}
            >
              {buyState === 'signing' ? 'Signing…'
                : buyState === 'submitted' ? 'Submitted — your code will appear below'
                : `Sponsor for $${formatUsd(usdAmount)}`}
            </button>
            {!activeTokenId && (
              <p className={`text-xs mt-2 ${mutedClass}`}>Sign in with a profile to buy a code.</p>
            )}
          </>
        )}
      </div>

      {/* ── My codes ─────────────────────────────────────────────────────── */}
      <div className={cardClass}>
        <h3 className={`text-lg font-bold mb-3 ${strongClass}`}>My invite codes</h3>
        {displayCodes.length === 0 ? (
          <p className={`text-sm ${mutedClass}`}>You haven't bought any invite codes yet.</p>
        ) : (
          <ul className="space-y-2">
            {displayCodes.map((c, i) => (
              <li
                key={i}
                className={`flex items-center justify-between gap-3 px-3 py-2 rounded-xl ${
                  isDark ? 'bg-white/5' : 'bg-black/[0.03]'
                }`}
              >
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => c.code && copy(c.code, i)}
                    className={`font-mono text-sm truncate ${strongClass} ${c.code ? 'cursor-pointer hover:underline' : ''}`}
                    title={c.code ? inviteLink(c.code) : ''}
                  >
                    {c.code ?? (c.pending ? 'Generating your code…' : '— (unavailable on this device)')}
                  </button>
                  <div className={`text-xs ${mutedClass}`}>
                    Gift ~${formatUsd((Number(BigInt(c.giftCawWei) / 10n ** 18n)) * rate)}
                    {copiedIdx === i && <span className="text-green-500 ml-2">Link copied!</span>}
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {c.code && (
                    <button
                      type="button"
                      onClick={() => copy(c.code!, i)}
                      title="Copy invite link"
                      aria-label="Copy invite link"
                      className={`p-1.5 rounded-lg transition-colors cursor-pointer ${
                        copiedIdx === i
                          ? 'text-green-500'
                          : isDark ? 'text-white/60 hover:text-white hover:bg-white/10' : 'text-gray-500 hover:text-gray-900 hover:bg-black/5'
                      }`}
                    >
                      {copiedIdx === i ? (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                        </svg>
                      ) : (
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-2M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3" />
                        </svg>
                      )}
                    </button>
                  )}
                  <span
                    className={`text-xs font-semibold px-2 py-1 rounded-full ${
                      c.pending
                        ? (isDark ? 'bg-yellow-500/15 text-yellow-400' : 'bg-yellow-100 text-yellow-700')
                        : c.used
                          ? (isDark ? 'bg-gray-500/20 text-gray-400' : 'bg-gray-200 text-gray-600')
                          : (isDark ? 'bg-green-500/15 text-green-400' : 'bg-green-100 text-green-700')
                    }`}
                  >
                    {c.pending ? 'Pending' : c.used ? 'Used' : 'Unused'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
