import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import RefundsBanner from './RefundsBanner'

const mocks = vi.hoisted(() => ({
  apiFetch: vi.fn(),
  useReadContracts: vi.fn(),
  writeContract: vi.fn(),
}))

vi.mock('wagmi', () => ({
  useAccount: () => ({ address: '0xaaaa' }),
  useReadContracts: mocks.useReadContracts,
  useWriteContract: () => ({ writeContract: mocks.writeContract, isPending: false, reset: vi.fn() }),
  useWaitForTransactionReceipt: () => ({ isSuccess: false }),
}))
vi.mock('~/api/client', () => ({ apiFetch: mocks.apiFetch }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/../../../abi/addresses', () => ({ CAW_NAME_MARKETPLACE_ADDRESS: '0xbbbb' }))
vi.mock('~/../../../abi/generated', () => ({ cawProfileMarketplaceAbi: [] }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 11155111 }, l2: { chainId: 84532 } } }))
vi.mock('~/hooks/useEnsureWallet', () => ({
  useEnsureWallet: () => (_opts: unknown, action: () => Promise<void>) => action(),
}))

const E18 = 10n ** 18n
const row = (id: number, listingId: number) => ({
  id,
  listingId: 1,
  amount: '1',
  listing: { listingId, paymentToken: 'CAW', username: `name${listingId}`, tokenId: listingId },
})

// Answers each read with the balance of its listing, as the contract would.
function chainHolds(balances: Record<string, bigint>) {
  mocks.useReadContracts.mockImplementation(({ contracts }: { contracts: { args: [string, bigint] }[] }) => ({
    data: contracts.length
      ? contracts.map(c => ({ status: 'success', result: balances[c.args[1].toString()] ?? 0n }))
      : undefined,
  }))
}

beforeEach(() => vi.clearAllMocks())

describe('RefundsBanner', () => {
  it('counts one refund for two outbid rows on one listing', async () => {
    mocks.apiFetch.mockResolvedValue({ bids: [row(1, 7), row(2, 7)] })
    chainHolds({ 7: 100n * E18 })
    render(<RefundsBanner />)

    await screen.findByText('You have 1 refund to claim')
    expect(screen.getByText('100 CAW')).toBeTruthy()
  })

  it('keeps refunds on different listings apart', async () => {
    mocks.apiFetch.mockResolvedValue({ bids: [row(1, 7), row(2, 8)] })
    chainHolds({ 7: 100n * E18, 8: 50n * E18 })
    render(<RefundsBanner />)

    await screen.findByText('You have 2 refunds to claim')
    expect(screen.getByText('150 CAW')).toBeTruthy()
  })

  it('reads and claims on L1', async () => {
    mocks.apiFetch.mockResolvedValue({ bids: [row(1, 7)] })
    chainHolds({ 7: 100n * E18 })
    render(<RefundsBanner />)

    fireEvent.click(await screen.findByText('You have 1 refund to claim'))
    fireEvent.click(screen.getByText('Claim'))

    await waitFor(() => expect(mocks.writeContract).toHaveBeenCalledOnce())
    expect(mocks.writeContract.mock.calls[0][0]).toMatchObject({ functionName: 'withdrawBid', args: [7n], chainId: 11155111 })
    const reads = mocks.useReadContracts.mock.lastCall![0].contracts
    expect(reads[0].chainId).toBe(11155111)
  })
})
