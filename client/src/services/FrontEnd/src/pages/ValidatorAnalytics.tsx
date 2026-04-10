import React, { useState, useEffect, useCallback } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { Link, useSearchParams } from 'react-router-dom'

const BASESCAN = 'https://sepolia.basescan.org'

// Wei string → ETH number
const weiToEth = (wei: string | undefined): number => {
  if (!wei || wei === '0') return 0
  try { return Number(BigInt(wei)) / 1e18 } catch { return 0 }
}
const fmtEth = (wei: string | undefined) => weiToEth(wei).toFixed(9)
const fmtCaw = (caw: string | undefined) => {
  if (!caw || caw === '0') return '0'
  try { return Number(BigInt(caw)).toLocaleString() } catch { return '0' }
}
// USD formatting
const fmtUsd = (amount: number) => {
  if (Math.abs(amount) < 0.01 && amount !== 0) return `$${amount.toFixed(6)}`
  return `$${amount.toFixed(2)}`
}
const weiToUsd = (wei: string | undefined, ethUsd: number) => fmtUsd(weiToEth(wei) * ethUsd)
const cawToUsd = (caw: string | undefined, cawUsd: number) => {
  if (!caw || caw === '0') return '$0.00'
  try { return fmtUsd(Number(BigInt(caw)) * cawUsd) } catch { return '$0.00' }
}

const fmtDate = (d: string) => new Date(d).toLocaleString()
const truncHash = (h: string) => h ? `${h.slice(0, 6)}...${h.slice(-4)}` : ''

// Action type display config: label, color class, first-letter badge
const ACTION_TYPE_STYLE: Record<string, { label: string; color: string }> = {
  CAW:      { label: 'C', color: 'bg-blue-500/20 text-blue-400' },
  LIKE:     { label: 'L', color: 'bg-pink-500/20 text-pink-400' },
  UNLIKE:   { label: 'U', color: 'bg-gray-500/20 text-gray-400' },
  RECAW:    { label: 'R', color: 'bg-purple-500/20 text-purple-400' },
  FOLLOW:   { label: 'F', color: 'bg-green-500/20 text-green-400' },
  UNFOLLOW: { label: 'X', color: 'bg-orange-500/20 text-orange-400' },
  WITHDRAW: { label: 'W', color: 'bg-yellow-500/20 text-yellow-400' },
  OTHER:    { label: 'O', color: 'bg-gray-500/20 text-gray-400' },
}

interface Prices { ethUsd: number; cawUsd: number }

interface Summary {
  totalTransactions: number
  totalActions: number
  totalEthSpent: string
  totalCawEarned: string
  totalTipEth: string
  netProfitLoss: string
  avgWaitTime: number
  prices: Prices
}

type ActionBreakdown = Record<string, number>

interface Transaction {
  id: number
  time: string
  txHash: string
  txType: string
  actions: number
  actionBreakdown?: ActionBreakdown
  gasEth: string
  tipCaw: string
  tipEth: string
  profitEth: string
  waitSeconds: number
  status: string
  sessionUser?: string
}

interface ReplicationTx {
  id: number
  time: string
  txHash: string
  client: string
  destChain: string
  checkpoint: string
  gasCostEth: string
  lzFeeEth: string
  totalCostEth: string
}

interface ChartPoint {
  date: string
  dateKey?: string // ISO date key e.g. '2026-03-25' (for daily chart click-through)
  profit: number
  txCount: number
  actionCount: number
  ethCost: number
  tipEth: number
  actionBreakdown: Record<string, number>
}

type TimeRange = '24h' | '7d' | '30d' | '90d' | 'custom'

/** Local YYYY-MM-DD from a Date (avoids UTC shift from toISOString) */
const localDateKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** Create a Date from a local YYYY-MM-DD at start of local day */
const dateFromKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function getRange(range: TimeRange, customFrom: string, customTo: string): { from: string; to: string } {
  const now = new Date()
  // End of today in local time
  const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  const to = customTo || endOfToday.toISOString()
  if (range === 'custom') return { from: customFrom, to }
  // Start of the range day at local midnight
  const days: Record<string, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 }
  const startDate = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days[range] - 1), 0, 0, 0, 0)
  return { from: startDate.toISOString(), to }
}

