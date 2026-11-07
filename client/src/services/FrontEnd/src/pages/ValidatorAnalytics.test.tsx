/**
 * ValidatorAnalytics: the transaction list while a day is selected, and the
 * 6-hour chart across a DST change. The page is real; apiFetch, the theme
 * hook and Link are stand-ins.
 */

// The 6-hour case needs a zone with a clock change. Set before any Date is made.
process.env.TZ = 'America/New_York'

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

interface ChartRow {
  time: string
  profit: string
  txCount: number
  actionCount: number
  ethCost: string
  tipEth: string
  actionBreakdown: Record<string, number>
}

const calls: string[] = []
let chart: ChartRow[] = []
// Extra delay (ms) for a /transactions answer, chosen per request
let txDelay: (q: URLSearchParams) => number = () => 0

const DAY_SPAN_MS = 25 * 3600 * 1000
const row = (id: number, tag: string) => ({
  id,
  createdAt: '2026-11-18T12:00:00Z',
  txHash: `0x${tag}${String(id).padStart(62, '0')}`,
  txType: 'processActions',
  actionCount: 1,
  ethCost: '1',
  tipCaw: '0',
  tipEthValue: '0',
  profit: '0',
  avgWaitMs: 0,
  status: 'confirmed',
})

vi.mock('~/api/client', () => ({
  apiFetch: vi.fn(async (url: string) => {
    calls.push(url)
    const q = new URLSearchParams(url.split('?')[1] || '')
    if (url.includes('/summary')) {
      return { transactions: 0, totalActions: 0, totalEthCost: '0', totalTipCaw: '0', totalTipEth: '0', totalProfit: '0', avgWaitMs: 0, prices: { ethUsd: 0, cawUsd: 0 }, replication: { transactions: 0, totalCost: '0', checkpointsReplicated: 0 } }
    }
    if (url.includes('/transactions')) {
      const span = new Date(q.get('to')!).getTime() - new Date(q.get('from')!).getTime()
      const isDay = span < DAY_SPAN_MS
      const off = Number(q.get('offset') || 0)
      const ms = txDelay(q)
      if (ms) await new Promise(r => setTimeout(r, ms))
      // A day has 120 rows (tag dd), the whole range 900 (tag aa)
      return { transactions: Array.from({ length: 50 }, (_, i) => row(off + i + 1, isDay ? 'dd' : 'aa')), total: isDay ? 120 : 900 }
    }
    if (url.includes('/replication')) return { transactions: [], total: 0 }
    if (url.includes('/chart')) return { chart: q.get('interval') === 'hour' ? [] : chart }
    return { ok: false }
  }),
}))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/utils/localizedRouter', () => ({ Link: ({ children }: { children?: React.ReactNode }) => <a>{children}</a> }))

import ValidatorAnalytics from './ValidatorAnalytics'

const page = (u: string) => render(<MemoryRouter initialEntries={[u]}><ValidatorAnalytics /></MemoryRouter>)
// truncHash keeps '0x' + 4 chars and the last 4: '0xdd00...0051' = day row 51
const firstRow = () => document.querySelector('tbody a')?.textContent ?? '(none)'
const tab = () => screen.getByText(/^Transactions \(/).textContent ?? ''
const settle = () => act(async () => { await new Promise(r => setTimeout(r, 150)) })
const localDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return { from: new Date(y, m - 1, d, 0, 0, 0, 0).toISOString(), to: new Date(y, m - 1, d, 23, 59, 59, 999).toISOString() }
}
const txCalls = () => calls.filter(c => c.includes('/transactions')).map(c => new URLSearchParams(c.split('?')[1]))
const isDayQuery = (q: URLSearchParams) => new Date(q.get('to')!).getTime() - new Date(q.get('from')!).getTime() < DAY_SPAN_MS

