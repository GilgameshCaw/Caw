import React, { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken, usePriceStore } from '~/store/tokenDataStore'

// Wei -> CAW for display
function weiToCaw(wei: string | number | null | undefined): number {
  if (wei == null) return 0
  if (typeof wei === 'number') return wei / 1e18
  if (wei === '0' || wei === '') return 0
  try { return Number(BigInt(wei)) / 1e18 } catch { return 0 }
}
function fmtCaw(wei: string | number | null | undefined): string {
  const n = weiToCaw(wei)
  const abs = Math.abs(n)
  if (abs === 0) return '0'
  if (abs < 1) return n.toFixed(2)
  if (abs < 1_000) return n.toFixed(0)
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
  if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
  return `${(n / 1_000_000_000).toFixed(2)}B`
}

// -----------------------------------------------------------------
// Segment registry. Each chart segment has a stable key, a label, a
// color, and a side (incoming vs outgoing). The page generates the
// legend from this registry; toggles are URL-state by `disabledIn`
// and `disabledOut` keys.
// -----------------------------------------------------------------
type Side = 'in' | 'out'

interface Segment {
  key: string
  label: string
  color: string  // tailwind bg class
  textColor: string // tailwind text class for tooltip
  side: Side
}

// Muted vintage palette — full hue spread (greens, purples, oranges,
// reds, golds, teals) but at moderate saturation so the chart reads
// as cohesive rather than a kid's crayon set. Brand yellow stays on
// the headline staking-rewards metric.
//
// Outgoing uses the same hue families as incoming where the concept
// matches (TIP↔TIP, LIKE↔LIKE), but each one is shifted darker and a
// touch cooler so the eye knows which side is which without reading.
//
// Inline hex (not Tailwind) so the palette is definitive and theme-
// stable across Tailwind version bumps.
const SEGMENTS: Segment[] = [
  // INCOMING
  { key: 'in.staking',   label: 'Staking rewards', color: '#ebc046', textColor: '#ebc046', side: 'in' }, // brand gold
  { key: 'in.TIP',       label: 'Tips received',   color: '#7cb958', textColor: '#7cb958', side: 'in' }, // muted green
  { key: 'in.RECAW',     label: 'Recaws received', color: '#a373c8', textColor: '#a373c8', side: 'in' }, // dusty violet
  { key: 'in.FOLLOW',    label: 'Follows received',color: '#e08a4a', textColor: '#e08a4a', side: 'in' }, // burnt orange
  { key: 'in.LIKE',      label: 'Likes received',  color: '#d96d72', textColor: '#d96d72', side: 'in' }, // washed rose
  { key: 'in.validator', label: 'Validator fees',  color: '#4fb3a9', textColor: '#4fb3a9', side: 'in' }, // muted teal
  // OUTGOING — same hue families, deeper + cooler shift.
  { key: 'out.CAW',      label: 'Posts',          color: '#4a78b8', textColor: '#4a78b8', side: 'out' }, // dusty cobalt
  { key: 'out.RECAW',    label: 'Recaws given',   color: '#7d5ba6', textColor: '#7d5ba6', side: 'out' }, // deeper violet
  { key: 'out.LIKE',     label: 'Likes given',    color: '#b04f56', textColor: '#b04f56', side: 'out' }, // brick rose
  { key: 'out.FOLLOW',   label: 'Follows given',  color: '#b8743a', textColor: '#b8743a', side: 'out' }, // burnt sienna
  { key: 'out.TIP',      label: 'Tips given',     color: '#5d9b6c', textColor: '#5d9b6c', side: 'out' }, // forest sage
  { key: 'out.OTHER',    label: 'Other',          color: '#7a7e85', textColor: '#7a7e85', side: 'out' }, // smoke
  { key: 'out.WITHDRAW', label: 'Withdrawals',    color: '#c89149', textColor: '#c89149', side: 'out' }, // amber
  { key: 'out.validator',label: 'Validator fees', color: '#3a8580', textColor: '#3a8580', side: 'out' }, // pine teal
]

// -----------------------------------------------------------------
// API response shape (mirrors api/routes/caw-activity.ts)
// -----------------------------------------------------------------
interface BucketIn {
  bucket: string
  rewards: {
    direct: Record<string, string>     // actionType -> wei
    directCounts?: Record<string, number> // actionType -> # events received
    validatorFees: string
    stakingRewards: string
  }
  spend: {
    base: Record<string, string>
    tips: Record<string, string>
    validatorFees: string
  }
  deposits: string
  withdrawals: string
  /** End-of-bucket post-action balance (wei). Null when there were
   *  no ledger rows in this bucket — the chart consumer carries
   *  forward from the prior bucket. */
  balance: string | null
  /** System-wide CAW distributed to all stakers in this bucket,
   *  keyed by the action type that triggered the distribution. NOT
   *  user-scoped — same value for every viewer. */
  distribution: Record<string, string>
}

interface ActivityResponse {
  interval: string
  /** Most recent CawOwnershipSnapshot.balance at-or-before window
   *  start. Drives the leftmost point of the balance line when the
   *  user has no rows inside the window. Null = no prior history. */
  balanceBeforeWindow: string | null
  summary: {
    rewards: {
      total: string
      direct: string
      validatorFees: string
      stakingRewards: string
    }
    spend: {
      total: string
      base: string
      tips: string
      validatorFees: string
    }
    deposits: string
    withdrawals: string
    net: string
    stakeShare: number
  }
  chart: BucketIn[]
}

const RANGES = [
  { key: '24h', label: '24h', days: 1, interval: 'hour' as const },
  { key: '7d',  label: '7d',  days: 7, interval: '6hour' as const },
  { key: '30d', label: '30d', days: 30, interval: 'day' as const },
  { key: '90d', label: '90d', days: 90, interval: 'day' as const },
]

interface ProfileLite { tokenId: number; username: string; displayName?: string }

// Per-bucket shape after we project the API response into chart-ready
// segments. Values are CAW (number) for chart math; rendering and
// tooltips re-format.
interface Stack {
  segments: Array<{ key: string; value: number }>
  total: number
}
interface BucketView {
  bucket: string
  in: Stack
  out: Stack
  deposits: number
  withdrawals: number
  /** End-of-bucket balance in whole CAW. Null when no ledger rows
   *  landed in this bucket; the line chart carries forward. */
  balance: number | null
}

