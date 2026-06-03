// Phase 2 Sponsor Repay — read-only obligation status for the active profile.
// Renders only when /api/sponsor/repay/:tokenId returns a row. Currently
// informational only; Phase 2b will wire the auto-sweep on withdraw and this
// component will display the per-withdraw split preview.
import React, { useEffect, useState } from 'react'
import { formatUnits } from 'viem'
import { apiFetch } from '~/api/client'

function formatCaw(wei: bigint): string {
  const whole = Number(formatUnits(wei, 18))
  if (whole === 0) return '0'
  if (whole < 0.0001) return whole.toExponential(2)
  if (whole < 1) return whole.toFixed(4)
  return whole.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

interface RepayRow {
  tokenId:                number
  sponsorTokenId:         number
  sponsorUsername:        string | null
  currentRepayAmountWei:  string
  originalRepayAmountWei: string
  sponsoredDepositWei:    string | null
  registeredAt:           string
  forgivenAt:             string | null
  lastSweepAmountWei:     string | null
  lastSweepAt:            string | null
}

export function RepayStatus({ tokenId }: { tokenId: number | null | undefined }) {
  const [row, setRow] = useState<RepayRow | null>(null)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!tokenId) return
    let cancelled = false
    apiFetch<RepayRow>(`/api/sponsor/repay/${tokenId}`)
      .then(r => { if (!cancelled) setRow(r) })
      .catch(() => { /* 404 = no obligation; render nothing */ })
      .finally(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [tokenId])

  if (!loaded || !row) return null

  const sponsorLabel = row.sponsorUsername ? `@${row.sponsorUsername}` : `profile #${row.sponsorTokenId}`
  const current  = BigInt(row.currentRepayAmountWei)
  const original = BigInt(row.originalRepayAmountWei)

  if (row.forgivenAt) {
    return (
      <div className="mt-3 rounded-lg border border-green-300/30 bg-green-50/10 px-4 py-3 text-sm">
        <div className="font-semibold text-green-300">Sponsor obligation forgiven</div>
        <div className="text-xs opacity-70 mt-1">
          {sponsorLabel} released this obligation on {new Date(row.forgivenAt).toLocaleDateString()}.
        </div>
      </div>
    )
  }

  if (current === 0n) {
    return (
      <div className="mt-3 rounded-lg border border-zinc-300/20 bg-zinc-50/5 px-4 py-3 text-sm">
        <div className="font-semibold opacity-90">Sponsored by {sponsorLabel}</div>
        <div className="text-xs opacity-70 mt-1">Repay obligation fully discharged.</div>
      </div>
    )
  }

  return (
    <div className="mt-3 rounded-lg border border-amber-300/30 bg-amber-50/10 px-4 py-3 text-sm">
      <div className="font-semibold text-amber-300">Sponsored by {sponsorLabel}</div>
      <div className="text-xs opacity-90 mt-1">
        {formatCaw(current)} CAW outstanding (of {formatCaw(original)} original)
      </div>
      <div className="text-xs opacity-60 mt-1">
        Per the sponsor terms, future withdrawals route this amount back to the sponsor.
      </div>
    </div>
  )
}
