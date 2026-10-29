/**
 * ExpiredListingsBanner.test.tsx
 *
 * The banner lists the connected wallet's ended English auctions that have no
 * bids but are still active on chain (their token stays locked) and lets the
 * seller call cancelListing. wagmi and the API are mocked; the chain state is
 * a map of listingId -> listing.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ExpiredListingsBanner from './ExpiredListingsBanner'

const ME = '0xAbC0000000000000000000000000000000000001' // mixed case on purpose
const OTHER = '0x0000000000000000000000000000000000000002'
const ZERO = '0x0000000000000000000000000000000000000000'

let mockAddress: string | undefined
let mockMined = false
let mockWaiting = false // a cancel was sent and its receipt is awaited
let mockReceiptStatus: 'success' | 'reverted' = 'success'
let chain: Record<number, { active: boolean; seller: string; highestBidder: string }> = {}
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
      const l = chain[Number(c.args[0])]
      return l
        ? { status: 'success', result: [54, l.seller === '*' ? mockAddress : l.seller, '0xtoken', 2, 1n, 0n, 1n, 2n, 0n, l.highestBidder, l.active] }
        : { status: 'failure', error: new Error('no such listing') }
    }),
    }
  },
  useWriteContract: () => ({ writeContract: mockWrite, data: undefined, isPending: false, error: null, reset: mockResetWrite }),
  useWaitForTransactionReceipt: () => ({ isSuccess: mockMined, isLoading: mockWaiting, data: mockMined ? { status: mockReceiptStatus } : undefined }),
}))
vi.mock('~/api/client', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 11155111 } } }))

const listing = (listingId: number, username: string) => ({
  id: listingId + 100, listingId, tokenId: 54, username, endTime: '2026-09-22T14:05:36.000Z',
})
// seller '*': the listing's seller on chain is whichever wallet is connected, so
// only the wallet tie (not the chain's seller check) can hide it for another wallet.
const mine = { active: true, seller: '*', highestBidder: ZERO }

async function renderBanner() {
  const view = render(<ExpiredListingsBanner />)
  await act(async () => {}) // let the API call resolve
  return view
}

describe('ExpiredListingsBanner', () => {
  beforeEach(() => {
    mockAddress = ME
    mockMined = false
    mockWaiting = false
    mockReceiptStatus = 'success'
    chain = {}
    mockWrite.mockReset(); mockResetWrite.mockReset(); mockApiFetch.mockReset()
  })

  it('lists only the listings that are still active on chain', async () => {
    chain = { 1: mine, 2: { ...mine, active: false } }
    mockApiFetch.mockResolvedValue({ listings: [listing(1, 'alice'), listing(2, 'bob')] })
    await renderBanner()
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/marketplace/listings/seller/${ME}?status=EXPIRED&limit=100`)
    expect(screen.getByText(/1 ended auction with no bids still locks your username/)).toBeTruthy()
    await userEvent.setup().click(screen.getByText(/still locks your username/))
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.queryByText('@bob')).toBeNull()
  })

  it('reads the chain afresh on every mount, not from the app\'s 5-minute cache', async () => {
    chain = { 1: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(1, 'alice')] })
    await renderBanner()
    // staleTime 0 and gcTime 0: a listing cancelled a moment ago must not come back
    // from the cache as "active" after leaving the page and returning.
    expect(lastReadQuery?.staleTime).toBe(0)
    expect(lastReadQuery?.gcTime).toBe(0)
  })

  it('uses the plural when several listings are stuck', async () => {
    chain = { 1: mine, 3: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(1, 'alice'), listing(3, 'carol')] })
    await renderBanner()
    expect(screen.getByText(/2 ended auctions with no bids still lock your usernames/)).toBeTruthy()
  })

  it('leaves out a listing that has a bidder on chain, or another seller', async () => {
    chain = {
      1: { ...mine, highestBidder: OTHER }, // a bid the indexer had not seen: settle, not cancel
      2: { ...mine, seller: OTHER },        // cancelListing is seller-only
    }
    mockApiFetch.mockResolvedValue({ listings: [listing(1, 'alice'), listing(2, 'bob')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing when every candidate was already cancelled', async () => {
    chain = { 1: { ...mine, active: false } }
    mockApiFetch.mockResolvedValue({ listings: [listing(1, 'alice')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing, and asks the API nothing, without a wallet', async () => {
    mockAddress = undefined
    const { container } = await renderBanner()
    expect(mockApiFetch).not.toHaveBeenCalled()
    expect(container.innerHTML).toBe('')
  })

  it('shows nothing when the first API call fails', async () => {
    mockApiFetch.mockRejectedValue(new Error('down'))
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('Cancel listing calls cancelListing for that listing on the L1 chain', async () => {
    chain = { 7: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(7, 'alice')] })
    await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still locks your username/))
    await user.click(screen.getByText('Cancel listing'))
    expect(mockWrite).toHaveBeenCalledTimes(1)
    const call = mockWrite.mock.calls[0][0]
    expect(call.functionName).toBe('cancelListing')
    expect(call.args).toEqual([7n])
    expect(call.chainId).toBe(11155111)
  })

  it('drops the listing at once when its cancel is confirmed, even if the chain read is stale', async () => {
    chain = { 7: mine, 8: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(7, 'alice'), listing(8, 'bob')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still lock your usernames/))
    await user.click(screen.getAllByText('Cancel listing')[0]) // alice, listing 7
    mockMined = true
    rerender(<ExpiredListingsBanner />) // the mocked chain still says 7 is active
    await act(async () => {})
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('does not let a second cancel start while the first awaits its receipt', async () => {
    chain = { 7: mine, 8: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(7, 'alice'), listing(8, 'bob')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still lock your usernames/))
    await user.click(screen.getAllByText('Cancel listing')[0])
    mockWaiting = true
    rerender(<ExpiredListingsBanner />)
    await act(async () => {})
    const buttons = screen.getAllByRole('button').filter(b => /Cancel|Cancelling/.test(b.textContent || '') && !/ended auction/.test(b.textContent || ''))
    expect(buttons).toHaveLength(2)
    expect(buttons.every(b => (b as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getByText('Cancelling…')).toBeTruthy()
    await user.click(buttons[1])
    expect(mockWrite).toHaveBeenCalledTimes(1)
  })

  it('keeps the listing, and says so, when the cancel transaction is mined but reverted', async () => {
    chain = { 7: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(7, 'alice')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still locks your username/))
    await user.click(screen.getByText('Cancel listing'))
    mockMined = true
    mockReceiptStatus = 'reverted'
    rerender(<ExpiredListingsBanner />)
    await act(async () => {})
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.getByText(/reverted, so the listing is still there/)).toBeTruthy()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockResetWrite).toHaveBeenCalled()
  })

  it('keeps the list when asking the API again fails after a confirmed cancel', async () => {
    chain = { 7: mine, 8: mine }
    mockApiFetch.mockResolvedValueOnce({ listings: [listing(7, 'alice'), listing(8, 'bob')] })
    mockApiFetch.mockRejectedValue(new Error('down'))
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/still lock your usernames/))
    await user.click(screen.getAllByText('Cancel listing')[0])
    mockMined = true
    rerender(<ExpiredListingsBanner />)
    await act(async () => {})
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('does not show one wallet\'s listings for another wallet', async () => {
    chain = { 7: mine }
    mockApiFetch.mockResolvedValueOnce({ listings: [listing(7, 'alice')] })
    const { rerender, container } = await renderBanner()
    expect(screen.getByText(/still locks your username/)).toBeTruthy()
    mockAddress = OTHER
    mockApiFetch.mockRejectedValue(new Error('down'))
    rerender(<ExpiredListingsBanner />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('looks at the API again once the cancel transaction is confirmed', async () => {
    chain = { 7: mine }
    mockApiFetch.mockResolvedValue({ listings: [listing(7, 'alice')] })
    const { rerender } = await renderBanner()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    mockMined = true
    rerender(<ExpiredListingsBanner />)
    await act(async () => {})
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockResetWrite).toHaveBeenCalled()
  })
})