function projectBucket(b: BucketIn): BucketView {
  const inSegments: Array<{ key: string; value: number }> = []
  // Order matters for stack appearance (bottom to top); match SEGMENTS
  // ordering on the incoming side.
  inSegments.push({ key: 'in.staking', value: weiToCaw(b.rewards.stakingRewards) })
  for (const t of ['LIKE', 'RECAW', 'FOLLOW', 'TIP']) {
    inSegments.push({ key: `in.${t}`, value: weiToCaw(b.rewards.direct[t] ?? '0') })
  }
  inSegments.push({ key: 'in.validator', value: weiToCaw(b.rewards.validatorFees) })

  const outSegments: Array<{ key: string; value: number }> = []
  for (const t of ['CAW', 'LIKE', 'RECAW', 'FOLLOW', 'TIP', 'OTHER', 'WITHDRAW']) {
    const base = weiToCaw(b.spend.base[t] ?? '0')
    const tip = weiToCaw(b.spend.tips[t] ?? '0')
    if (t === 'TIP') {
      // Tips paid: prefer the tips bucket (this is the user-tipping-
      // someone outflow). spend.base is normally 0 for TIP.
      outSegments.push({ key: 'out.TIP', value: base + tip })
    } else if (t === 'WITHDRAW') {
      outSegments.push({ key: 'out.WITHDRAW', value: base })
    } else {
      // For non-TIP non-WITHDRAW, ignore spend.tips (would only happen
      // for actions that have non-validator recipients in amounts —
      // currently only OTHER:tip, which we already remap to TIP above).
      outSegments.push({ key: `out.${t}`, value: base })
    }
  }
  outSegments.push({ key: 'out.validator', value: weiToCaw(b.spend.validatorFees) })

  return {
    bucket: b.bucket,
    in:  { segments: inSegments, total: inSegments.reduce((a, s) => a + s.value, 0) },
    out: { segments: outSegments, total: outSegments.reduce((a, s) => a + s.value, 0) },
    deposits: weiToCaw(b.deposits),
    withdrawals: weiToCaw(b.withdrawals),
    balance: b.balance != null ? weiToCaw(b.balance) : null,
  }
}