const ValidatorAnalytics: React.FC = () => {
  const { isDark } = useTheme()
  const [searchParams, setSearchParams] = useSearchParams()

  // Data state — initialize from URL params for persistence across refreshes
  const validRanges: TimeRange[] = ['24h', '7d', '30d', '90d', 'custom']
  const initialRange = validRanges.includes(searchParams.get('range') as TimeRange)
    ? (searchParams.get('range') as TimeRange) : '7d'
  const [timeRange, setTimeRangeState] = useState<TimeRange>(initialRange)
  const [customFrom, setCustomFrom] = useState(searchParams.get('from') || '')
  const [customTo, setCustomTo] = useState(searchParams.get('to') || '')
  const [summary, setSummary] = useState<Summary | null>(null)
  const [transactions, setTransactions] = useState<Transaction[]>([])
  const [txTotal, setTxTotal] = useState(0)
  const [txOffset, setTxOffset] = useState(0)
  const [replication, setReplication] = useState<ReplicationTx[]>([])
  const [repTotal, setRepTotal] = useState(0)
  const [repOffset, setRepOffset] = useState(0)
  const [chartData, setChartData] = useState<ChartPoint[]>([])
  const [hoveredBar, setHoveredBar] = useState<number | null>(null)
  const [selectedDay, setSelectedDayState] = useState<string | null>(searchParams.get('day') || null)
  const [hourlyData, setHourlyData] = useState<ChartPoint[]>([])
  const [hoveredHourBar, setHoveredHourBar] = useState<number | null>(null)
  const [hourlyLoading, setHourlyLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [activeTab, setActiveTab] = useState<'transactions' | 'replication'>('transactions')

  // URL-syncing wrappers
  const setTimeRange = useCallback((r: TimeRange) => {
    setTimeRangeState(r)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.set('range', r)
      next.delete('day') // clear drill-down when changing range
      return next
    }, { replace: true })
    setSelectedDayState(null)
    setHourlyData([])
  }, [setSearchParams])

  const setSelectedDay = useCallback((day: string | null) => {
    setSelectedDayState(day)
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      if (day) next.set('day', day)
      else next.delete('day')
      return next
    }, { replace: true })
  }, [setSearchParams])

  const PAGE_SIZE = 50

  const fetchData = useCallback(async () => {
    setLoading(true)
    setError('')
    const { from, to } = getRange(timeRange, customFrom, customTo)
    const params = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
    // Adaptive chart interval: aim for 24+ bars
    const chartInterval = timeRange === '24h' ? 'hour' : timeRange === '7d' ? '6hour' : 'day'
    try {
      const [summaryData, txData, repData, chartRes] = await Promise.all([
        apiFetch(`/api/validator-analytics/summary?${params}`),
        apiFetch(`/api/validator-analytics/transactions?${params}&limit=${PAGE_SIZE}&offset=${txOffset}`),
        apiFetch(`/api/validator-analytics/replication?${params}&limit=${PAGE_SIZE}&offset=${repOffset}`),
        apiFetch(`/api/validator-analytics/chart?${params}&interval=${chartInterval}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`)
      ])
      // Map API response to frontend interface
      setSummary({
        totalTransactions: summaryData.transactions || 0,
        totalActions: summaryData.totalActions || 0,
        totalEthSpent: summaryData.totalEthCost || '0',
        totalCawEarned: summaryData.totalTipCaw || '0',
        totalTipEth: summaryData.totalTipEth || '0',
        netProfitLoss: summaryData.totalProfit || '0',
        avgWaitTime: (summaryData.avgWaitMs || 0) / 1000,
        prices: summaryData.prices || { ethUsd: 0, cawUsd: 0 },
      })
      setTransactions((txData.transactions || []).map((t: any) => ({
        id: t.id,
        time: t.createdAt,
        txHash: t.txHash,
        txType: t.txType || 'processActions',
        actions: t.actionCount,
        actionBreakdown: t.actionBreakdown || undefined,
        gasEth: t.ethCost || '0',
        tipCaw: t.tipCaw || '0',
        tipEth: t.tipEthValue || '0',
        profitEth: t.profit || '0',
        waitSeconds: (t.avgWaitMs || 0) / 1000,
        status: t.status,
        sessionUser: t.sessionUser || undefined,
      })))
      setTxTotal(txData.total || 0)
      setReplication((repData.transactions || []).map((t: any) => ({
        id: t.id,
        time: t.createdAt,
        txHash: t.txHash,
        client: String(t.clientId),
        destChain: String(t.destEid),
        checkpoint: String(t.checkpointId),
        gasCostEth: t.ethCost || '0',
        lzFeeEth: t.lzFee || '0',
        totalCostEth: t.totalCost || '0',
      })))
      setRepTotal(repData.total || 0)
      // Build padded chart using local dates
      const emptyPoint: Omit<ChartPoint, 'date'> = { profit: 0, txCount: 0, actionCount: 0, ethCost: 0, tipEth: 0, actionBreakdown: {} }

      // Parse raw chart data — bucket_str is timezone-naive local time (e.g. '2026-03-25T14:00:00')
      const rawChart = (chartRes.chart || []).map((p: any) => {
        const timeStr = String(p.time) // e.g. '2026-03-25T14:00:00'
        const dateKey = timeStr.slice(0, 10) // '2026-03-25'
        const hourKey = timeStr.slice(0, 13)  // '2026-03-25T14'
        const hh = timeStr.slice(11, 13)
        const hhNum = parseInt(hh, 10)
        let label: string
        if (chartInterval === 'hour') {
          label = `${hh}:00 – ${String(hhNum + 1).padStart(2, '0')}:00`
        } else if (chartInterval === '6hour') {
          const endHh = String(hhNum + 6).padStart(2, '0')
          label = `${dateKey.slice(5)} ${hh}:00 – ${endHh}:00`
        } else {
          label = dateFromKey(dateKey).toLocaleDateString()
        }
        return {
          dateKey,
          hourKey,
          date: label,
          profit: Number(p.profit || 0) / 1e18,
          txCount: Number(p.txCount || 0),
          actionCount: Number(p.actionCount || 0),
          ethCost: Number(p.ethCost || 0) / 1e18,
          tipEth: Number(p.tipEth || 0) / 1e18,
          actionBreakdown: p.actionBreakdown || {},
        }
      })

      if (chartInterval === 'day') {
        // Daily chart: pad to minimum 14 days
        const dataByDate = new Map<string, ChartPoint>(rawChart.map((p: any) => [p.dateKey, p]))
        const MIN_CHART_DAYS = 14
        const today = new Date()
        const endKey = localDateKey(today)
        const rangeStart = dateFromKey(getRange(timeRange, customFrom, customTo).from.slice(0, 10))
        const minStart = new Date(today.getFullYear(), today.getMonth(), today.getDate() - (MIN_CHART_DAYS - 1))
        const startDate = rangeStart < minStart ? rangeStart : minStart
        const paddedChart: ChartPoint[] = []
        const cursor = new Date(startDate)
        const endDateLocal = dateFromKey(endKey)
        while (cursor <= endDateLocal) {
          const key = localDateKey(cursor)
          const existing = dataByDate.get(key)
          paddedChart.push(existing
            ? { ...existing, dateKey: key }
            : { date: cursor.toLocaleDateString(), dateKey: key, ...emptyPoint })
          cursor.setDate(cursor.getDate() + 1)
        }
        setChartData(paddedChart)
      } else {
        // Sub-day intervals (hour, 6hour): pad all slots in the range
        const stepHours = chartInterval === 'hour' ? 1 : 6
        const dataByKey = new Map<string, ChartPoint>(rawChart.map((p: any) => [p.hourKey, p]))
        // Use local time for padding — from/to were already local-time boundaries
        const rangeFrom = new Date(from)
        const rangeTo = new Date(to)
        const paddedChart: ChartPoint[] = []
        // Start at the beginning of the first step in local time
        const startHour = Math.floor(rangeFrom.getHours() / stepHours) * stepHours
        const cursor = new Date(rangeFrom.getFullYear(), rangeFrom.getMonth(), rangeFrom.getDate(), startHour)
        while (cursor <= rangeTo) {
          // Build key matching the API's timezone-naive format: YYYY-MM-DDThh
          const dk = localDateKey(cursor)
          const hh = String(cursor.getHours()).padStart(2, '0')
          const key = `${dk}T${hh}` // e.g. '2026-03-25T06'
          const existing = dataByKey.get(key)
          if (existing) {
            paddedChart.push({ ...existing, dateKey: dk })
          } else {
            const hhNum = cursor.getHours()
            const endHh = String(hhNum + stepHours).padStart(2, '0')
            const label = chartInterval === 'hour'
              ? `${hh}:00 – ${endHh}:00`
              : `${dk.slice(5)} ${hh}:00 – ${endHh}:00`
            paddedChart.push({ date: label, dateKey: dk, ...emptyPoint })
          }
          cursor.setTime(cursor.getTime() + stepHours * 3600000)
        }
        setChartData(paddedChart)
      }
    } catch {
      setError('Failed to load data')
    } finally {
      setLoading(false)
    }
  }, [timeRange, customFrom, customTo, txOffset, repOffset])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  // If page loads with a day in the URL, fetch hourly data for it
  useEffect(() => {
    if (selectedDay) {
      fetchHourlyData(selectedDay)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []) // Only on mount

  // Fetch hourly chart data for a selected day
  const fetchHourlyData = useCallback(async (dateKey: string) => {
    setHourlyLoading(true)
    // Use local timezone boundaries for the selected day
    const [year, month, day] = dateKey.split('-').map(Number)
    const localStart = new Date(year, month - 1, day, 0, 0, 0, 0)
    const localEnd = new Date(year, month - 1, day, 23, 59, 59, 999)
    const dayStart = localStart.toISOString()
    const dayEnd = localEnd.toISOString()
    const params = `from=${encodeURIComponent(dayStart)}&to=${encodeURIComponent(dayEnd)}`
    try {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
      const [chartRes, txData] = await Promise.all([
        apiFetch(`/api/validator-analytics/chart?${params}&interval=hour&tz=${encodeURIComponent(tz)}`),
        apiFetch(`/api/validator-analytics/transactions?${params}&limit=${PAGE_SIZE}&offset=0`),
      ])
      // Build 24-hour padded chart using local hours
      const emptyPoint: Omit<ChartPoint, 'date'> = { profit: 0, txCount: 0, actionCount: 0, ethCost: 0, tipEth: 0, actionBreakdown: {} }
      const rawHourly = (chartRes.chart || []).map((p: any) => {
        // bucket_str is timezone-naive local time (e.g. '2026-03-25T14:00:00')
        const timeStr = String(p.time)
        const bucketHour = parseInt(timeStr.slice(11, 13), 10)
        return {
          hour: bucketHour,
          date: `${bucketHour.toString().padStart(2, '0')}:00 – ${String(bucketHour + 1).padStart(2, '0')}:00`,
          profit: Number(p.profit || 0) / 1e18,
          txCount: Number(p.txCount || 0),
          actionCount: Number(p.actionCount || 0),
          ethCost: Number(p.ethCost || 0) / 1e18,
          tipEth: Number(p.tipEth || 0) / 1e18,
          actionBreakdown: p.actionBreakdown || {},
        }
      })
      const hourMap = new Map(rawHourly.map((p: any) => [p.hour, p]))
      const padded: ChartPoint[] = []
      for (let h = 0; h < 24; h++) {
        const existing = hourMap.get(h)
        if (existing) {
          padded.push(existing)
        } else {
          const label = `${h.toString().padStart(2, '0')}:00 – ${String(h + 1).padStart(2, '0')}:00`
          padded.push({ ...emptyPoint, date: label })
        }
      }
      setHourlyData(padded)
      // Update transaction list to show this day's transactions
      setTransactions((txData.transactions || []).map((t: any) => ({
        id: t.id,
        time: t.createdAt,
        txHash: t.txHash,
        txType: t.txType || 'processActions',
        actions: t.actionCount,
        actionBreakdown: t.actionBreakdown || undefined,
        gasEth: t.ethCost || '0',
        tipCaw: t.tipCaw || '0',
        tipEth: t.tipEthValue || '0',
        profitEth: t.profit || '0',
        waitSeconds: (t.avgWaitMs || 0) / 1000,
        status: t.status,
        sessionUser: t.sessionUser || undefined,
      })))
      setTxTotal(txData.total || 0)
      setTxOffset(0)
      setActiveTab('transactions')
    } catch (err) {
      console.error('Failed to fetch hourly data:', err)
    } finally {
      setHourlyLoading(false)
    }
  }, [])

  const handleBarClick = (i: number) => {
    const point = chartData[i]
    if (!point?.dateKey) return
    setSelectedDay(point.dateKey)
    fetchHourlyData(point.dateKey)
  }

  const clearDaySelection = () => {
    setSelectedDay(null)
    setHourlyData([])
    setHoveredHourBar(null)
    fetchData() // Re-fetch original data
  }

  const cardClass = `rounded-xl border p-4 ${isDark ? 'border-white/10 bg-white/5' : 'border-gray-200 bg-white'}`
  const labelClass = `text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`
  const valueClass = `text-lg font-bold ${isDark ? 'text-white' : 'text-gray-900'}`
  const subClass = `text-xs mt-1 ${isDark ? 'text-white/30' : 'text-gray-400'}`

  const maxProfit = chartData.length > 0
    ? Math.max(...chartData.map(p => Math.abs(p.profit)), 0.000001)
    : 1

  const profitIsNegative = summary?.netProfitLoss ? BigInt(summary.netProfitLoss) < 0n : false

  return (
    <div className={`min-h-screen p-6 ${isDark ? 'bg-black text-white' : 'bg-gray-50 text-gray-900'}`}>
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
          <div className="flex items-center gap-3">
            <Link to="/admin" className={`text-sm ${isDark ? 'text-white/40 hover:text-white/60' : 'text-gray-400 hover:text-gray-600'}`}>Admin</Link>
            <span className={isDark ? 'text-white/20' : 'text-gray-300'}>/</span>
            <h1 className="text-2xl font-bold">Validator Analytics</h1>
          </div>
          <Link
            to="/admin/validator/settings"
            className="px-4 py-2 text-sm bg-blue-500 text-white rounded-lg hover:bg-blue-600 transition-colors"
          >
            Settings
          </Link>
        </div>

        {/* Time Range Picker */}
        <div className="flex items-center gap-2 mb-6 flex-wrap">
          {(['24h', '7d', '30d', '90d', 'custom'] as TimeRange[]).map(r => (
            <button
              key={r}
              onClick={() => { setTimeRange(r); setTxOffset(0); setRepOffset(0) }}
              className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                timeRange === r
                  ? 'bg-blue-500 text-white'
                  : isDark ? 'bg-white/10 text-white/60 hover:bg-white/20' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
              }`}
            >
              {r}
            </button>
          ))}
          {timeRange === 'custom' && (
            <div className="flex items-center gap-2 ml-2">
              <input
                type="date"
                value={customFrom}
                onChange={e => setCustomFrom(e.target.value)}
                className={`px-2 py-1 rounded text-xs border ${
                  isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-white border-gray-200 text-gray-900'
                }`}
              />
              <span className={`text-xs ${isDark ? 'text-white/40' : 'text-gray-400'}`}>to</span>
              <input
                type="date"
                value={customTo}
                onChange={e => setCustomTo(e.target.value)}
                className={`px-2 py-1 rounded text-xs border ${
                  isDark ? 'bg-white/5 border-white/10 text-white' : 'bg-white border-gray-200 text-gray-900'
                }`}
              />
            </div>
          )}
        </div>

        {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
        {loading && <p className={`mb-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>Loading...</p>}

        {/* Summary Cards */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className={cardClass}>
              <div className={labelClass}>Total Transactions</div>
              <div className={valueClass}>{summary.totalTransactions}</div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Total Actions</div>
              <div className={valueClass}>{summary.totalActions}</div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Gas Spent</div>
              <div className={valueClass}>{weiToUsd(summary.totalEthSpent, summary.prices.ethUsd)}</div>
              <div className={subClass}>{fmtEth(summary.totalEthSpent)} ETH</div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Tips Earned</div>
              <div className={valueClass}>{cawToUsd(summary.totalCawEarned, summary.prices.cawUsd)}</div>
              <div className={subClass}>{fmtCaw(summary.totalCawEarned)} CAW</div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Net Profit/Loss</div>
              <div className={`text-lg font-bold ${profitIsNegative ? 'text-red-500' : 'text-green-500'}`}>
                {weiToUsd(summary.netProfitLoss, summary.prices.ethUsd)}
              </div>
              <div className={subClass}>{fmtEth(summary.netProfitLoss)} ETH</div>
            </div>
            <div className={cardClass}>
              <div className={labelClass}>Avg Wait Time</div>
              <div className={valueClass}>{summary.avgWaitTime.toFixed(1)}s</div>
            </div>
          </div>
        )}

        {/* Daily Profit Chart */}
        {chartData.length > 0 && (
          <div className={`${cardClass} mb-6`}>
            <div className="flex items-center justify-between mb-4">
              <h2 className={`text-sm font-semibold ${isDark ? 'text-white/60' : 'text-gray-500'}`}>
                {selectedDay
                  ? `Hourly Breakdown — ${new Date(selectedDay + 'T00:00:00').toLocaleDateString()}`
                  : `Profit (ETH) — ${timeRange === '24h' ? 'Hourly' : timeRange === '7d' ? '6-Hour' : 'Daily'}`}
              </h2>
              {selectedDay && (
                <button
                  onClick={clearDaySelection}
                  className={`px-3 py-1 text-xs rounded-full transition-colors cursor-pointer ${
                    isDark ? 'bg-white/10 text-white/60 hover:bg-white/20' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
                  }`}
                >
                  ← Back to daily
                </button>
              )}
            </div>

            {/* Daily chart (when no day selected) */}
            {!selectedDay && (
              <div className="relative" onMouseLeave={() => setHoveredBar(null)}>
                <div className="flex items-end gap-1" style={{ height: 160 }}>
                  {chartData.map((point, i) => {
                    const isPositive = point.profit >= 0
                    const height = Math.max((Math.abs(point.profit) / maxProfit) * 100, 2)
                    return (
                      <div
                        key={i}
                        className="flex-1 flex flex-col items-center justify-end cursor-pointer"
                        style={{ height: '100%' }}
                        onMouseEnter={() => setHoveredBar(i)}
                        onClick={() => handleBarClick(i)}
                      >
                        <div
                          className={`w-full rounded-t transition-opacity ${isPositive ? 'bg-green-500' : 'bg-red-500'} ${hoveredBar !== null && hoveredBar !== i ? 'opacity-40' : ''}`}
                          style={{ height: `${height}%`, minHeight: 2 }}
                        />
                      </div>
                    )
                  })}
                </div>
                {/* Hover tooltip */}
                {hoveredBar !== null && chartData[hoveredBar] && (() => {
                  const p = chartData[hoveredBar]
                  const prices = summary?.prices || { ethUsd: 0, cawUsd: 0 }
                  const breakdownEntries = Object.entries(p.actionBreakdown)
                  return (
                    <div
                      className={`absolute z-10 rounded-lg border p-3 text-xs shadow-lg pointer-events-none ${
                        isDark ? 'bg-gray-900 border-white/10' : 'bg-white border-gray-200'
                      }`}
                      style={{
                        top: 0,
                        left: `${Math.min(Math.max((hoveredBar / chartData.length) * 100, 10), 75)}%`,
                      }}
                    >
                      <div className={`font-semibold mb-1.5 ${isDark ? 'text-white' : 'text-gray-900'}`}>{p.date}</div>
                      <div className="space-y-1">
                        <div className={isDark ? 'text-white/60' : 'text-gray-500'}>
                          {p.txCount} tx &middot; {p.actionCount} actions
                        </div>
                        {breakdownEntries.length > 0 && (
                          <div className="flex gap-1 flex-wrap">
                            {breakdownEntries.map(([type, count]) => {
                              const style = ACTION_TYPE_STYLE[type] || ACTION_TYPE_STYLE.OTHER
                              return (
                                <span key={type} className={`rounded px-1 py-0 text-[9px] font-bold leading-tight ${style.color}`}>
                                  {style.label}{count > 1 ? count : ''}
                                </span>
                              )
                            })}
                          </div>
                        )}
                        <div className={isDark ? 'text-white/40' : 'text-gray-400'}>
                          Gas: {p.ethCost.toFixed(6)} ETH ({fmtUsd(p.ethCost * prices.ethUsd)})
                        </div>
                        <div className={isDark ? 'text-white/40' : 'text-gray-400'}>
                          Tips: {p.tipEth.toFixed(6)} ETH ({fmtUsd(p.tipEth * prices.ethUsd)})
                        </div>
                        <div className={`font-semibold ${p.profit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                          Net: {p.profit.toFixed(6)} ETH ({fmtUsd(p.profit * prices.ethUsd)})
                        </div>
                      </div>
                      <div className={`mt-1.5 text-[9px] ${isDark ? 'text-white/20' : 'text-gray-300'}`}>
                        Click to drill down
                      </div>
                    </div>
                  )
                })()}
                <div className="flex justify-between mt-2">
                  <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                    {chartData[0]?.date}
                  </span>
                  <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                    {chartData[chartData.length - 1]?.date}
                  </span>
                </div>
              </div>
            )}

            {/* Hourly chart (when a day is selected) */}
            {selectedDay && (
              hourlyLoading ? (
                <p className={`text-sm ${isDark ? 'text-white/40' : 'text-gray-400'}`}>Loading hourly data...</p>
              ) : (
                <div className="relative" onMouseLeave={() => setHoveredHourBar(null)}>
                  <div className="flex items-end gap-0.5" style={{ height: 160 }}>
                    {hourlyData.map((point, i) => {
                      const maxHourProfit = Math.max(...hourlyData.map(p => Math.abs(p.profit)), 0.000001)
                      const isPositive = point.profit >= 0
                      const height = Math.max((Math.abs(point.profit) / maxHourProfit) * 100, 2)
                      return (
                        <div
                          key={i}
                          className="flex-1 flex flex-col items-center justify-end cursor-pointer"
                          style={{ height: '100%' }}
                          onMouseEnter={() => setHoveredHourBar(i)}
                        >
                          <div
                            className={`w-full rounded-t transition-opacity ${isPositive ? 'bg-blue-500' : 'bg-red-500'} ${hoveredHourBar !== null && hoveredHourBar !== i ? 'opacity-40' : ''}`}
                            style={{ height: `${height}%`, minHeight: 2 }}
                          />
                        </div>
                      )
                    })}
                  </div>
                  {/* Hourly hover tooltip */}
                  {hoveredHourBar !== null && hourlyData[hoveredHourBar] && (() => {
                    const p = hourlyData[hoveredHourBar]
                    const prices = summary?.prices || { ethUsd: 0, cawUsd: 0 }
                    const breakdownEntries = Object.entries(p.actionBreakdown)
                    return (
                      <div
                        className={`absolute z-10 rounded-lg border p-3 text-xs shadow-lg pointer-events-none ${
                          isDark ? 'bg-gray-900 border-white/10' : 'bg-white border-gray-200'
                        }`}
                        style={{
                          top: 0,
                          left: `${Math.min(Math.max((hoveredHourBar / 24) * 100, 10), 75)}%`,
                        }}
                      >
                        <div className={`font-semibold mb-1.5 ${isDark ? 'text-white' : 'text-gray-900'}`}>{p.date}</div>
                        <div className="space-y-1">
                          <div className={isDark ? 'text-white/60' : 'text-gray-500'}>
                            {p.txCount} tx &middot; {p.actionCount} actions
                          </div>
                          {breakdownEntries.length > 0 && (
                            <div className="flex gap-1 flex-wrap">
                              {breakdownEntries.map(([type, count]) => {
                                const style = ACTION_TYPE_STYLE[type] || ACTION_TYPE_STYLE.OTHER
                                return (
                                  <span key={type} className={`rounded px-1 py-0 text-[9px] font-bold leading-tight ${style.color}`}>
                                    {style.label}{count > 1 ? count : ''}
                                  </span>
                                )
                              })}
                            </div>
                          )}
                          <div className={isDark ? 'text-white/40' : 'text-gray-400'}>
                            Gas: {p.ethCost.toFixed(6)} ETH ({fmtUsd(p.ethCost * prices.ethUsd)})
                          </div>
                          <div className={isDark ? 'text-white/40' : 'text-gray-400'}>
                            Tips: {p.tipEth.toFixed(6)} ETH ({fmtUsd(p.tipEth * prices.ethUsd)})
                          </div>
                          <div className={`font-semibold ${p.profit >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            Net: {p.profit.toFixed(6)} ETH ({fmtUsd(p.profit * prices.ethUsd)})
                          </div>
                        </div>
                      </div>
                    )
                  })()}
                  <div className="flex justify-between mt-2">
                    <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>00:00</span>
                    <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>06:00</span>
                    <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>12:00</span>
                    <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>18:00</span>
                    <span className={`text-[10px] ${isDark ? 'text-white/30' : 'text-gray-400'}`}>23:00</span>
                  </div>
                </div>
              )
            )}
          </div>
        )}

        {/* Action Type Legend */}
        <div className={`flex flex-wrap gap-x-4 gap-y-1 mb-4 text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
          {Object.entries(ACTION_TYPE_STYLE).map(([type, style]) => (
            <div key={type} className="flex items-center gap-1">
              <span className={`inline-flex items-center justify-center rounded px-1 py-0 text-[9px] font-bold leading-tight ${style.color}`}>
                {style.label}
              </span>
              <span className="capitalize">{type.toLowerCase()}</span>
            </div>
          ))}
        </div>

        {/* Tab Selector */}
        <div className="flex gap-2 mb-4">
          {(['transactions', 'replication'] as const).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-4 py-2 text-sm rounded-lg transition-colors cursor-pointer ${
                activeTab === tab
                  ? 'bg-blue-500 text-white'
                  : isDark ? 'bg-white/10 text-white/60 hover:bg-white/20' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'
              }`}
            >
              {tab === 'transactions'
                ? `Transactions (${txTotal})${selectedDay ? ` — ${new Date(selectedDay + 'T00:00:00').toLocaleDateString()}` : ''}`
                : `Replication (${repTotal})`}
            </button>
          ))}
        </div>

        {/* Transactions Table */}
        {activeTab === 'transactions' && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full text-xs">
              <thead>
                <tr className={isDark ? 'text-white/40' : 'text-gray-400'}>
                  <th className="text-left p-2">Time</th>
                  <th className="text-left p-2">Type</th>
                  <th className="text-left p-2">Tx Hash</th>
                  <th className="text-right p-2">Actions</th>
                  <th className="text-left p-2">Breakdown</th>
                  <th className="text-right p-2">Gas</th>
                  <th className="text-right p-2">Gas/Action</th>
                  <th className="text-right p-2">Tip</th>
                  <th className="text-right p-2">Profit</th>
                  <th className="text-right p-2">Wait</th>
                  <th className="text-left p-2">Status</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map(tx => {
                  const p = summary?.prices || { ethUsd: 0, cawUsd: 0 }
                  const profitNeg = tx.profitEth && BigInt(tx.profitEth) < 0n
                  return (
                    <tr
                      key={tx.id}
                      className={`border-t ${isDark ? 'border-white/5' : 'border-gray-100'}`}
                    >
                      <td className="p-2 whitespace-nowrap">{fmtDate(tx.time)}</td>
                      <td className="p-2">
                        <span className={`px-1.5 py-0.5 rounded text-[9px] font-medium ${
                          tx.txType === 'sessionRegister' ? 'bg-cyan-500/20 text-cyan-400' :
                          tx.txType === 'sessionRevoke' ? 'bg-orange-500/20 text-orange-400' :
                          isDark ? 'bg-white/10 text-white/50' : 'bg-gray-100 text-gray-500'
                        }`}>
                          {tx.txType === 'sessionRegister' ? 'Session' :
                           tx.txType === 'sessionRevoke' ? 'Revoke' : 'Actions'}
                        </span>
                      </td>
                      <td className="p-2">
                        <a
                          href={`${BASESCAN}/tx/${tx.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-500 hover:underline font-mono"
                        >
                          {truncHash(tx.txHash)}
                        </a>
                      </td>
                      <td className="p-2 text-right">{tx.actions || '—'}</td>
                      <td className="p-2">
                        {tx.actionBreakdown ? (
                          <div className="flex gap-0.5 flex-wrap">
                            {Object.entries(tx.actionBreakdown).map(([type, count]) => {
                              const style = ACTION_TYPE_STYLE[type] || ACTION_TYPE_STYLE.OTHER
                              return (
                                <span
                                  key={type}
                                  title={`${type}: ${count}`}
                                  className={`inline-flex items-center justify-center rounded px-1 py-0 text-[9px] font-bold leading-tight ${style.color}`}
                                >
                                  {style.label}{count > 1 ? count : ''}
                                </span>
                              )
                            })}
                          </div>
                        ) : (
                          <span className={isDark ? 'text-white/20' : 'text-gray-300'}>—</span>
                        )}
                      </td>
                      <td className="p-2 text-right font-mono" title={`${fmtEth(tx.gasEth)} ETH`}>
                        {weiToUsd(tx.gasEth, p.ethUsd)}
                      </td>
                      <td className="p-2 text-right font-mono" title={tx.actions > 0 ? `${fmtEth((BigInt(tx.gasEth || '0') / BigInt(tx.actions)).toString())} ETH/action` : ''}>
                        {tx.actions > 0
                          ? weiToUsd((BigInt(tx.gasEth || '0') / BigInt(tx.actions)).toString(), p.ethUsd)
                          : '—'}
                      </td>
                      <td className="p-2 text-right font-mono" title={`${fmtCaw(tx.tipCaw)} CAW`}>
                        {cawToUsd(tx.tipCaw, p.cawUsd)}
                      </td>
                      <td className={`p-2 text-right font-mono ${profitNeg ? 'text-red-500' : 'text-green-500'}`} title={`${fmtEth(tx.profitEth)} ETH`}>
                        {weiToUsd(tx.profitEth, p.ethUsd)}
                      </td>
                      <td className="p-2 text-right">{tx.waitSeconds.toFixed(1)}s</td>
                      <td className="p-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] ${
                          tx.status === 'success' || tx.status === 'confirmed'
                            ? 'bg-green-500/20 text-green-500'
                            : tx.status === 'pending'
                            ? 'bg-yellow-500/20 text-yellow-500'
                            : 'bg-red-500/20 text-red-500'
                        }`}>
                          {tx.status}
                        </span>
                      </td>
                    </tr>
                  )
                })}
                {transactions.length === 0 && (
                  <tr>
                    <td colSpan={11} className={`p-4 text-center ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                      No transactions found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {/* Pagination */}
            {txTotal > PAGE_SIZE && (
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
                <span className={`text-xs ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                  Showing {txOffset + 1}-{Math.min(txOffset + PAGE_SIZE, txTotal)} of {txTotal}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setTxOffset(Math.max(0, txOffset - PAGE_SIZE))}
                    disabled={txOffset === 0}
                    className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer disabled:opacity-30 ${
                      isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
                    }`}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setTxOffset(txOffset + PAGE_SIZE)}
                    disabled={txOffset + PAGE_SIZE >= txTotal}
                    className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer disabled:opacity-30 ${
                      isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
                    }`}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Replication Table */}
        {activeTab === 'replication' && (
          <div className={`${cardClass} overflow-x-auto`}>
            <table className="w-full text-xs">
              <thead>
                <tr className={isDark ? 'text-white/40' : 'text-gray-400'}>
                  <th className="text-left p-2">Time</th>
                  <th className="text-left p-2">Tx Hash</th>
                  <th className="text-left p-2">Client</th>
                  <th className="text-left p-2">Dest Chain</th>
                  <th className="text-left p-2">Checkpoint</th>
                  <th className="text-right p-2">Gas</th>
                  <th className="text-right p-2">LZ Fee</th>
                  <th className="text-right p-2">Total</th>
                </tr>
              </thead>
              <tbody>
                {replication.map(tx => {
                  const p = summary?.prices || { ethUsd: 0, cawUsd: 0 }
                  return (
                  <tr
                    key={tx.id}
                    className={`border-t ${isDark ? 'border-white/5' : 'border-gray-100'}`}
                  >
                    <td className="p-2 whitespace-nowrap">{fmtDate(tx.time)}</td>
                    <td className="p-2">
                      <a
                        href={`${BASESCAN}/tx/${tx.txHash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-500 hover:underline font-mono"
                      >
                        {truncHash(tx.txHash)}
                      </a>
                    </td>
                    <td className="p-2 font-mono">{tx.client}</td>
                    <td className="p-2">{tx.destChain}</td>
                    <td className="p-2 font-mono">{tx.checkpoint}</td>
                    <td className="p-2 text-right font-mono" title={`${fmtEth(tx.gasCostEth)} ETH`}>{weiToUsd(tx.gasCostEth, p.ethUsd)}</td>
                    <td className="p-2 text-right font-mono" title={`${fmtEth(tx.lzFeeEth)} ETH`}>{weiToUsd(tx.lzFeeEth, p.ethUsd)}</td>
                    <td className="p-2 text-right font-mono" title={`${fmtEth(tx.totalCostEth)} ETH`}>{weiToUsd(tx.totalCostEth, p.ethUsd)}</td>
                  </tr>
                  )
                })}
                {replication.length === 0 && (
                  <tr>
                    <td colSpan={8} className={`p-4 text-center ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                      No replication transactions found
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {/* Pagination */}
            {repTotal > PAGE_SIZE && (
              <div className="flex items-center justify-between mt-4 pt-3 border-t border-white/5">
                <span className={`text-xs ${isDark ? 'text-white/30' : 'text-gray-400'}`}>
                  Showing {repOffset + 1}-{Math.min(repOffset + PAGE_SIZE, repTotal)} of {repTotal}
                </span>
                <div className="flex gap-2">
                  <button
                    onClick={() => setRepOffset(Math.max(0, repOffset - PAGE_SIZE))}
                    disabled={repOffset === 0}
                    className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer disabled:opacity-30 ${
                      isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
                    }`}
                  >
                    Prev
                  </button>
                  <button
                    onClick={() => setRepOffset(repOffset + PAGE_SIZE)}
                    disabled={repOffset + PAGE_SIZE >= repTotal}
                    className={`px-3 py-1 text-xs rounded transition-colors cursor-pointer disabled:opacity-30 ${
                      isDark ? 'bg-white/10 hover:bg-white/20' : 'bg-gray-200 hover:bg-gray-300'
                    }`}
                  >
                    Next
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default ValidatorAnalytics
