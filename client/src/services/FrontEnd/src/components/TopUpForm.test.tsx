/**
 * TopUpForm.test.tsx
 *
 * CAW tab of the passkey "add funds" form: the relayer fee is paid in CAW from the same balance as
 * the deposit (batch: approve, depositFor(amount), CAW.transfer(relayer, fee)), so a deposit that
 * leaves less than the fee cannot be sent. Wagmi, the quote API and the executor are mocked.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { decodeFunctionData, erc20Abi } from 'viem'
import { cawProfileAbi } from '../../../../abi/generated'

type Call = { to: string; value: bigint; data: `0x${string}` }
const h = vi.hoisted(() => ({ batches: [] as { to: string; value: bigint; data: `0x${string}` }[][] }))
const EOA = '0x1111111111111111111111111111111111111111' as const
const RELAYER = '0x2222222222222222222222222222222222222222'
const CAW = '0x3333333333333333333333333333333333333333'
const E18 = 10n ** 18n
const FEE = 3n * E18

vi.mock('wagmi', () => ({
  useReadContract: (a: { functionName?: string }) => ({ data: a.functionName === 'depositQuote' ? { nativeFee: 1000n } : undefined }),
}))
vi.mock('~/api/client', () => ({
  apiFetch: async () => ({
    relayer: '0x2222222222222222222222222222222222222222',
    minFeeCawWei: (3n * 10n ** 18n).toString(),
    minFeeEthWei: '1',
    priceAvailable: true,
    cawAddress: '0x3333333333333333333333333333333333333333',
  }),
}))
vi.mock('~/hooks/useSmartEoaExecute', () => ({
  useSmartEoaExecute: () => ({
    execute: async (calls: Call[]) => { h.batches.push(calls); return '0xabc' },
    account: '0x1111111111111111111111111111111111111111',
  }),
}))
vi.mock('~/hooks/useTheme', () => ({ useTheme: () => ({ isDark: false }) }))
vi.mock('~/store/tokenDataStore', () => ({ usePriceStore: (sel: (s: { priceMap: Record<string, number> }) => unknown) => sel({ priceMap: {} }) }))
vi.mock('~/hooks/useZapQuote', () => ({
  usePoolReserves: () => ({ loaded: false, wethReserve: 0n }),
  useMinCawOut: () => ({ loaded: false }),
  suggestedSlippageBps: () => 200,
}))
// The key and its parameters, so the tests can read what the form would show.
vi.mock('~/i18n/I18nProvider', () => ({ useT: () => (k: string, p?: object) => (p ? `${k} ${JSON.stringify(p)}` : k) }))
vi.mock('~/config/chains', () => ({ chains: { l1: { chainId: 1 }, l2: { layerZero: 2 } } }))
vi.mock('~/api/actions', () => ({ CLIENT_ID: 1 }))
vi.mock('~/utils', () => ({ handleError: () => {} }))
vi.mock('~/../../../abi/addresses', () => ({
  CAW_ADDRESS: '0x3333333333333333333333333333333333333333',
  CAW_NAMES_ADDRESS: '0x4444444444444444444444444444444444444444',
  CAW_NAMES_MINTER_ADDRESS: '0x5555555555555555555555555555555555555555',
  CAW_NAME_QUOTER_ADDRESS: '0x6666666666666666666666666666666666666666',
  CAW_PAIR_ADDRESS: '0x7777777777777777777777777777777777777777',
}))

import { TopUpForm } from './TopUpForm'

const button = (text: string | RegExp) => screen.getByText(text).closest('button') as HTMLButtonElement

/** Types an amount (or presses the balance label), opens the review panel and waits for the fee quote. */
async function review(balance: bigint, typed: string | 'balance-label') {
  render(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={balance} ethBalanceWei={10n ** 18n} />)
  if (typed === 'balance-label') fireEvent.click(screen.getByText(/topup\.balance/))
  else fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: typed } })
  await waitFor(() => expect(button('topup.review_button').disabled).toBe(false))
  fireEvent.click(button('topup.review_button'))
  await waitFor(() => expect(screen.queryByText('topup.fetching_quote')).toBeNull())
  await screen.findByText('topup.confirm_button')
}

