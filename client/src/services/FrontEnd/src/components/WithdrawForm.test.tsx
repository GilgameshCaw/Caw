// WithdrawForm must treat a quoted fee of 0 as a real answer, not as "still
// loading". A Network can set withdrawFee to 0, and the quoter returns 0 when
// nothing is queued, so a 0 quote has to unlock the form like any other fee.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

type Quote = { nativeFee: bigint; lzTokenFee: bigint } | undefined
type ContractCallArgs = { disabled: boolean; value?: bigint }

const s = vi.hoisted(() => ({
  OWNER: '0x1111111111111111111111111111111111111111',
  population: 'A' as 'A' | 'B',
  quote: undefined as { nativeFee: bigint; lzTokenFee: bigint } | undefined,
  lastCall: undefined as { disabled: boolean; value?: bigint } | undefined,
  call: vi.fn(async () => {}),
  apiFetch: vi.fn<(url: string) => Promise<object>>(async () => ({
    relayer: '0x2222222222222222222222222222222222222222',
    minFeeCawWei: '1000000000000000000',
    priceAvailable: true,
    cawAddress: '0x3333333333333333333333333333333333333333',
  })),
}))

vi.mock('wagmi', () => ({ useReadContract: () => ({ data: s.quote }) }))
vi.mock('~/api/actions', () => ({ CLIENT_ID: 1 }))
vi.mock('~/api/client', () => ({ apiFetch: s.apiFetch }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 1 }, l2: { layerZero: 40245 } } }))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/hooks/useWalletPopulation', () => ({
  useWalletPopulation: () => ({ population: s.population, address: s.OWNER }),
}))
vi.mock('~/hooks/useSmartEoaExecute', () => ({
  useSmartEoaExecute: () => ({ execute: vi.fn(), account: s.OWNER }),
}))
vi.mock('~/hooks/useContractCall', () => ({
  default: (args: ContractCallArgs) => {
    s.lastCall = args
    return { call: s.call }
  },
}))
vi.mock('~/hooks/useEnsureWallet', () => ({
  useEnsureWallet: () => async (_opts: unknown, cb: () => Promise<void>) => { await cb() },
}))
vi.mock('~/store/tokenDataStore', () => ({
  usePriceStore: (sel: (st: { priceMap: Record<string, number> }) => unknown) => sel({ priceMap: {} }),
}))
vi.mock('~/utils', () => ({ handleError: vi.fn() }))
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string) => k }))

import { WithdrawForm } from './WithdrawForm'

const WITHDRAWABLE = 10n ** 20n

function setup(population: 'A' | 'B', quote: Quote) {
  s.population = population
  s.quote = quote
  render(<WithdrawForm tokenId={7} withdrawableWei={WITHDRAWABLE} />)
  return screen.getByText('withdraw.review_button') as HTMLButtonElement
}

beforeEach(() => {
  cleanup()
  s.lastCall = undefined
  s.call.mockClear()
  s.apiFetch.mockClear()
})

describe('WithdrawForm with a zero withdraw fee', () => {
  it('Pop-A: a 0 quote unlocks review and sends withdrawTo with value 0', async () => {
    const review = setup('A', { nativeFee: 0n, lzTokenFee: 0n })
    expect(review.disabled).toBe(false)
    expect(s.lastCall?.disabled).toBe(false)
    expect(s.lastCall?.value).toBe(0n)
    fireEvent.click(review)
    fireEvent.click(screen.getByText('withdraw.confirm_button'))
    await waitFor(() => expect(s.call).toHaveBeenCalledTimes(1))
  })

  it('Pop-B: a 0 quote fetches the relayer quote with forwardedValueWei=0 and unlocks confirm', async () => {
    const review = setup('B', { nativeFee: 0n, lzTokenFee: 0n })
    expect(review.disabled).toBe(false)
    fireEvent.click(review)
    await waitFor(() => expect(s.apiFetch).toHaveBeenCalledTimes(1))
    expect(s.apiFetch.mock.calls[0][0]).toBe('/api/sponsor/execute-quote?forwardedValueWei=0')
    const confirm = screen.getByText('withdraw.confirm_button').closest('button') as HTMLButtonElement
    await waitFor(() => expect(confirm.disabled).toBe(false))
  })
})

describe('WithdrawForm before the quote arrives, and with a non-zero fee', () => {
  it('Pop-A: no quote yet keeps review and the contract call disabled', () => {
    const review = setup('A', undefined)
    expect(review.disabled).toBe(true)
    expect(s.lastCall?.disabled).toBe(true)
  })

  it('Pop-B: no quote yet keeps review disabled and fetches no relayer quote', async () => {
    const review = setup('B', undefined)
    expect(review.disabled).toBe(true)
    fireEvent.click(review)
    await new Promise(r => setTimeout(r, 50))
    expect(s.apiFetch).not.toHaveBeenCalled()
  })

  it('Pop-A: a non-zero quote is sent as the value', () => {
    const review = setup('A', { nativeFee: 5n, lzTokenFee: 0n })
    expect(review.disabled).toBe(false)
    expect(s.lastCall?.disabled).toBe(false)
    expect(s.lastCall?.value).toBe(5n)
  })

  it('Pop-B: a non-zero quote is priced once, with that fee', async () => {
    const review = setup('B', { nativeFee: 5n, lzTokenFee: 0n })
    fireEvent.click(review)
    await waitFor(() => expect(s.apiFetch).toHaveBeenCalledTimes(1))
    expect(s.apiFetch.mock.calls[0][0]).toBe('/api/sponsor/execute-quote?forwardedValueWei=5')
    await new Promise(r => setTimeout(r, 50))
    expect(s.apiFetch).toHaveBeenCalledTimes(1)
  })
})
