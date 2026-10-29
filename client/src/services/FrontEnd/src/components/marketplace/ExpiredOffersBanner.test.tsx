/**
 * ExpiredOffersBanner.test.tsx
 *
 * The banner lists the connected wallet's expired offers that are still
 * active on chain (funds escrowed) and lets the offerer call cancelOffer.
 * wagmi and the API are mocked; the chain state is a map of offerId -> offer.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExpiredOffersBanner from './ExpiredOffersBanner'

const CAW = 10n ** 18n

let mockAddress: string | undefined
let mockMined = false
let mockWaiting = false // a cancel was sent and its receipt is awaited
let mockReceiptStatus: 'success' | 'reverted' = 'success'
let chain: Record<number, { active: boolean; amount: bigint }> = {}
const mockWrite = vi.fn()
const mockResetWrite = vi.fn()
const mockApiFetch = vi.fn()
let lastReadQuery: Record<string, unknown> | undefined

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mockAddress }),
  useReadContracts: ({ contracts, query }: { contracts: { args: [bigint] }[]; query?: Record<string, unknown> }) => {
    lastReadQuery = query
    return {
      data: contracts.map(c => {
        const o = chain[Number(c.args[0])]
        return o
          ? { status: 'success', result: ['0xme', 17, '0xtoken', o.amount, 0n, o.active] }
          : { status: 'failure', error: new Error('no such offer') }
      }),
    }
  },
  useWriteContract: () => ({ writeContract: mockWrite, data: undefined, isPending: false, error: null, reset: mockResetWrite }),
  useWaitForTransactionReceipt: () => ({ isSuccess: mockMined, isLoading: mockWaiting, data: mockMined ? { status: mockReceiptStatus } : undefined }),
}))
vi.mock('~/api/client', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 11155111 } } }))

const offer = (offerId: number, username: string) => ({
  id: offerId + 100, offerId, tokenId: 17, paymentToken: 'CAW', username, expiry: '2026-09-02T04:12:48.000Z',
})

async function renderBanner() {
  const view = render(<ExpiredOffersBanner />)
  await act(async () => {}) // let the API call resolve
  return view
}

describe('ExpiredOffersBanner', () => {
  beforeEach(() => {
    mockAddress = '0xme'
    mockMined = false
    mockWaiting = false
    mockReceiptStatus = 'success'
    chain = {}
    mockWrite.mockReset(); mockResetWrite.mockReset(); mockApiFetch.mockReset()
  })

  it('lists only the offers that are still active on chain', async () => {
    chain = { 1: { active: true, amount: 10n * CAW }, 2: { active: false, amount: 0n } }
    mockApiFetch.mockResolvedValue({ offers: [offer(1, 'alice'), offer(2, 'bob')] })
    await renderBanner()
    expect(mockApiFetch).toHaveBeenCalledWith('/api/marketplace/offers/reclaimable/0xme?limit=200')
    expect(screen.getByText(/1 expired offer still holds your funds/)).toBeTruthy()
    expect(screen.getByText(/10 CAW/)).toBeTruthy()
    await userEvent.setup().click(screen.getByText(/still holds your funds/))
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.queryByText('@bob')).toBeNull()
  })

  it('reads the chain afresh on every mount, not from the app\'s 5-minute cache', async () => {
    chain = { 1: { active: true, amount: 10n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(1, 'alice')] })
    await renderBanner()
    // staleTime 0 and gcTime 0: an offer cancelled a moment ago must not come back
    // from the cache as "active" after leaving the page and returning.
    expect(lastReadQuery?.staleTime).toBe(0)
    expect(lastReadQuery?.gcTime).toBe(0)
  })

  it('adds up the escrowed amounts of several offers', async () => {
    chain = { 1: { active: true, amount: 10n * CAW }, 3: { active: true, amount: 5n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(1, 'alice'), offer(3, 'carol')] })
    await renderBanner()
    expect(screen.getByText(/2 expired offers still hold your funds/)).toBeTruthy()
    expect(screen.getByText(/15 CAW/)).toBeTruthy()
  })

  it('shows nothing when every candidate was already refunded', async () => {
    chain = { 1: { active: false, amount: 0n } }
    mockApiFetch.mockResolvedValue({ offers: [offer(1, 'alice')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing, and asks the API nothing, without a wallet', async () => {
    mockAddress = undefined
    const { container } = await renderBanner()
    expect(mockApiFetch).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing when the API call fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('down'))
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('Reclaim calls cancelOffer for that offer on the L1 chain', async () => {
    chain = { 7: { active: true, amount: 10n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(7, 'alice')] })
    await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still holds your funds/))
    await user.click(screen.getByText('Reclaim'))
    expect(mockWrite).toHaveBeenCalledTimes(1)
    const call = mockWrite.mock.calls[0][0]
    expect(call.functionName).toBe('cancelOffer')
    expect(call.args).toEqual([7n])
    expect(call.chainId).toBe(11155111)
  })

  it('drops the offer at once when its cancel is confirmed, even if the chain read is stale', async () => {
    chain = { 7: { active: true, amount: 10n * CAW }, 8: { active: true, amount: 5n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(7, 'alice'), offer(8, 'bob')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still hold your funds/))
    await user.click(screen.getAllByText('Reclaim')[0]) // alice, offer 7
    mockMined = true
    rerender(<ExpiredOffersBanner />) // the mocked chain still says 7 is active
    await act(async () => {})
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('does not let a second Reclaim start while the first cancel awaits its receipt', async () => {
    chain = { 7: { active: true, amount: 10n * CAW }, 8: { active: true, amount: 5n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(7, 'alice'), offer(8, 'bob')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still hold your funds/))
    await user.click(screen.getAllByText('Reclaim')[0]) // alice, offer 7
    mockWaiting = true
    rerender(<ExpiredOffersBanner />)
    await act(async () => {})
    const buttons = screen.getAllByRole('button').filter(b => /Reclaim/.test(b.textContent || ''))
    expect(buttons).toHaveLength(2)
    expect(buttons.every(b => (b as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getByText('Reclaiming…')).toBeTruthy()
    await user.click(buttons[1])
    expect(mockWrite).toHaveBeenCalledTimes(1)
  })

  it('keeps the offer, and says so, when the cancel transaction is mined but reverted', async () => {
    chain = { 7: { active: true, amount: 10n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(7, 'alice')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still holds your funds/))
    await user.click(screen.getByText('Reclaim'))
    mockMined = true
    mockReceiptStatus = 'reverted'
    rerender(<ExpiredOffersBanner />)
    await act(async () => {})
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.getByText(/reverted, so nothing was refunded/)).toBeTruthy()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockResetWrite).toHaveBeenCalled()
  })

  it('keeps the list when asking the API again fails after a confirmed cancel', async () => {
    chain = { 7: { active: true, amount: 10n * CAW }, 8: { active: true, amount: 5n * CAW } }
    mockApiFetch.mockResolvedValueOnce({ offers: [offer(7, 'alice'), offer(8, 'bob')] })
    mockApiFetch.mockRejectedValue(new Error('down'))
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still hold your funds/))
    await user.click(screen.getAllByText('Reclaim')[0]) // alice, offer 7
    mockMined = true
    rerender(<ExpiredOffersBanner />)
    await act(async () => {})
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('does not show one wallet\'s offers for another wallet', async () => {
    chain = { 7: { active: true, amount: 10n * CAW } }
    mockApiFetch.mockResolvedValueOnce({ offers: [offer(7, 'alice')] })
    const { rerender, container } = await renderBanner()
    expect(screen.getByText(/still holds your funds/)).toBeTruthy()
    mockAddress = '0xother'
    mockApiFetch.mockRejectedValue(new Error('down'))
    rerender(<ExpiredOffersBanner />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('looks at the API again once the cancel transaction is confirmed', async () => {
    chain = { 7: { active: true, amount: 10n * CAW } }
    mockApiFetch.mockResolvedValue({ offers: [offer(7, 'alice')] })
    const { rerender } = await renderBanner()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    mockMined = true
    rerender(<ExpiredOffersBanner />)
    await act(async () => {})
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockResetWrite).toHaveBeenCalled()
  })
})