function sentBatch() {
  const calls = h.batches[0]
  const approve = decodeFunctionData({ abi: erc20Abi, data: calls[0].data })
  const dep = decodeFunctionData({ abi: cawProfileAbi, data: calls[1].data })
  const fee = decodeFunctionData({ abi: erc20Abi, data: calls[2].data })
  return { approve: approve.args![1] as bigint, deposit: (dep.args as readonly unknown[])[2] as bigint, fee: fee.args![1] as bigint, feeTo: String(fee.args![0]).toLowerCase(), feeToken: String(calls[2].to).toLowerCase() }
}

describe('TopUpForm CAW tab: the relayer fee comes out of the same CAW balance', () => {
  beforeEach(() => { h.batches.length = 0 })

  it('holds back a deposit of the whole balance, says why, and sends nothing', async () => {
    await review(100n * E18, 'balance-label')
    expect(await screen.findByText(/topup\.fee_not_covered/)).toBeTruthy()
    expect(screen.getByText(/topup\.fee_not_covered/).textContent).toContain('"fee":"3"')
    expect(button('topup.confirm_button').disabled).toBe(true)
    fireEvent.click(button('topup.confirm_button'))
    expect(h.batches.length).toBe(0)
  })

  it('offers the balance minus the fee, and the batch it then sends fits the balance', async () => {
    await review(100n * E18, 'balance-label')
    const useMax = await screen.findByText(/topup\.use_max_deposit/)
    expect(useMax.textContent).toContain('"amount":"97"')
    fireEvent.click(useMax)
    await waitFor(() => expect(button('topup.confirm_button').disabled).toBe(false))
    expect(screen.queryByText(/topup\.fee_not_covered/)).toBeNull()
    fireEvent.click(button('topup.confirm_button'))
    await waitFor(() => expect(h.batches.length).toBe(1))
    const b = sentBatch()
    expect(b.deposit).toBe(97n * E18)
    expect(b.approve).toBe(97n * E18)
    expect(b.fee).toBe(FEE)
    expect(b.deposit + b.fee).toBe(100n * E18)
  })

  it('sends an amount that leaves room for the fee, as before', async () => {
    await review(100n * E18, '50')
    expect(screen.queryByText(/topup\.fee_not_covered/)).toBeNull()
    fireEvent.click(button('topup.confirm_button'))
    await waitFor(() => expect(h.batches.length).toBe(1))
    const b = sentBatch()
    expect(b.deposit).toBe(50n * E18)
    expect(b.feeTo).toBe(RELAYER)
    expect(b.feeToken).toBe(CAW)
  })

  it('allows an amount that leaves exactly the fee', async () => {
    await review(100n * E18, '97')
    expect(screen.queryByText(/topup\.fee_not_covered/)).toBeNull()
    expect(button('topup.confirm_button').disabled).toBe(false)
  })

  it('holds back an amount that leaves one unit less than the fee', async () => {
    await review(100n * E18, '97.000000000000000001')
    expect(await screen.findByText(/topup\.fee_not_covered/)).toBeTruthy()
    expect(button('topup.confirm_button').disabled).toBe(true)
  })

  it('offers no smaller deposit when the balance does not even cover the fee', async () => {
    await review(2n * E18, '1')
    // Nothing smaller would work, so it does not say "deposit a little less".
    expect(await screen.findByText(/topup\.balance_below_fee/)).toBeTruthy()
    expect(screen.queryByText(/topup\.fee_not_covered/)).toBeNull()
    expect(screen.queryByText(/topup\.use_max_deposit/)).toBeNull()
    expect(button('topup.confirm_button').disabled).toBe(true)
  })
})
