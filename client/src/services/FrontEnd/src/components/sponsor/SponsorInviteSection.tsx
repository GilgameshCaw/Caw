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
import { useSignAndSubmitAction } from '~/api/actions'
import { apiFetch } from '~/api/client'
import { formatUsd } from '~/utils/numberFormat'

interface InviteQuote {
  gasFloorCaw: string
  gasMarginCaw: string
  maxGiftCaw: string
  cawUsdRate: number
  priceAvailable: boolean
  validatorTokenId: number | null
}

interface MyCode {
  code: string | null
  used: boolean
  usesRemaining: number | null
  giftCawWei: string
  paidCawWei: string
  createdAt: string
  expiresAt: string | null
}

const MIN_USERNAME_LEN = 8
// Minimum username length options offered to the buyer (all >= the 8 floor).
const MIN_LEN_OPTIONS = [8, 10, 12]

type BuyState = 'idle' | 'signing' | 'submitted'

export default function SponsorInviteSection() {
  const { isDark } = useTheme()
  const cawPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const activeToken = useActiveToken()
  const activeTokenId = activeToken?.tokenId
  const signAndSubmit = useSignAndSubmitAction()

  const [quote, setQuote] = useState<InviteQuote | null>(null)
  const [codes, setCodes] = useState<MyCode[]>([])
  const [usdInput, setUsdInput] = useState('20')
  const [minLen, setMinLen] = useState(MIN_USERNAME_LEN)
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
      .then(r => setCodes(r.codes ?? []))
      .catch(() => { /* not signed in / none — leave empty */ })
  }, [])
  useEffect(() => { loadCodes() }, [loadCodes])

  // Gas floor + margin in whole CAW (from the quote) and their USD values.
  const gasFloorCaw = quote ? BigInt(quote.gasFloorCaw) : 0n
  const gasMarginCaw = quote ? BigInt(quote.gasMarginCaw) : 0n
  // Per-code gift ceiling (whole CAW). The server rejects a tip whose gift would
  // exceed this; clamp the input here so the buyer can't sign an over-cap action
  // that would mint no code (and not be refunded).
  const maxGiftCaw = quote ? BigInt(quote.maxGiftCaw) : 0n
  const rate = quote?.cawUsdRate ?? cawPrice // $/CAW
  // Minimum the user may enter is the gas+LZ MARGIN (not just the gas floor):
  // the gift is tip − margin, so anything at or below the margin gifts $0. Basing
  // the minimum on the margin means the smallest valid entry actually produces a
  // positive gift, instead of the old floor-based min that let a buyer pay and
  // gift nothing. Round up to the next cent, then add one cent of headroom so the
  // gift is strictly > 0 at the minimum.
  const marginUsd = Number(gasMarginCaw) * rate
  const minUsd = Math.max(0.01, Math.ceil(marginUsd * 100) / 100 + 0.01)
  // Maximum the user may enter: a tip whose gift hits the per-code cap = maxGift +
  // margin, in USD, rounded DOWN to the cent so the on-chain gift stays at or under
  // the cap. (When mainnet gas is high the margin is large, so min can approach
  // max; the maxGiftCaw cap is generous enough — 200M CAW — to keep a usable gap.)
  const maxTipCaw = maxGiftCaw + gasMarginCaw
  const maxUsd = maxGiftCaw > 0n ? Math.floor(Number(maxTipCaw) * rate * 100) / 100 : Infinity

  const usdAmount = parseFloat(usdInput) || 0
  // Whole CAW the buyer will tip (their USD / price). The gift is this minus the
  // gas+LZ margin; we show that split so they know what the new user receives.
  const tipWholeCaw = rate > 0 ? Math.max(0, Math.round(usdAmount / rate)) : 0
  const giftWholeCaw = Math.max(0, tipWholeCaw - Number(gasMarginCaw))
  const giftUsd = giftWholeCaw * rate

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
        text: `sponsor-invite:${giftWholeCaw}:${minLen}`,
      })
      setBuyState('submitted')
      // The code is minted asynchronously once the action is indexed; poll the
      // list a few times so it appears without a manual refresh.
      let tries = 0
      const poll = setInterval(() => {
        tries++
        loadCodes()
        if (tries >= 6) { clearInterval(poll); setBuyState('idle') }
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

  const copy = (code: string, idx: number) => {
    navigator.clipboard?.writeText(code).then(() => {
      setCopiedIdx(idx)
      setTimeout(() => setCopiedIdx(null), 1500)
    }).catch(() => { /* clipboard blocked — user can select manually */ })
  }

  return (
    <div className="space-y-6">
      {/* ── Buy a code ───────────────────────────────────────────────────── */}
      <div className={cardClass}>
        <h3 className={`text-lg font-bold mb-1 ${strongClass}`}>Buy an invite code</h3>
        <p className={`text-sm mb-4 ${mutedClass}`}>
          Pay CAW to mint a sponsored invite code you can give to a friend. Your
          payment covers the gas and the gift the new user receives.
        </p>

        {!priceReady ? (
          <p className={`text-sm ${mutedClass}`}>Loading price…</p>
        ) : (
          <>
            <label className={`block text-sm font-medium mb-1 ${strongClass}`}>Amount (USD)</label>
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
            <p className={`text-xs mt-1 ${aboveFloor && belowCap ? mutedClass : 'text-red-500'}`}>
              {!belowCap ? (
                <>Maximum ${Number.isFinite(maxUsd) ? maxUsd.toFixed(2) : '—'} per code.</>
              ) : (
                <>Minimum ${minUsd.toFixed(2)} (covers gas + relay; anything above becomes
                the gift). Of your ${formatUsd(usdAmount)},{' '}
                <span className={strongClass}>${formatUsd(giftUsd)}</span> becomes the new user's gift.</>
              )}
            </p>

            <label className={`block text-sm font-medium mt-4 mb-1 ${strongClass}`}>Minimum username length</label>
            <div className="flex gap-2">
              {MIN_LEN_OPTIONS.map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setMinLen(n)}
                  className={`flex-1 py-2 text-sm rounded-full border transition-colors cursor-pointer ${
                    minLen === n
                      ? 'border-yellow-500 text-yellow-500'
                      : isDark ? 'border-white/10 text-gray-400 hover:text-white' : 'border-gray-300 text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {n}+ chars
                </button>
              ))}
            </div>
            <p className={`text-xs mt-1 ${mutedClass}`}>
              Shorter usernames cost more CAW to mint; a higher minimum protects the gift.
            </p>

            {error && <p className="text-sm text-red-500 mt-3">{error}</p>}

            <button
              onClick={handleBuy}
              disabled={!canBuy}
              className={`mt-4 w-full py-3 rounded-full font-semibold text-sm transition-all ${
                canBuy
                  ? 'bg-yellow-500 text-black hover:bg-yellow-400 cursor-pointer'
                  : 'bg-yellow-500/30 text-black/40 cursor-not-allowed'
              }`}
            >
              {buyState === 'signing' ? 'Signing…'
                : buyState === 'submitted' ? 'Submitted — your code will appear below'
                : `Buy for $${formatUsd(usdAmount)}`}
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
        {codes.length === 0 ? (
          <p className={`text-sm ${mutedClass}`}>You haven't bought any invite codes yet.</p>
        ) : (
          <ul className="space-y-2">
            {codes.map((c, i) => (
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
                    title={c.code ?? ''}
                  >
                    {c.code ?? '— (unavailable on this device)'}
                  </button>
                  <div className={`text-xs ${mutedClass}`}>
                    Gift ~${formatUsd((Number(BigInt(c.giftCawWei) / 10n ** 18n)) * rate)}
                    {copiedIdx === i && <span className="text-green-500 ml-2">Copied!</span>}
                  </div>
                </div>
                <span
                  className={`text-xs font-semibold px-2 py-1 rounded-full shrink-0 ${
                    c.used
                      ? (isDark ? 'bg-gray-500/20 text-gray-400' : 'bg-gray-200 text-gray-600')
                      : (isDark ? 'bg-green-500/15 text-green-400' : 'bg-green-100 text-green-700')
                  }`}
                >
                  {c.used ? 'Used' : 'Unused'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
