import React, { useEffect, useMemo, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'

// Wei string -> CAW number for display.
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
  return `${(n / 1_000_000).toFixed(2)}M`
}

const ACTION_BADGE: Record<string, { label: string; color: string }> = {
  CAW:      { label: 'C', color: 'bg-blue-500/20 text-blue-400' },
  LIKE:     { label: 'L', color: 'bg-pink-500/20 text-pink-400' },
  RECAW:    { label: 'R', color: 'bg-purple-500/20 text-purple-400' },
  FOLLOW:   { label: 'F', color: 'bg-green-500/20 text-green-400' },
  WITHDRAW: { label: 'W', color: 'bg-yellow-500/20 text-yellow-400' },
  OTHER:    { label: 'O', color: 'bg-gray-500/20 text-gray-400' },
}

interface Bucket {
  bucket: string
  spent: string
  directEarned: string
  communalEarned: string
  deposits: string
  withdrawals: string
  net: string
  breakdown: Record<string, string>
}

interface ActivityResponse {
  interval: string
  summary: {
    totalSpent: string
    directEarned: string
    communalEarned: string
    deposits: string
    withdrawals: string
    net: string
    stakeShare: number
  }
  chart: Bucket[]
}

const RANGES = [
  { key: '24h', label: '24h', days: 1, interval: 'hour' as const },
  { key: '7d',  label: '7d',  days: 7, interval: '6hour' as const },
  { key: '30d', label: '30d', days: 30, interval: 'day' as const },
  { key: '90d', label: '90d', days: 90, interval: 'day' as const },
]