const CawActivity: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  // CAW USD price (≈ 0 while still loading; cards fall back to CAW
  // amounts when no price is available).
  const cawUsdPrice = usePriceStore(s => s.priceMap['a-hunters-dream'] ?? 0)
  const { username: routeUsername } = useParams<{ username?: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<ActivityResponse | null>(null)
  const [profile, setProfile] = useState<ProfileLite | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  const rangeKey = searchParams.get('range') || '30d'
  const range = RANGES.find(r => r.key === rangeKey) ?? RANGES[2]

  // Disabled-segment sets per side, persisted in URL. We store the
  // disabled keys as a comma-separated suffix list (e.g. "LIKE,FOLLOW")
  // — defaulting to "all enabled" means an absent param reads as no
  // segments hidden, which matches first-visit expectation.
  const disabledIn = useMemo(() => {
    const raw = searchParams.get('hideIn')
    return new Set(raw ? raw.split(',').map(s => `in.${s}`) : [])
  }, [searchParams])
  const disabledOut = useMemo(() => {
    const raw = searchParams.get('hideOut')
    return new Set(raw ? raw.split(',').map(s => `out.${s}`) : [])
  }, [searchParams])
  const toggleSegment = (segKey: string) => {
    const isIn = segKey.startsWith('in.')
    const param = isIn ? 'hideIn' : 'hideOut'
    const set = new Set(isIn ? disabledIn : disabledOut)
    if (set.has(segKey)) set.delete(segKey); else set.add(segKey)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      const suffixes = Array.from(set)
        .map(k => k.replace(/^in\.|^out\./, ''))
        .filter(Boolean)
      if (suffixes.length === 0) next.delete(param)
      else next.set(param, suffixes.join(','))
      return next
    })
  }

  // -------- Resolve viewing target --------
  const isViewingSelf = !routeUsername
  useEffect(() => {
    let cancelled = false
    if (routeUsername) {
      apiFetch<ProfileLite>(`/api/users/${routeUsername}`)
        .then(p => { if (!cancelled) setProfile(p) })
        .catch(err => {
          if (!cancelled) setError(err?.message?.includes('404') ? 'User not found' : 'Failed to load user')
        })
    } else if (activeToken?.tokenId && activeToken?.username) {
      setProfile({
        tokenId: activeToken.tokenId,
        username: activeToken.username,
        displayName: (activeToken as any).displayName,
      })
    } else {
      setProfile(null)
    }
    return () => { cancelled = true }
  }, [routeUsername, activeToken?.tokenId, activeToken?.username])

  const targetTokenId = profile?.tokenId

  useEffect(() => {
    if (!targetTokenId) {
      setLoading(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const from = new Date(Date.now() - range.days * 86400000).toISOString()
    const to = new Date().toISOString()
    const url = `/api/users/${targetTokenId}/caw-activity?interval=${range.interval}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=${encodeURIComponent(tz)}`
    apiFetch<ActivityResponse>(url)
      .then(res => { if (!cancelled) setData(res) })
      .catch(err => {
        if (cancelled) return
        const msg = err?.message || ''
        // The API returning HTML instead of JSON usually means the
        // server isn't reachable or the route isn't mounted (the SPA
        // dev-server returns index.html for unknown paths). Friendlier
        // message than the raw JSON parse error.
        if (msg.includes('Unexpected token') && msg.includes('<')) {
          setError("Couldn't reach the API. Is the server running?")
        } else {
          setError(msg || 'Failed to load activity')
        }
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [targetTokenId, range.interval, range.days])

  // -------- Project into chart-ready buckets --------
  const buckets = useMemo<BucketView[]>(
    () => (data?.chart ?? []).map(projectBucket),
    [data],
  )

  // Auto-hide segments that are entirely zero across the window (e.g.
  // validator-fees-received for non-validators). These don't appear in
  // the legend OR in the stack.
  const visibleSegmentKeys = useMemo(() => {
    const totals = new Map<string, number>()
    for (const seg of SEGMENTS) totals.set(seg.key, 0)
    for (const b of buckets) {
      for (const s of b.in.segments) totals.set(s.key, (totals.get(s.key) ?? 0) + s.value)
      for (const s of b.out.segments) totals.set(s.key, (totals.get(s.key) ?? 0) + s.value)
    }
    return new Set(
      Array.from(totals.entries())
        .filter(([, v]) => v > 0)
        .map(([k]) => k),
    )
  }, [buckets])

  const isEnabled = (segKey: string) => {
    if (!visibleSegmentKeys.has(segKey)) return false
    return segKey.startsWith('in.') ? !disabledIn.has(segKey) : !disabledOut.has(segKey)
  }

  // Per-side max bar value, factoring in toggles. Each side scales
  // independently so a heavy spender doesn't crush the rewards stack.
  const maxIn = useMemo(() => {
    let m = 0
    for (const b of buckets) {
      const sum = b.in.segments.filter(s => isEnabled(s.key)).reduce((a, s) => a + s.value, 0)
      if (sum > m) m = sum
    }
    return m || 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, disabledIn, visibleSegmentKeys])
  const maxOut = useMemo(() => {
    let m = 0
    for (const b of buckets) {
      const sum = b.out.segments.filter(s => isEnabled(s.key)).reduce((a, s) => a + s.value, 0)
      if (sum > m) m = sum
    }
    return m || 1
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buckets, disabledOut, visibleSegmentKeys])

  const cardClass = `rounded-2xl p-4 ${isDark ? 'bg-white/5 border border-white/10' : 'bg-white border border-gray-200'}`

  // Simplified summary card values (factor in the toggles when
  // computing "what the chart shows now" totals).
  const visibleRewardsTotal = useMemo(() =>
    buckets.reduce((sum, b) =>
      sum + b.in.segments.filter(s => isEnabled(s.key)).reduce((a, s) => a + s.value, 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, disabledIn, visibleSegmentKeys],
  )
  const visibleSpendTotal = useMemo(() =>
    buckets.reduce((sum, b) =>
      sum + b.out.segments.filter(s => isEnabled(s.key)).reduce((a, s) => a + s.value, 0), 0),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buckets, disabledOut, visibleSegmentKeys],
  )

  const fmtNumberCaw = (n: number): string => {
    const abs = Math.abs(n)
    if (abs === 0) return '0'
    if (abs < 1) return n.toFixed(2)
    if (abs < 1_000) return n.toFixed(0)
    if (abs < 1_000_000) return `${(n / 1_000).toFixed(1)}K`
    if (abs < 1_000_000_000) return `${(n / 1_000_000).toFixed(2)}M`
    return `${(n / 1_000_000_000).toFixed(2)}B`
  }

  // Format a CAW amount as USD (using the shared CAW price). Returns
  // null if no price is available so the caller can fall back to a
  // CAW-only display.
  const fmtUsd = (cawAmount: number, opts: { sign?: boolean } = {}): string | null => {
    if (!cawUsdPrice || cawUsdPrice <= 0) return null
    const usd = cawAmount * cawUsdPrice
    const abs = Math.abs(usd)
    const sign = opts.sign ? (usd >= 0 ? '+' : '') : ''
    if (abs === 0) return '$0.00'
    if (abs < 0.01) return `${sign}$${usd.toFixed(4)}`
    if (abs < 1_000) return `${sign}$${usd.toFixed(2)}`
    if (abs < 1_000_000) return `${sign}$${(usd / 1_000).toFixed(1)}K`
    if (abs < 1_000_000_000) return `${sign}$${(usd / 1_000_000).toFixed(2)}M`
    return `${sign}$${(usd / 1_000_000_000).toFixed(2)}B`
  }

  // Shared axis label color (hoisted so both the line chart and the bar
  // chart's IIFEs can use it without redeclaring).
  const axisLabelClass = isDark ? 'text-white/40' : 'text-gray-500'

  return (
    <MainLayout>
      <div className="max-w-3xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
              {isViewingSelf ? 'CAW Activity' : (
                <>
                  <Link to={`/users/${profile?.username ?? ''}`} className="hover:underline">
                    {profile?.displayName || profile?.username || '…'}
                  </Link>
                  <span className={isDark ? 'text-white/40 font-normal' : 'text-gray-500 font-normal'}> · CAW Activity</span>
                </>
              )}
            </h1>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
              Daily flow: rewards above, spend below. Click legend items to toggle.
            </p>
          </div>
        </div>

        {/* Time range chips */}
        <div className="flex gap-2 mb-4">
          {RANGES.map(r => (
            <button
              key={r.key}
              type="button"
              onClick={() => setSearchParams(prev => {
                const next = new URLSearchParams(prev)
                next.set('range', r.key)
                return next
              })}
              className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-colors cursor-pointer ${
                r.key === rangeKey
                  ? 'bg-yellow-500 text-black'
                  : isDark ? 'bg-white/10 text-white/70 hover:bg-white/20' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
            >
              {r.label}
            </button>
          ))}
        </div>

        {/* Count mini-charts. Half-width grid showing the number of
            incoming events per bucket for the four social action
            types. Pure counts, not CAW values — the headline chart
            below already covers value. */}
        {data && data.chart.length > 0 && (() => {
          const types = [
            { key: 'LIKE',   label: 'Likes',   color: '#d96d72' },
            { key: 'RECAW',  label: 'Recaws',  color: '#a373c8' },
            { key: 'FOLLOW', label: 'Follows', color: '#e08a4a' },
            { key: 'TIP',    label: 'Tips',    color: '#7cb958' },
          ]
          // Each type's per-bucket count series.
          const countsByType: Record<string, number[]> = {}
          let anyNonZero = false
          for (const t of types) {
            const series = data.chart.map(b => b.rewards.directCounts?.[t.key] ?? 0)
            countsByType[t.key] = series
            if (series.some(v => v > 0)) anyNonZero = true
          }
          if (!anyNonZero) return null
          return (
            <div className="grid grid-cols-2 gap-3 mb-4">
              {types.map(t => {
                const counts = countsByType[t.key]
                const total = counts.reduce((a, v) => a + v, 0)
                const max = Math.max(...counts, 1)
                const MINI_H = 40
                return (
                  <div key={t.key} className={cardClass}>
                    <div className="flex items-baseline justify-between mb-1.5">
                      <div
                        className="text-[10px] uppercase tracking-wide font-semibold"
                        style={{ color: t.color }}
                      >
                        {t.label}
                      </div>
                      <div className="text-sm font-bold tabular-nums" style={{ color: t.color }}>
                        {total.toLocaleString()}
                      </div>
                    </div>
                    <div
                      className="flex items-end gap-px"
                      style={{
                        height: MINI_H,
                        borderBottom: `1px solid ${isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.15)'}`,
                      }}
                    >
                      {counts.map((v, i) => (
                        <div
                          key={i}
                          className="flex-1"
                          style={{
                            height: `${(v / max) * 100}%`,
                            minHeight: v > 0 ? 1 : 0,
                            backgroundColor: t.color,
                            opacity: v > 0 ? 1 : 0,
                          }}
                          title={`${v.toLocaleString()} on ${new Date(data.chart[i].bucket).toLocaleDateString()}`}
                        />
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          )
        })()}

        {error && (
          <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700'}`}>
            {error}
          </div>
        )}

        {data && (() => {
          // Render a CAW-amount card with USD as the primary metric and
          // the CAW number on the secondary line. Falls back to CAW
          // primary if the price hasn't loaded yet.
          const netAmount = visibleRewardsTotal - visibleSpendTotal
          const renderCawCard = (
            label: string,
            cawAmount: number,
            color: string,
            opts: { sign?: boolean } = {},
          ) => {
            const usd = fmtUsd(cawAmount, opts)
            const cawStr =
              opts.sign && cawAmount >= 0
                ? `+${fmtNumberCaw(cawAmount)}`
                : fmtNumberCaw(cawAmount)
            return (
              <div className={`${cardClass} text-center`}>
                <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                  {label}
                </div>
                {usd ? (
                  <>
                    <div className="text-xl font-bold mt-1" style={{ color }}>{usd}</div>
                    <div className={`text-[10px] mt-0.5 tabular-nums ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                      {cawStr} CAW
                    </div>
                  </>
                ) : (
                  <>
                    <div className="text-xl font-bold mt-1" style={{ color }}>{cawStr}</div>
                    <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
                  </>
                )}
              </div>
            )
          }
          return (
          <>
            <div className="grid grid-cols-3 md:grid-cols-3 gap-3 mb-3">
              {renderCawCard('Incoming', visibleRewardsTotal, '#7cb958')}
              {renderCawCard('Outgoing', visibleSpendTotal, '#b04f56')}
              {renderCawCard(
                'Net',
                netAmount,
                netAmount >= 0 ? '#7cb958' : '#b04f56',
                { sign: true },
              )}
            </div>
            <div className="grid grid-cols-2 gap-3 mb-6">
              {renderCawCard(
                'Staking rewards',
                weiToCaw(data.summary.rewards.stakingRewards),
                '#ebc046',
              )}
              <div className={`${cardClass} text-center`}>
                <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Stake share</div>
                <div className="text-xl font-bold mt-1" style={{ color: '#ebc046' }}>
                  {(data.summary.stakeShare * 100).toFixed(3)}%
                </div>
                <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>of total CAW staked</div>
              </div>
            </div>
          </>
          )
        })()}

        {/* Balance line chart */}
        {data && buckets.length > 0 && (() => {
          // Carry-forward null buckets so the line is continuous. The
          // anchor before the window is balanceBeforeWindow (the last
          // value we knew before the window opened).
          const seed = data.balanceBeforeWindow ? weiToCaw(data.balanceBeforeWindow) : 0
          const points: number[] = []
          let last = seed
          for (const b of buckets) {
            if (b.balance != null) last = b.balance
            points.push(last)
          }
          const hasAnyBalance = points.some(p => p > 0)
          if (!hasAnyBalance) return null

          // Cumulative net of currently-visible activity. Starts at 0
          // at the window's left edge and walks forward, summing each
          // bucket's (visible incoming − visible outgoing). Reflects
          // toggles in real time — turn off LIKE and the line shifts.
          const activityPoints: number[] = []
          let activityRunning = 0
          for (const b of buckets) {
            const inSum = b.in.segments.filter(s => isEnabled(s.key)).reduce((a, s) => a + s.value, 0)
            const outSum = b.out.segments.filter(s => isEnabled(s.key)).reduce((a, s) => a + s.value, 0)
            activityRunning += inSum - outSum
            activityPoints.push(activityRunning)
          }

          // Y-range: include both the balance line AND the activity
          // line so they share a scale and the comparison is honest.
          const allValues = [...points, ...activityPoints]
          const minVal = Math.min(...allValues)
          const maxVal = Math.max(...allValues)
          const valueRange = Math.max(maxVal - minVal, 1)
          const padTop = maxVal + valueRange * 0.1
          // Allow negative padBot so a negative activity total stays
          // visible below 0 (don't clamp to 0).
          const padBot = minVal - valueRange * 0.1
          const span = padTop - padBot || 1

          const LINE_H = 120
          const padX = 4 // svg horizontal padding so end markers aren't clipped
          const yFor = (v: number): number => LINE_H - ((v - padBot) / span) * LINE_H
          const xFor = (i: number): number =>
            points.length === 1
              ? 50
              : padX + (i / (points.length - 1)) * (100 - 2 * (padX / 100) * 100)

          const pathD = points
            .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(3)} ${yFor(v).toFixed(3)}`)
            .join(' ')
          const activityPathD = activityPoints
            .map((v, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(3)} ${yFor(v).toFixed(3)}`)
            .join(' ')

          const lineColor = '#ebc046'
          const fillColor = 'rgba(235, 192, 70, 0.12)'
          const activityColor = '#a373c8' // dusty violet, matches the in.RECAW palette family
          // Closed area under the line for the soft fill.
          const areaD =
            `M ${xFor(0).toFixed(3)} ${LINE_H} ` +
            points.map((v, i) => `L ${xFor(i).toFixed(3)} ${yFor(v).toFixed(3)}`).join(' ') +
            ` L ${xFor(points.length - 1).toFixed(3)} ${LINE_H} Z`

          return (
            <div className={`${cardClass} mb-4`}>
              <div className="flex items-baseline justify-between mb-1">
                <h2 className={`text-sm font-semibold ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  Total CAW balance
                </h2>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-bold tabular-nums" style={{ color: '#ebc046' }}>
                    {fmtNumberCaw(points[points.length - 1])}
                  </span>
                  <span className={`text-[10px] ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</span>
                </div>
              </div>
              {/* Mini-legend distinguishing the two lines. */}
              <div className="flex gap-3 mb-2 text-[10px]">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block w-4 h-px" style={{ backgroundColor: lineColor, height: 2 }} />
                  <span className={isDark ? 'text-white/60' : 'text-gray-600'}>balance</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span
                    className="inline-block"
                    style={{
                      width: 16,
                      height: 0,
                      borderTop: `2px dashed ${activityColor}`,
                    }}
                  />
                  <span className={isDark ? 'text-white/60' : 'text-gray-600'}>visible activity (cumulative)</span>
                </span>
              </div>
              <div className="flex">
                {/* Y-axis labels */}
                <div
                  className="flex-shrink-0 flex flex-col justify-between text-[10px] tabular-nums select-none"
                  style={{ width: 56, height: LINE_H, paddingRight: 8 }}
                >
                  <div className={axisLabelClass} style={{ textAlign: 'right' }}>
                    {fmtNumberCaw(padTop)}
                  </div>
                  <div className={axisLabelClass} style={{ textAlign: 'right' }}>
                    {fmtNumberCaw(padBot)}
                  </div>
                </div>
                {/* Plot */}
                <div className="relative flex-1" style={{ height: LINE_H }}>
                  <svg
                    viewBox={`0 0 100 ${LINE_H}`}
                    preserveAspectRatio="none"
                    className="absolute inset-0 w-full h-full"
                  >
                    <path d={areaD} fill={fillColor} />
                    <path
                      d={pathD}
                      stroke={lineColor}
                      strokeWidth={1.5}
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                    {/* Cumulative net of currently-visible activity.
                        Reflects the bar-chart toggles in real time. */}
                    <path
                      d={activityPathD}
                      stroke={activityColor}
                      strokeWidth={1.5}
                      strokeDasharray="3 2"
                      fill="none"
                      vectorEffect="non-scaling-stroke"
                    />
                  </svg>
                  {/* Regular point markers — separate layer so circles
                      stay round despite the SVG's preserveAspectRatio=
                      none stretch. */}
                  <div className="absolute inset-0 pointer-events-none">
                    {points.map((v, i) => (
                      <div
                        key={i}
                        className="absolute rounded-full"
                        style={{
                          left: `${xFor(i)}%`,
                          top: `${yFor(v)}px`,
                          width: 5,
                          height: 5,
                          backgroundColor: lineColor,
                          transform: 'translate(-50%, -50%)',
                        }}
                      />
                    ))}
                  </div>
                  {/* Deposit + withdrawal event markers. Sit ON the
                      balance point for that bucket, slightly larger
                      and color-coded so they read as "this is what
                      caused the jump." Tooltip on hover gives the
                      amount. */}
                  <div className="absolute inset-0">
                    {buckets.map((b, i) => {
                      const events: Array<{ kind: 'deposit' | 'withdraw'; amount: number; color: string }> = []
                      if (b.deposits > 0) events.push({ kind: 'deposit', amount: b.deposits, color: '#7cb958' })
                      if (b.withdrawals > 0) events.push({ kind: 'withdraw', amount: b.withdrawals, color: '#b04f56' })
                      if (events.length === 0) return null
                      return events.map((ev, j) => (
                        <div
                          key={`${i}-${ev.kind}`}
                          className="absolute rounded-full ring-2 cursor-help group"
                          style={{
                            left: `${xFor(i)}%`,
                            top: `${yFor(points[i])}px`,
                            width: 10,
                            height: 10,
                            backgroundColor: ev.color,
                            // Stack two events on the same bucket by
                            // nudging the second one a few px up.
                            transform: `translate(-50%, calc(-50% + ${j * -12}px))`,
                            // Ring uses the card background so the
                            // marker pops off the line.
                            boxShadow: `0 0 0 2px ${isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.9)'}`,
                          }}
                        >
                          <div
                            className={`absolute left-1/2 -translate-x-1/2 -top-2 -translate-y-full whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none ${
                              isDark ? 'bg-gray-900 text-white border border-white/10' : 'bg-white text-gray-900 border border-gray-200'
                            }`}
                            style={{ zIndex: 20 }}
                          >
                            {ev.kind === 'deposit' ? '+' : '−'}{fmtNumberCaw(ev.amount)} {ev.kind}
                          </div>
                        </div>
                      ))
                    })}
                  </div>
                </div>
              </div>
              {/* X-axis labels (mirror the bar chart's). */}
              <div className="flex" style={{ paddingLeft: 56 }}>
                <div className="flex-1 flex gap-0.5 text-[10px] tabular-nums select-none">
                  {buckets.map((b, i) => (
                    <div
                      key={i}
                      className={`flex-1 text-center mt-1 ${axisLabelClass}`}
                      style={{
                        visibility:
                          i % Math.max(1, Math.ceil(buckets.length / 6)) === 0
                            ? 'visible'
                            : 'hidden',
                      }}
                    >
                      {(() => {
                        const d = new Date(b.bucket)
                        if (range.interval === 'hour') return d.toLocaleString(undefined, { hour: 'numeric' })
                        return d.toLocaleString(undefined, { month: 'short', day: 'numeric' })
                      })()}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        })()}

        {/* Chart */}
        {data && buckets.length > 0 && (() => {
          const CHART_H = 280
          const HALF_H = CHART_H / 2
          // Sparse x-axis labels: ~6 ticks across, regardless of bucket count.
          const xLabelEvery = Math.max(1, Math.ceil(buckets.length / 6))
          const fmtBucketLabel = (iso: string): string => {
            const d = new Date(iso)
            if (range.interval === 'hour') {
              return d.toLocaleString(undefined, { hour: 'numeric' })
            }
            if (range.interval === '6hour') {
              return d.toLocaleString(undefined, { month: 'short', day: 'numeric' })
            }
            return d.toLocaleString(undefined, { month: 'short', day: 'numeric' })
          }
          const gridlineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
          const midlineColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)'

          // Interior gridlines. Both sides share the SAME tick interval
          // (Δ) so a 100k bar on top is the same height as a 100k bar
          // on the bottom — the asymmetric tick density (e.g. 12 lines
          // above, 2 below) reads as the relative scale at a glance.
          //
          // Algorithm: the smaller side drives. Pick the largest
          // smaller-count where both sides have ≥1 tick and the total
          // count is ≤ 16. Δ = smaller_max / smaller_count. Larger
          // side then gets floor(larger_max / Δ) ticks.
          //
          // Worked example: maxIn = 5M, maxOut = 870K. Ratio ≈ 5.75.
          //   smaller_count = 1 → Δ = 870K → larger = 5 → total 6
          //   smaller_count = 2 → Δ = 435K → larger = 11 → total 13 ✓
          //   smaller_count = 3 → Δ = 290K → larger = 17 → total 20 ✗
          // → smaller_count = 2 wins. 11 + 2 = 13 lines.
          let inTicks: number[] = []
          let outTicks: number[] = []
          if (maxIn > 0 && maxOut > 0) {
            const smallerMax = Math.min(maxIn, maxOut)
            const largerMax = Math.max(maxIn, maxOut)
            const MAX_LINES_PER_SIDE = 30
            let smallerCount = 1
            // Walk smaller_count up while neither side exceeds the
            // per-side cap. Picks the largest smaller_count where the
            // larger side stays ≤ MAX_LINES_PER_SIDE.
            for (let c = 1; c <= MAX_LINES_PER_SIDE; c++) {
              const step = smallerMax / c
              const largerCount = Math.floor(largerMax / step)
              if (largerCount > MAX_LINES_PER_SIDE) break
              smallerCount = c
            }
            // If the very first iteration (c=1) already exceeded the
            // cap, the ratio is so extreme we can't share a step at
            // all. Fall back to "fill the larger side with the cap,
            // give the smaller side 1 line." Smaller side won't read
            // as a true ratio of the larger side, but the alternative
            // is invisible lines on the larger side.
            const step = smallerMax / smallerCount
            const inIsLarger = maxIn >= maxOut
            let inCount = inIsLarger ? Math.floor(maxIn / step) : smallerCount
            let outCount = inIsLarger ? smallerCount : Math.floor(maxOut / step)
            const ratioBlewCap = (inIsLarger ? inCount : outCount) > MAX_LINES_PER_SIDE
            if (ratioBlewCap) {
              // Larger side: distribute MAX_LINES_PER_SIDE evenly
              // across [0, max], breaking the shared-step invariant.
              if (inIsLarger) {
                inCount = MAX_LINES_PER_SIDE
                const inStep = maxIn / (MAX_LINES_PER_SIDE + 1)
                for (let i = 1; i <= inCount; i++) inTicks.push(inStep * i)
                // Smaller side keeps 1 tick at its halfway mark so
                // there's at least some y-axis reference.
                outCount = 1
                outTicks.push(maxOut / 2)
              } else {
                outCount = MAX_LINES_PER_SIDE
                const outStep = maxOut / (MAX_LINES_PER_SIDE + 1)
                for (let i = 1; i <= outCount; i++) outTicks.push(outStep * i)
                inCount = 1
                inTicks.push(maxIn / 2)
              }
            } else {
              for (let i = 1; i <= inCount; i++) {
                const v = step * i
                if (v < maxIn) inTicks.push(v)
              }
              for (let i = 1; i <= outCount; i++) {
                const v = step * i
                if (v < maxOut) outTicks.push(v)
              }
            }
          } else if (maxIn > 0) {
            // Outgoing has no data — just give incoming a few ticks.
            for (let i = 1; i <= 4; i++) inTicks.push((maxIn / 4) * i)
            inTicks = inTicks.slice(0, -1) // drop the one at maxIn
          } else if (maxOut > 0) {
            for (let i = 1; i <= 4; i++) outTicks.push((maxOut / 4) * i)
            outTicks = outTicks.slice(0, -1)
          }
          // Tick gridlines need to span the FULL half-height (so a
          // tick at value=max lands at the top edge), not the 47% bar
          // scale. Bars stay at 47% for breathing room, but the
          // gridlines paint across the whole [0, max] axis range.
          const inTickPct = (v: number): number => maxIn > 0 ? (v / maxIn) : 0
          const outTickPct = (v: number): number => maxOut > 0 ? (v / maxOut) : 0

          return (
            <div className={`${cardClass} mb-4`}>
              <h2 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                {range.interval === 'hour' ? 'Hourly' : range.interval === '6hour' ? '6-hour' : 'Daily'} CAW flow
              </h2>

              <div className="flex" onMouseLeave={() => setHoveredBar(null)}>
                {/* Y-axis labels (left gutter). Max values live at the
                    top + bottom edges; In / Out + 0 cluster on the
                    midline so the eye lands on "this is the zero
                    crossing" without searching. */}
                <div
                  className="flex-shrink-0 flex flex-col text-[10px] tabular-nums select-none"
                  style={{ width: 56, height: CHART_H }}
                >
                  <div className="relative" style={{ height: HALF_H }}>
                    {/* Max incoming at the top edge */}
                    {maxIn > 0 && (
                      <div className={`absolute right-2 top-0 ${axisLabelClass}`}>
                        +{fmtNumberCaw(maxIn)}
                      </div>
                    )}
                    {/* "In" pill, vertically centered between max and 0 */}
                    <div
                      className={`absolute left-2 font-bold uppercase tracking-wide text-[10px] ${isDark ? 'text-white' : 'text-black'}`}
                      style={{ top: '50%', transform: 'translateY(-50%)' }}
                    >
                      In
                    </div>
                    {/* 0 sits on the midline */}
                    <div className={`absolute right-2 bottom-0 translate-y-1/2 ${axisLabelClass}`}>0</div>
                  </div>
                  <div className="relative" style={{ height: HALF_H }}>
                    {/* "Out" pill, vertically centered between 0 and max */}
                    <div
                      className={`absolute left-2 font-bold uppercase tracking-wide text-[10px] ${isDark ? 'text-white' : 'text-black'}`}
                      style={{ top: '50%', transform: 'translateY(-50%)' }}
                    >
                      Out
                    </div>
                    {/* Max outgoing at the bottom edge */}
                    {maxOut > 0 && (
                      <div className={`absolute right-2 bottom-0 ${axisLabelClass}`}>
                        −{fmtNumberCaw(maxOut)}
                      </div>
                    )}
                  </div>
                </div>

                {/* Plot area */}
                <div className="relative flex-1" style={{ height: CHART_H }}>
                  {/* Top + bottom gridlines mark the max values; the
                      midline marks zero. */}
                  {maxIn > 0 && (
                    <div
                      className="absolute left-0 right-0 h-px pointer-events-none"
                      style={{ top: 0, backgroundColor: gridlineColor }}
                    />
                  )}
                  {maxOut > 0 && (
                    <div
                      className="absolute left-0 right-0 h-px pointer-events-none"
                      style={{ bottom: 0, backgroundColor: gridlineColor }}
                    />
                  )}
                  {/* Interior tick gridlines, shared step across both
                      sides. Number of ticks per side scales with the
                      side's max — a smaller side gets fewer ticks,
                      making the relative scale visible at a glance. */}
                  {inTicks.map(v => (
                    <div
                      key={`in-${v}`}
                      className="absolute left-0 right-0 h-px pointer-events-none"
                      style={{
                        top: HALF_H - HALF_H * inTickPct(v),
                        backgroundColor: gridlineColor,
                      }}
                    />
                  ))}
                  {outTicks.map(v => (
                    <div
                      key={`out-${v}`}
                      className="absolute left-0 right-0 h-px pointer-events-none"
                      style={{
                        top: HALF_H + HALF_H * outTickPct(v),
                        backgroundColor: gridlineColor,
                      }}
                    />
                  ))}
                  {/* Midline */}
                  <div
                    className="absolute left-0 right-0 h-px pointer-events-none"
                    style={{ top: HALF_H, backgroundColor: midlineColor }}
                  />

                  {/* Bars */}
                  <div className="flex items-stretch gap-0.5 absolute inset-0">
                    {buckets.map((b, i) => {
                      const inActive = b.in.segments.filter(s => isEnabled(s.key))
                      const outActive = b.out.segments.filter(s => isEnabled(s.key))
                      const inSum = inActive.reduce((a, s) => a + s.value, 0)
                      const outSum = outActive.reduce((a, s) => a + s.value, 0)
                      // Scale to 47% (not 50%) of the half-height so a
                      // max-value bar leaves a 3% gap below the top
                      // gridline; same for the bottom side. Lets the
                      // bars breathe instead of touching the lines.
                      const inPct = (inSum / maxIn) * 47
                      const outPct = (outSum / maxOut) * 47
                      const dim = hoveredBar !== null && hoveredBar !== i
                      return (
                        <div
                          key={i}
                          className="flex-1 flex flex-col cursor-pointer"
                          onMouseEnter={() => setHoveredBar(i)}
                        >
                          {/* Top half: stack incoming bottom-up */}
                          <div className="flex flex-col-reverse" style={{ height: '50%' }}>
                            {inActive.map(s => {
                              const seg = SEGMENTS.find(x => x.key === s.key)!
                              const pct = inSum > 0 ? (s.value / inSum) * inPct * 2 : 0
                              if (pct <= 0) return null
                              return (
                                <div
                                  key={s.key}
                                  className="w-full transition-opacity"
                                  style={{
                                    height: `${pct}%`,
                                    minHeight: 1,
                                    backgroundColor: seg.color,
                                    opacity: dim ? 0.4 : 1,
                                  }}
                                />
                              )
                            })}
                          </div>
                          <div style={{ height: 0 }} />
                          {/* Bottom half: stack outgoing top-down */}
                          <div className="flex flex-col" style={{ height: '50%' }}>
                            {outActive.map(s => {
                              const seg = SEGMENTS.find(x => x.key === s.key)!
                              const pct = outSum > 0 ? (s.value / outSum) * outPct * 2 : 0
                              if (pct <= 0) return null
                              return (
                                <div
                                  key={s.key}
                                  className="w-full transition-opacity"
                                  style={{
                                    height: `${pct}%`,
                                    minHeight: 1,
                                    backgroundColor: seg.color,
                                    opacity: dim ? 0.4 : 1,
                                  }}
                                />
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>

                  {/* Hover tooltip */}
                  {hoveredBar !== null && buckets[hoveredBar] && (() => {
                    const b = buckets[hoveredBar]
                    const inEntries = b.in.segments.filter(s => isEnabled(s.key) && s.value > 0)
                    const outEntries = b.out.segments.filter(s => isEnabled(s.key) && s.value > 0)
                    const inSum = inEntries.reduce((a, s) => a + s.value, 0)
                    const outSum = outEntries.reduce((a, s) => a + s.value, 0)
                    return (
                      <div
                        className={`absolute z-10 rounded-lg border p-3 text-xs shadow-lg pointer-events-none ${
                          isDark ? 'bg-gray-900 border-white/10' : 'bg-white border-gray-200'
                        }`}
                        style={{
                          top: 0,
                          left: `${Math.min(Math.max((hoveredBar / buckets.length) * 100, 5), 60)}%`,
                          minWidth: 200,
                        }}
                      >
                        <div className={`font-semibold mb-1.5 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                          {new Date(b.bucket).toLocaleString(undefined, {
                            month: 'short', day: 'numeric',
                            hour: range.interval === 'hour' || range.interval === '6hour' ? 'numeric' : undefined,
                          })}
                        </div>
                        {inEntries.length > 0 && (
                          <div className="mb-1.5">
                            <div className={`text-[10px] uppercase tracking-wide mb-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>Incoming</div>
                            {inEntries.map(s => {
                              const seg = SEGMENTS.find(x => x.key === s.key)!
                              return (
                                <div key={s.key} className="flex items-center justify-between gap-3">
                                  <span className="flex items-center gap-1.5">
                                    <span
                                      className="inline-block w-2 h-2 rounded-sm"
                                      style={{ backgroundColor: seg.color }}
                                    />
                                    <span className={isDark ? 'text-white/70' : 'text-gray-700'}>{seg.label}</span>
                                  </span>
                                  <span style={{ color: seg.textColor }}>+{fmtNumberCaw(s.value)}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        {outEntries.length > 0 && (
                          <div className="mb-1">
                            <div className={`text-[10px] uppercase tracking-wide mb-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>Outgoing</div>
                            {outEntries.map(s => {
                              const seg = SEGMENTS.find(x => x.key === s.key)!
                              return (
                                <div key={s.key} className="flex items-center justify-between gap-3">
                                  <span className="flex items-center gap-1.5">
                                    <span
                                      className="inline-block w-2 h-2 rounded-sm"
                                      style={{ backgroundColor: seg.color }}
                                    />
                                    <span className={isDark ? 'text-white/70' : 'text-gray-700'}>{seg.label}</span>
                                  </span>
                                  <span style={{ color: seg.textColor }}>−{fmtNumberCaw(s.value)}</span>
                                </div>
                              )
                            })}
                          </div>
                        )}
                        <div className={`mt-1 pt-1 border-t flex items-center justify-between ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
                          <span className={isDark ? 'text-white/60' : 'text-gray-600'}>Net</span>
                          <span
                            className="font-semibold"
                            style={{ color: inSum - outSum >= 0 ? '#7cb958' : '#b04f56' }}
                          >
                            {inSum - outSum >= 0 ? '+' : ''}{fmtNumberCaw(inSum - outSum)}
                          </span>
                        </div>
                        {(b.deposits > 0 || b.withdrawals > 0) && (
                          <div className={`mt-1 pt-1 border-t text-[10px] ${isDark ? 'border-white/10 text-white/40' : 'border-gray-200 text-gray-400'}`}>
                            {b.deposits > 0 && <div>Deposit: +{fmtNumberCaw(b.deposits)}</div>}
                            {b.withdrawals > 0 && <div>Withdraw: −{fmtNumberCaw(b.withdrawals)}</div>}
                          </div>
                        )}
                      </div>
                    )
                  })()}
                </div>
              </div>

              {/* X-axis date labels under the bars (sparse). */}
              <div className="flex" style={{ paddingLeft: 56 }}>
                <div className="flex-1 flex gap-0.5 text-[10px] tabular-nums select-none">
                  {buckets.map((b, i) => (
                    <div
                      key={i}
                      className={`flex-1 text-center mt-1 ${axisLabelClass}`}
                      style={{ visibility: i % xLabelEvery === 0 ? 'visible' : 'hidden' }}
                    >
                      {fmtBucketLabel(b.bucket)}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )
        })()}

        {/* System-wide distribution to stakers, broken down by action
            type. NOT user-scoped — answers "how much did the protocol
            pay out to all stakers" rather than "what did I get." */}
        {data && data.chart.length > 0 && (() => {
          const distTypes = [
            { key: 'CAW',    label: 'Posts',   color: '#5b7a99' },
            { key: 'LIKE',   label: 'Likes',   color: '#d96d72' },
            { key: 'RECAW',  label: 'Recaws',  color: '#a373c8' },
            { key: 'FOLLOW', label: 'Follows', color: '#e08a4a' },
          ]
          // Per-bucket totals across all action types.
          const totals = data.chart.map(b =>
            distTypes.reduce((s, t) => s + weiToCaw(b.distribution?.[t.key] ?? '0'), 0),
          )
          const max = Math.max(...totals, 0)
          if (max <= 0) return null
          // Window total per type for the header.
          const windowTotals: Record<string, number> = {}
          for (const t of distTypes) {
            windowTotals[t.key] = data.chart.reduce(
              (s, b) => s + weiToCaw(b.distribution?.[t.key] ?? '0'),
              0,
            )
          }
          const grandTotal = Object.values(windowTotals).reduce((a, v) => a + v, 0)
          const CHART_H = 140
          return (
            <div className={`${cardClass} mb-4`}>
              <div className="flex items-baseline justify-between mb-1">
                <h2 className={`text-sm font-semibold ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                  CAW distributed to stakers
                </h2>
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-bold tabular-nums" style={{ color: '#ebc046' }}>
                    {fmtNumberCaw(grandTotal)}
                  </span>
                  <span className={`text-[10px] ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW total</span>
                </div>
              </div>
              {/* Mini-legend across the top */}
              <div className="flex flex-wrap gap-3 mb-2 text-[10px]">
                {distTypes.map(t =>
                  windowTotals[t.key] > 0 ? (
                    <span key={t.key} className="flex items-center gap-1.5">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: t.color }} />
                      <span className={isDark ? 'text-white/60' : 'text-gray-600'}>
                        {t.label} <span className={isDark ? 'text-white/40' : 'text-gray-400'}>{fmtNumberCaw(windowTotals[t.key])}</span>
                      </span>
                    </span>
                  ) : null,
                )}
              </div>
              <div className="flex" onMouseLeave={() => setHoveredBar(null)}>
                {/* Y-axis */}
                <div
                  className="flex-shrink-0 flex flex-col justify-between text-[10px] tabular-nums select-none"
                  style={{ width: 56, height: CHART_H, paddingRight: 8 }}
                >
                  <div className={axisLabelClass} style={{ textAlign: 'right' }}>
                    {fmtNumberCaw(max)}
                  </div>
                  <div className={axisLabelClass} style={{ textAlign: 'right' }}>0</div>
                </div>
                {/* Plot */}
                <div className="relative flex-1" style={{ height: CHART_H }}>
                  {/* Top + bottom gridlines */}
                  <div
                    className="absolute left-0 right-0 h-px pointer-events-none"
                    style={{ top: 0, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)' }}
                  />
                  <div
                    className="absolute left-0 right-0 h-px pointer-events-none"
                    style={{ bottom: 0, backgroundColor: isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)' }}
                  />
                  <div className="flex items-stretch gap-0.5 absolute inset-0">
                    {data.chart.map((b, i) => {
                      const segments = distTypes.map(t => ({
                        key: t.key,
                        color: t.color,
                        value: weiToCaw(b.distribution?.[t.key] ?? '0'),
                      }))
                      const sum = segments.reduce((a, s) => a + s.value, 0)
                      const pct = max > 0 ? (sum / max) * 94 : 0 // 6% breathing room
                      return (
                        <div key={i} className="flex-1 flex flex-col">
                          {/* Spacer pushes the stack to the bottom of
                              the column so bars grow up from the
                              baseline. */}
                          <div style={{ flex: '1 1 auto' }} />
                          <div className="flex flex-col-reverse" style={{ height: `${pct}%` }}>
                            {segments.map(s => {
                              const segPct = sum > 0 ? (s.value / sum) * 100 : 0
                              if (segPct <= 0) return null
                              return (
                                <div
                                  key={s.key}
                                  className="w-full"
                                  style={{
                                    height: `${segPct}%`,
                                    minHeight: 1,
                                    backgroundColor: s.color,
                                  }}
                                />
                              )
                            })}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
          )
        })()}

        {/* Legend with toggles */}
        {data && buckets.length > 0 && (
          <div className={`${cardClass} mb-6`}>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {(['in', 'out'] as Side[]).map(side => {
                const segs = SEGMENTS.filter(s => s.side === side && visibleSegmentKeys.has(s.key))
                if (segs.length === 0) return null
                return (
                  <div key={side}>
                    <div className={`text-[10px] uppercase tracking-wide font-semibold mb-2 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {side === 'in' ? 'Incoming' : 'Outgoing'}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {segs.map(s => {
                        const enabled = isEnabled(s.key)
                        return (
                          <button
                            key={s.key}
                            type="button"
                            onClick={() => toggleSegment(s.key)}
                            className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium transition-all cursor-pointer ${
                              enabled
                                ? (isDark ? 'bg-white/10 text-white' : 'bg-gray-100 text-gray-800')
                                : (isDark ? 'bg-white/5 text-white/30' : 'bg-gray-50 text-gray-400')
                            }`}
                          >
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-sm transition-opacity"
                              style={{ backgroundColor: s.color, opacity: enabled ? 1 : 0.3 }}
                            />
                            {s.label}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {data && (data.summary.deposits !== '0' || data.summary.withdrawals !== '0') && (
          <div className={`${cardClass} mb-6 flex items-center justify-between`}>
            <div className={`text-xs ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              <span className="font-semibold">Bridge activity:</span>
              {' '}
              <span className={isDark ? 'text-amber-400' : 'text-amber-700'}>+{fmtCaw(data.summary.deposits)} deposited</span>
              {' · '}
              <span className={isDark ? 'text-amber-400' : 'text-amber-700'}>−{fmtCaw(data.summary.withdrawals)} withdrawn</span>
            </div>
            <div className={`text-[10px] ${isDark ? 'text-white/40' : 'text-gray-400'}`}>kept off-chart for scale</div>
          </div>
        )}

        {!loading && data && buckets.length === 0 && (
          <div className={`${cardClass} text-center py-8`}>
            <div className={isDark ? 'text-white/60' : 'text-gray-500'}>
              No activity yet in this window.
            </div>
          </div>
        )}

        {loading && !data && (
          <div className={`${cardClass} text-center py-8`}>
            <div className={isDark ? 'text-white/60' : 'text-gray-500'}>Loading…</div>
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default CawActivity