describe('ValidatorAnalytics: transaction list while a day is selected', () => {
  beforeEach(() => {
    cleanup(); calls.length = 0; chart = []; txDelay = () => 0
    // A fixed "today" whose 7d range (11-14 to 11-20) has no clock change
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 20, 12, 0, 0))
  })
  afterEach(() => vi.useRealTimers())

  it('Next pages through the selected day, not the whole range', async () => {
    page('/admin/validator?range=7d&day=2026-11-18')
    await waitFor(() => expect(tab()).toMatch(/\(120\)/))
    await settle()
    calls.length = 0
    fireEvent.click(screen.getByText('Next'))
    await settle()
    const q = txCalls().at(-1)!
    const day = localDay('2026-11-18')
    expect(q.get('from')).toBe(day.from)
    expect(q.get('to')).toBe(day.to)
    expect(q.get('offset')).toBe('50')
    expect(tab()).toMatch(/\(120\)/)
    expect(firstRow()).toBe('0xdd00...0051')
  })

  it('a day in the URL does not race a whole-range list', async () => {
    // The whole-range answer arrives last; it must not be what the table shows
    txDelay = q => (isDayQuery(q) ? 0 : 60)
    page('/admin/validator?range=7d&day=2026-11-18')
    await settle()
    expect(tab()).toMatch(/\(120\)/)
    expect(firstRow()).toBe('0xdd00...0001')
  })

  it('clicking a bar from page 2 shows page 1 of that day', async () => {
    chart = [{ time: '2026-11-18T06:00:00', profit: '1000000000000000000', txCount: 1, actionCount: 1, ethCost: '0', tipEth: '0', actionBreakdown: {} }]
    page('/admin/validator?range=7d')
    await waitFor(() => expect(tab()).toMatch(/\(900\)/))
    fireEvent.click(screen.getByText('Next'))
    await settle()
    expect(firstRow()).toBe('0xaa00...0051')
    const bars = [...document.querySelectorAll('.flex-1.cursor-pointer')] as HTMLElement[]
    const withData = bars.find(b => (b.firstElementChild as HTMLElement).style.height === '100%')!
    fireEvent.click(withData)
    await settle()
    expect(tab()).toMatch(/\(120\)/)
    expect(firstRow()).toBe('0xdd00...0001')
    const q = txCalls().at(-1)!
    expect(q.get('from')).toBe(localDay('2026-11-18').from)
    expect(q.get('offset')).toBe('0')
  })

  it('Back to daily returns to page 1 of the whole range', async () => {
    page('/admin/validator?range=7d&day=2026-11-18')
    await waitFor(() => expect(tab()).toMatch(/\(120\)/))
    fireEvent.click(screen.getByText('Next'))
    await settle()
    fireEvent.click(screen.getByText('← Back to daily'))
    await settle()
    expect(tab()).toMatch(/\(900\)/)
    expect(firstRow()).toBe('0xaa00...0001')
    const q = txCalls().at(-1)!
    expect(isDayQuery(q)).toBe(false)
    expect(q.get('offset')).toBe('0')
  })

  it('an older page that answers late does not replace a newer one', async () => {
    // Page 2 is slow, page 3 is fast: after Next, Next the table shows page 3
    txDelay = q => (q.get('offset') === '50' ? 80 : 0)
    page('/admin/validator?range=7d')
    await waitFor(() => expect(tab()).toMatch(/\(900\)/))
    fireEvent.click(screen.getByText('Next'))
    fireEvent.click(screen.getByText('Next'))
    await settle()
    expect(screen.getByText(/^Showing /).textContent).toMatch(/101-150/)
    expect(firstRow()).toBe('0xaa00...0101')
  })
})

describe('ValidatorAnalytics: 6-hour chart across a clock change', () => {
  beforeEach(() => { cleanup(); calls.length = 0; txDelay = () => 0 })
  afterEach(() => vi.useRealTimers())

  // US clocks went back on 2026-11-01. Skip (not pass) if the zone did not apply.
  const zoneHasChange = new Date(2026, 9, 31, 12).getTimezoneOffset() !== new Date(2026, 10, 2, 12).getTimezoneOffset()

  it.skipIf(!zoneHasChange)('every 6-hour bucket from the server lands on a bar', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(2026, 10, 5, 12, 0, 0))
    const keys: string[] = []
    for (let d = 1; d <= 5; d++) for (const h of ['00', '06', '12', '18']) keys.push(`2026-11-0${d}T${h}:00:00`)
    chart = keys.map(time => ({ time, profit: '1000000000000000000', txCount: 1, actionCount: 1, ethCost: '0', tipEth: '0', actionBreakdown: {} }))
    page('/admin/validator?range=7d')
    await waitFor(() => expect(document.querySelectorAll('.flex-1.cursor-pointer').length).toBeGreaterThan(0))
    const bars = [...document.querySelectorAll('.flex-1.cursor-pointer > div')] as HTMLElement[]
    expect(bars.filter(b => b.style.height === '100%').length).toBe(keys.length)
    // 7 local days of 4 slots each (10-30 to 11-05)
    expect(bars.length).toBe(28)
  })
})