const CawActivity: React.FC = () => {
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const [searchParams, setSearchParams] = useSearchParams()
  const [data, setData] = useState<ActivityResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)

  const rangeKey = searchParams.get('range') || '30d'
  const range = RANGES.find(r => r.key === rangeKey) ?? RANGES[2]

  useEffect(() => {
    if (!activeToken?.tokenId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
    const from = new Date(Date.now() - range.days * 86400000).toISOString()
    const to = new Date().toISOString()
    const url = `/api/users/${activeToken.tokenId}/caw-activity?interval=${range.interval}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&tz=${encodeURIComponent(tz)}`
    apiFetch<ActivityResponse>(url)
      .then(res => {
        if (!cancelled) setData(res)
      })
      .catch(err => {
        if (!cancelled) setError(err?.message || 'Failed to load activity')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [activeToken?.tokenId, range.interval, range.days])

  const chart = data?.chart ?? []

  // Bar heights are normalised against max(positive | negative) across
  // the window so a single big day doesn't blow out smaller days.
  const maxBarValue = useMemo(() => {
    let max = 0
    for (const b of chart) {
      const pos = weiToCaw(b.directEarned) + weiToCaw(b.communalEarned)
      const neg = weiToCaw(b.spent)
      if (pos > max) max = pos
      if (neg > max) max = neg
    }
    return max || 1
  }, [chart])

  const cardClass = `rounded-2xl p-4 ${isDark ? 'bg-white/5 border border-white/10' : 'bg-white border border-gray-200'}`

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-black'}`}>CAW activity</h1>
            <p className={`text-xs mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-500'}`}>
              Spent, earned directly, and earned passively from your stake share.
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

        {/* Summary cards */}
        {data && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Spent</div>
              <div className="text-xl font-bold text-red-500 mt-1">{fmtCaw(data.summary.totalSpent)}</div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
            </div>
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Direct earned</div>
              <div className="text-xl font-bold text-green-500 mt-1">{fmtCaw(data.summary.directEarned)}</div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
            </div>
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Communal earned</div>
              <div className="text-xl font-bold text-yellow-500 mt-1">{fmtCaw(data.summary.communalEarned)}</div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
                {(data.summary.stakeShare * 100).toFixed(2)}% of stake
              </div>
            </div>
            <div className={cardClass}>
              <div className={`text-[10px] uppercase tracking-wide font-semibold ${isDark ? 'text-white/50' : 'text-gray-500'}`}>Net</div>
              <div className={`text-xl font-bold mt-1 ${weiToCaw(data.summary.net) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                {weiToCaw(data.summary.net) >= 0 ? '+' : ''}{fmtCaw(data.summary.net)}
              </div>
              <div className={`text-[10px] mt-0.5 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>CAW</div>
            </div>
          </div>
        )}

        {/* Chart */}
        {data && chart.length > 0 && (
          <div className={`${cardClass} mb-6`}>
            <h2 className={`text-sm font-semibold mb-3 ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
              Daily flow ({range.interval === 'hour' ? 'hourly' : range.interval === '6hour' ? '6-hour' : 'daily'})
            </h2>
            <div className="relative" onMouseLeave={() => setHoveredBar(null)}>
              {/* Bars: positive (earned) above midline, negative (spent) below */}
              <div className="flex items-stretch gap-0.5" style={{ height: 200 }}>
                {chart.map((b, i) => {
                  const direct = weiToCaw(b.directEarned)
                  const communal = weiToCaw(b.communalEarned)
                  const spent = weiToCaw(b.spent)
                  const positive = direct + communal
                  const posPct = (positive / maxBarValue) * 50 // half the height for positive
                  const negPct = (spent / maxBarValue) * 50
                  const directPct = positive > 0 ? (direct / positive) * posPct : 0
                  const communalPct = positive > 0 ? (communal / positive) * posPct : 0
                  const dim = hoveredBar !== null && hoveredBar !== i
                  return (
                    <div
                      key={i}
                      className="flex-1 flex flex-col cursor-pointer"
                      onMouseEnter={() => setHoveredBar(i)}
                    >
                      {/* Top half: positive bars stacked from baseline upward */}
                      <div className="flex flex-col-reverse" style={{ height: '50%' }}>
                        <div
                          className={`w-full bg-green-500 ${dim ? 'opacity-40' : ''} transition-opacity`}
                          style={{ height: `${directPct * 2}%`, minHeight: directPct > 0 ? 1 : 0 }}
                        />
                        <div
                          className={`w-full bg-yellow-500 ${dim ? 'opacity-40' : ''} transition-opacity`}
                          style={{ height: `${communalPct * 2}%`, minHeight: communalPct > 0 ? 1 : 0 }}
                        />
                      </div>
                      {/* Midline */}
                      <div className={`w-full h-px ${isDark ? 'bg-white/20' : 'bg-gray-300'}`} />
                      {/* Bottom half: negative bar */}
                      <div style={{ height: '50%' }}>
                        <div
                          className={`w-full bg-red-500 ${dim ? 'opacity-40' : ''} transition-opacity`}
                          style={{ height: `${negPct * 2}%`, minHeight: negPct > 0 ? 1 : 0 }}
                        />
                      </div>
                    </div>
                  )
                })}
              </div>

              {/* Hover tooltip */}
              {hoveredBar !== null && chart[hoveredBar] && (() => {
                const b = chart[hoveredBar]
                const breakdownEntries = Object.entries(b.breakdown).filter(([, v]) => weiToCaw(v) !== 0)
                return (
                  <div
                    className={`absolute z-10 rounded-lg border p-3 text-xs shadow-lg pointer-events-none ${
                      isDark ? 'bg-gray-900 border-white/10' : 'bg-white border-gray-200'
                    }`}
                    style={{
                      top: 0,
                      left: `${Math.min(Math.max((hoveredBar / chart.length) * 100, 5), 70)}%`,
                    }}
                  >
                    <div className={`font-semibold mb-1.5 ${isDark ? 'text-white' : 'text-gray-900'}`}>
                      {new Date(b.bucket).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: range.interval === 'hour' ? 'numeric' : undefined })}
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-green-500">+ {fmtCaw(b.directEarned)} direct</div>
                      <div className="text-yellow-500">+ {fmtCaw(b.communalEarned)} communal</div>
                      <div className="text-red-500">− {fmtCaw(b.spent)} spent</div>
                      <div className={`font-semibold mt-1 ${weiToCaw(b.net) >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                        Net {weiToCaw(b.net) >= 0 ? '+' : ''}{fmtCaw(b.net)} CAW
                      </div>
                      {breakdownEntries.length > 0 && (
                        <div className="flex gap-1 flex-wrap mt-1.5">
                          {breakdownEntries.map(([type]) => {
                            const badge = ACTION_BADGE[type] || ACTION_BADGE.OTHER
                            return (
                              <span key={type} className={`rounded px-1 py-0 text-[9px] font-bold leading-tight ${badge.color}`}>
                                {badge.label}
                              </span>
                            )
                          })}
                        </div>
                      )}
                    </div>
                  </div>
                )
              })()}
            </div>

            {/* Legend */}
            <div className="flex items-center gap-4 mt-3 text-[10px]">
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-green-500 inline-block" />
                <span className={isDark ? 'text-white/60' : 'text-gray-600'}>Direct</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-yellow-500 inline-block" />
                <span className={isDark ? 'text-white/60' : 'text-gray-600'}>Communal</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-sm bg-red-500 inline-block" />
                <span className={isDark ? 'text-white/60' : 'text-gray-600'}>Spent</span>
              </div>
            </div>
          </div>
        )}

        {!loading && data && chart.length === 0 && (
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
