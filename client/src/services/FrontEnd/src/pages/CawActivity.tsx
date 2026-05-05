import React, { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'

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

// Brand-aligned palette. Rewards use a warm/positive family anchored
// on the CAW yellow (#ebc046) + lime (#aceb3f, --color-primary-100);
// spend uses a cooler/desaturated family (slates + teals) so the eye
// instantly knows which side is which without reading labels. Hues
// within each side are spaced ~60° apart on the wheel for separability.
//
// Inline hex (not Tailwind classes) so the palette is definitive and
// theme-stable — Tailwind's *-500/*-600 shades shift across versions.
const SEGMENTS: Segment[] = [
  // INCOMING (rewards) — warm, on-brand. Staking rewards gets the
  // signature brand yellow because it's the headline metric.
  { key: 'in.staking',   label: 'Staking rewards', color: '#ebc046', textColor: '#ebc046', side: 'in' },
  { key: 'in.TIP',       label: 'Tips received',   color: '#aceb3f', textColor: '#aceb3f', side: 'in' },
  { key: 'in.RECAW',     label: 'Recaws received', color: '#f59e0b', textColor: '#f59e0b', side: 'in' },
  { key: 'in.FOLLOW',    label: 'Follows received',color: '#fb923c', textColor: '#fb923c', side: 'in' },
  { key: 'in.LIKE',      label: 'Likes received',  color: '#f472b6', textColor: '#f472b6', side: 'in' },
  { key: 'in.validator', label: 'Validator fees',  color: '#a3e635', textColor: '#a3e635', side: 'in' },
  // OUTGOING (spend) — cool, muted. Same hue families on the wheel as
  // their incoming counterparts where the concept matches (TIP↔TIP),
  // shifted toward blue/slate so spend reads as "cost" at a glance.
  { key: 'out.CAW',      label: 'Posts',          color: '#60a5fa', textColor: '#60a5fa', side: 'out' },
  { key: 'out.RECAW',    label: 'Recaws given',   color: '#818cf8', textColor: '#818cf8', side: 'out' },
  { key: 'out.LIKE',     label: 'Likes given',    color: '#a78bfa', textColor: '#a78bfa', side: 'out' },
  { key: 'out.FOLLOW',   label: 'Follows given',  color: '#22d3ee', textColor: '#22d3ee', side: 'out' },
  { key: 'out.TIP',      label: 'Tips given',     color: '#2dd4bf', textColor: '#2dd4bf', side: 'out' },
  { key: 'out.OTHER',    label: 'Other',          color: '#94a3b8', textColor: '#94a3b8', side: 'out' },
  { key: 'out.WITHDRAW', label: 'Withdrawals',    color: '#fb7185', textColor: '#fb7185', side: 'out' },
  { key: 'out.validator',label: 'Validator fees', color: '#0891b2', textColor: '#0891b2', side: 'out' },
]

// -----------------------------------------------------------------
// API response shape (mirrors api/routes/caw-activity.ts)
// -----------------------------------------------------------------
interface BucketIn {
  bucket: string
  rewards: {
    direct: Record<string, string>     // actionType -> wei
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
}

interface ActivityResponse {
  interval: string
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
  }
}

const CawActivity: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
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
      .catch(err => { if (!cancelled) setError(err?.message || 'Failed to load activity') })
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

  return (
    <MainLayout>
      <div className="max-w-3xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>
              {isViewingSelf ? 'CAW activity' : (
                <>
                  <Link to={`/users/${profile?.username ?? ''}`} className="hover:underline">
                    {profile?.displayName || profile?.username || '…'}
                  </Link>
                  <span className={isDark ? 'text-white/40 font-normal' : 'text-gray-500 font-normal'}> · CAW activity</span>
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

        {error && (
          <div className={`mb-4 rounded-lg px-3 py-2 text-sm ${isDark ? 'bg-red-500/10 text-red-300' : 'bg-red-50 text-red-700'}`}>
            {error}
          </div>
        )}

        {data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Incoming</div>
              <div className="text-xl font-bold mt-1" style={{ color: '#aceb3f' }}>{fmtNumberCaw(visibleRewardsTotal)}</div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
            </div>
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Outgoing</div>
              <div className="text-xl font-bold mt-1" style={{ color: '#fb7185' }}>{fmtNumberCaw(visibleSpendTotal)}</div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
            </div>
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Net</div>
              <div
                className="text-xl font-bold mt-1"
                style={{ color: visibleRewardsTotal - visibleSpendTotal >= 0 ? '#aceb3f' : '#fb7185' }}
              >
                {visibleRewardsTotal - visibleSpendTotal >= 0 ? '+' : ''}{fmtNumberCaw(visibleRewardsTotal - visibleSpendTotal)}
              </div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
            </div>
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Stake share</div>
              <div className="text-xl font-bold mt-1" style={{ color: '#ebc046' }}>
                {(data.summary.stakeShare * 100).toFixed(3)}%
              </div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>of total CAW staked</div>
            </div>
          </div>
        )}

        {/* Chart */}
        {data && buckets.length > 0 && (() => {
          const CHART_H = 280
          const HALF_H = CHART_H / 2
          // Y-axis tick: pick a round number close to 50% of the max so
          // we get one mid-line gridline per side. niceTick rounds down
          // to the nearest 1/2/5×10^n (the standard "nice number" pick).
          const niceTick = (max: number): number => {
            if (max <= 0) return 0
            const half = max / 2
            const exp = Math.floor(Math.log10(half))
            const base = Math.pow(10, exp)
            const norm = half / base
            const candidate = norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10
            return candidate * base
          }
          const inTick = niceTick(maxIn)
          const outTick = niceTick(maxOut)
          // Position from midline as a percent of the half height.
          const inTickPct = maxIn > 0 ? (inTick / maxIn) * 100 : 0
          const outTickPct = maxOut > 0 ? (outTick / maxOut) * 100 : 0
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
          const axisLabelClass = isDark ? 'text-white/40' : 'text-gray-500'
          const gridlineColor = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)'
          const midlineColor = isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)'

          return (
            <div className={`${cardClass} mb-4`}>
              <h2 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                {range.interval === 'hour' ? 'Hourly' : range.interval === '6hour' ? '6-hour' : 'Daily'} flow
              </h2>

              <div className="flex" onMouseLeave={() => setHoveredBar(null)}>
                {/* Y-axis labels (left gutter). Two halves each get one
                    mid-tick + the top/bottom edges. */}
                <div
                  className="flex-shrink-0 flex flex-col text-[10px] tabular-nums select-none"
                  style={{ width: 52, height: CHART_H }}
                >
                  <div className="relative" style={{ height: HALF_H }}>
                    <div className={`absolute right-2 top-0 -translate-y-1/2 ${axisLabelClass} font-semibold uppercase tracking-wide text-[9px]`}>
                      In
                    </div>
                    {inTick > 0 && (
                      <div
                        className={`absolute right-2 ${axisLabelClass}`}
                        style={{ bottom: `${inTickPct}%`, transform: 'translateY(50%)' }}
                      >
                        +{fmtNumberCaw(inTick)}
                      </div>
                    )}
                    <div className={`absolute right-2 bottom-0 translate-y-1/2 ${axisLabelClass}`}>0</div>
                  </div>
                  <div className="relative" style={{ height: HALF_H }}>
                    {outTick > 0 && (
                      <div
                        className={`absolute right-2 ${axisLabelClass}`}
                        style={{ top: `${outTickPct}%`, transform: 'translateY(-50%)' }}
                      >
                        −{fmtNumberCaw(outTick)}
                      </div>
                    )}
                    <div className={`absolute right-2 bottom-0 translate-y-1/2 ${axisLabelClass} font-semibold uppercase tracking-wide text-[9px]`}>
                      Out
                    </div>
                  </div>
                </div>

                {/* Plot area */}
                <div className="relative flex-1" style={{ height: CHART_H }}>
                  {/* Gridlines (in mid-tick + outline + out mid-tick) */}
                  {inTick > 0 && (
                    <div
                      className="absolute left-0 right-0 h-px pointer-events-none"
                      style={{ top: HALF_H - (HALF_H * inTickPct) / 100, backgroundColor: gridlineColor }}
                    />
                  )}
                  {outTick > 0 && (
                    <div
                      className="absolute left-0 right-0 h-px pointer-events-none"
                      style={{ top: HALF_H + (HALF_H * outTickPct) / 100, backgroundColor: gridlineColor }}
                    />
                  )}
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
                      const inPct = (inSum / maxIn) * 50
                      const outPct = (outSum / maxOut) * 50
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
                            style={{ color: inSum - outSum >= 0 ? '#aceb3f' : '#fb7185' }}
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
              <div className="flex" style={{ paddingLeft: 52 }}>
                <div className="flex-1 flex gap-0.5 text-[10px] tabular-nums select-none">
                  {buckets.map((b, i) => (
                    <div
                      key={i}
                      className={`flex-1 text-center mt-1 ${axisLabelClass}`}
                      style={{ visibility: i % xLabelEvery === 0 || i === buckets.length - 1 ? 'visible' : 'hidden' }}
                    >
                      {fmtBucketLabel(b.bucket)}
                    </div>
                  ))}
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
