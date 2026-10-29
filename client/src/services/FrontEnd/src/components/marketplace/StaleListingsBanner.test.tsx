/**
 * StaleListingsBanner.test.tsx
 *
 * The banner lists listings that are still active on chain although the
 * username moved away from the seller, for the username's current owner and
 * for the highest bidder, and lets them call reclaimListing / reclaimBid.
 * wagmi and the API are mocked; the chain state is two maps: listingId ->
 * listing, tokenId -> current owner.
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import StaleListingsBanner from './StaleListingsBanner'

const ME = '0xAbC0000000000000000000000000000000000001' // mixed case on purpose
const SELLER = '0x0000000000000000000000000000000000000002'
const OTHER = '0x0000000000000000000000000000000000000003'
const ZERO = '0x0000000000000000000000000000000000000000'
const ETH = 10n ** 18n

let mockAddress: string | undefined
let mockMined = false
let mockWaiting = false // a call was sent and its receipt is awaited
let mockReceiptStatus: 'success' | 'reverted' = 'success'
// Owner '*' means "whichever wallet is connected", so that only the wallet tie
// (not the chain's owner check) can hide a listing for another wallet.
let listingsOnChain: Record<number, { active: boolean; seller: string; highestBidder: string; highestBid: bigint }> = {}
let ownersOnChain: Record<number, string> = {}
let lastReadQuery: Record<string, unknown> | undefined
const mockWrite = vi.fn()
const mockResetWrite = vi.fn()
const mockApiFetch = vi.fn()

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: mockAddress }),
  useReadContracts: ({ contracts, query }: { contracts: { functionName: string; args: [bigint] }[]; query?: Record<string, unknown> }) => {
    lastReadQuery = query
    return {
      data: contracts.map(c => {
        const id = Number(c.args[0])
        if (c.functionName === 'listings') {
          const l = listingsOnChain[id]
          return l
            ? { status: 'success', result: [54, l.seller, '0xtoken', 2, 1n, 0n, 1n, 2n, l.highestBid, l.highestBidder, l.active] }
            : { status: 'failure', error: new Error('no such listing') }
        }
        const o = ownersOnChain[id]
        return o ? { status: 'success', result: o === '*' ? mockAddress : o } : { status: 'failure', error: new Error('no such token') }
      }),
    }
  },
  useWriteContract: () => ({ writeContract: mockWrite, data: undefined, isPending: false, error: null, reset: mockResetWrite }),
  useWaitForTransactionReceipt: () => ({ isSuccess: mockMined, isLoading: mockWaiting, data: mockMined ? { status: mockReceiptStatus } : undefined }),
}))
vi.mock('~/api/client', () => ({ apiFetch: (...a: unknown[]) => mockApiFetch(...a) }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 11155111 } } }))

const candidate = (listingId: number, tokenId: number, username: string) => ({
  id: listingId + 100, listingId, tokenId, username, paymentToken: 'ETH',
})
const staleNoBid = { active: true, seller: SELLER, highestBidder: ZERO, highestBid: 0n }

async function renderBanner() {
  const view = render(<StaleListingsBanner />)
  await act(async () => {}) // let the API call resolve
  return view
}
async function open() {
  await userEvent.setup().click(screen.getByText(/left open after a username moved/))
}

describe('StaleListingsBanner', () => {
  beforeEach(() => {
    mockAddress = ME
    mockMined = false
    mockWaiting = false
    mockReceiptStatus = 'success'
    listingsOnChain = {}
    ownersOnChain = {}
    mockWrite.mockReset(); mockResetWrite.mockReset(); mockApiFetch.mockReset()
  })

  it('shows the owner a listing by a previous owner, and Clear listing calls reclaimListing', async () => {
    listingsOnChain = { 7: staleNoBid }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    await renderBanner()
    expect(mockApiFetch).toHaveBeenCalledWith(`/api/marketplace/listings/stale/${ME}?limit=100`)
    expect(screen.getByText(/1 listing left open after a username moved/)).toBeTruthy()
    await open()
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.getByText('A listing by a previous owner still blocks listing it.')).toBeTruthy()
    await userEvent.setup().click(screen.getByText('Clear listing'))
    expect(mockWrite).toHaveBeenCalledTimes(1)
    const call = mockWrite.mock.calls[0][0]
    expect(call.functionName).toBe('reclaimListing')
    expect(call.args).toEqual([7n])
    expect(call.chainId).toBe(11155111)
  })

  it('when the listing holds someone else\'s bid, the owner\'s button calls reclaimBid and says the bid is held', async () => {
    listingsOnChain = { 7: { ...staleNoBid, highestBidder: OTHER, highestBid: 5n * ETH } }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    await renderBanner()
    await open()
    expect(screen.getByText(/still blocks listing it, and holds a bid of 5\.00 ETH/)).toBeTruthy()
    await userEvent.setup().click(screen.getByText('Clear listing'))
    expect(mockWrite.mock.calls[0][0].functionName).toBe('reclaimBid')
    expect(mockWrite.mock.calls[0][0].args).toEqual([7n])
  })

  it('shows the highest bidder their held bid, and Release my bid calls reclaimBid', async () => {
    listingsOnChain = { 7: { ...staleNoBid, highestBidder: ME, highestBid: 2n * ETH } }
    ownersOnChain = { 54: OTHER } // the username moved to someone else
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    await renderBanner()
    await open()
    expect(screen.getByText(/Your bid of 2\.00 ETH is held by a listing whose seller no longer owns the username/)).toBeTruthy()
    await userEvent.setup().click(screen.getByText('Release my bid'))
    expect(mockWrite.mock.calls[0][0].functionName).toBe('reclaimBid')
    expect(mockWrite.mock.calls[0][0].args).toEqual([7n])
  })

  it('when the owner is also the highest bidder, shows the bidder\'s text and Release my bid', async () => {
    listingsOnChain = { 7: { ...staleNoBid, highestBidder: ME, highestBid: 3n * ETH } }
    ownersOnChain = { 54: '*' } // the seller moved the username to the bidder
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    await renderBanner()
    await open()
    expect(screen.getByText(/Your bid of 3\.00 ETH is held by a listing whose seller no longer owns the username/)).toBeTruthy()
    await userEvent.setup().click(screen.getByText('Release my bid'))
    expect(mockWrite.mock.calls[0][0].functionName).toBe('reclaimBid')
  })

  it('says clearing makes a bid withdrawable, not that it is paid out', async () => {
    listingsOnChain = { 7: staleNoBid }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    await renderBanner()
    expect(screen.getByText(/makes any bid withdrawable by its bidder/)).toBeTruthy()
  })

  it('leaves out a live listing: the seller still owns the username', async () => {
    listingsOnChain = { 7: { ...staleNoBid, highestBidder: ME, highestBid: ETH } }
    ownersOnChain = { 54: SELLER }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('leaves out a listing that is no longer active on chain', async () => {
    listingsOnChain = { 7: { ...staleNoBid, active: false } }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('leaves out a listing that concerns this wallet neither as owner nor as bidder', async () => {
    listingsOnChain = { 7: { ...staleNoBid, highestBidder: OTHER, highestBid: ETH } }
    ownersOnChain = { 54: OTHER }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('leaves out a candidate whose chain read failed', async () => {
    listingsOnChain = {}
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    const { container } = await renderBanner()
    expect(container.innerHTML).toBe('')
  })

  it('uses the plural when several listings are stale', async () => {
    listingsOnChain = { 7: staleNoBid, 8: staleNoBid }
    ownersOnChain = { 54: '*', 55: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice'), candidate(8, 55, 'bob')] })
    await renderBanner()
    expect(screen.getByText(/2 listings left open after a username moved/)).toBeTruthy()
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

  it('reads the chain afresh on every mount, not from the app\'s 5-minute cache', async () => {
    listingsOnChain = { 7: staleNoBid }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    await renderBanner()
    expect(lastReadQuery?.staleTime).toBe(0)
    expect(lastReadQuery?.gcTime).toBe(0)
  })

  it('drops the listing at once when its call is confirmed, even if the chain read is stale', async () => {
    listingsOnChain = { 7: staleNoBid, 8: staleNoBid }
    ownersOnChain = { 54: '*', 55: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice'), candidate(8, 55, 'bob')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/2 listings left open/))
    await user.click(screen.getAllByText('Clear listing')[0]) // alice, listing 7
    mockMined = true
    rerender(<StaleListingsBanner />) // the mocked chain still says 7 is active
    await act(async () => {})
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('does not let a second call start while the first awaits its receipt', async () => {
    listingsOnChain = { 7: staleNoBid, 8: staleNoBid }
    ownersOnChain = { 54: '*', 55: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice'), candidate(8, 55, 'bob')] })
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/2 listings left open/))
    await user.click(screen.getAllByText('Clear listing')[0])
    mockWaiting = true
    rerender(<StaleListingsBanner />)
    await act(async () => {})
    const buttons = screen.getAllByRole('button').filter(b => ['Clear listing', 'Clearing…'].includes(b.textContent || ''))
    expect(buttons).toHaveLength(2)
    expect(buttons.every(b => (b as HTMLButtonElement).disabled)).toBe(true)
    expect(screen.getByText('Clearing…')).toBeTruthy()
    await user.click(buttons[1])
    expect(mockWrite).toHaveBeenCalledTimes(1)
  })

  it('keeps the listing, and says so, when the transaction is mined but reverted', async () => {
    listingsOnChain = { 7: staleNoBid }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    const { rerender } = await renderBanner()
    await open()
    await userEvent.setup().click(screen.getByText('Clear listing'))
    mockMined = true
    mockReceiptStatus = 'reverted'
    rerender(<StaleListingsBanner />)
    await act(async () => {})
    expect(screen.getByText('@alice')).toBeTruthy()
    expect(screen.getByText(/reverted, so the listing is still there/)).toBeTruthy()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    expect(mockResetWrite).toHaveBeenCalled()
  })

  it('keeps the list when asking the API again fails after a confirmed call', async () => {
    listingsOnChain = { 7: staleNoBid, 8: staleNoBid }
    ownersOnChain = { 54: '*', 55: '*' }
    mockApiFetch.mockResolvedValueOnce({ listings: [candidate(7, 54, 'alice'), candidate(8, 55, 'bob')] })
    mockApiFetch.mockRejectedValue(new Error('down'))
    const { rerender } = await renderBanner()
    const user = userEvent.setup()
    await user.click(screen.getByText(/2 listings left open/))
    await user.click(screen.getAllByText('Clear listing')[0])
    mockMined = true
    rerender(<StaleListingsBanner />)
    await act(async () => {})
    expect(screen.queryByText('@alice')).toBeNull()
    expect(screen.getByText('@bob')).toBeTruthy()
  })

  it('does not show one wallet\'s listings for another wallet', async () => {
    listingsOnChain = { 7: staleNoBid }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValueOnce({ listings: [candidate(7, 54, 'alice')] })
    const { rerender, container } = await renderBanner()
    expect(screen.getByText(/1 listing left open/)).toBeTruthy()
    mockAddress = OTHER
    mockApiFetch.mockRejectedValue(new Error('down'))
    rerender(<StaleListingsBanner />)
    await act(async () => {})
    expect(container.innerHTML).toBe('')
  })

  it('looks at the API again once the transaction is confirmed', async () => {
    listingsOnChain = { 7: staleNoBid }
    ownersOnChain = { 54: '*' }
    mockApiFetch.mockResolvedValue({ listings: [candidate(7, 54, 'alice')] })
    const { rerender } = await renderBanner()
    expect(mockApiFetch).toHaveBeenCalledTimes(1)
    mockMined = true
    rerender(<StaleListingsBanner />)
    await act(async () => {})
    expect(mockApiFetch).toHaveBeenCalledTimes(2)
    expect(mockResetWrite).toHaveBeenCalled()
  })
})
