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
type LzQuoteResult = { data?: { nativeFee: bigint }; isFetching?: boolean; isError?: boolean }
const h = vi.hoisted(() => ({
  batches: [] as { to: string; value: bigint; data: `0x${string}` }[][],
  lzQuote: null as null | ((amountWei: bigint) => LzQuoteResult),
  sponsorQuote: null as null | ((url: string) => Promise<{
    relayer: string
    minFeeCawWei: string
    minFeeEthWei: string
    priceAvailable: boolean
    cawAddress: string
  }>),
}))
const EOA = '0x1111111111111111111111111111111111111111' as const
const RELAYER = '0x2222222222222222222222222222222222222222'
const CAW = '0x3333333333333333333333333333333333333333'
const E18 = 10n ** 18n
const FEE = 3n * E18

vi.mock('wagmi', () => ({
  useReadContract: (a: { functionName?: string; args?: readonly unknown[] }) => {
    if (a.functionName !== 'depositQuote') return { data: undefined }
    if (h.lzQuote) return h.lzQuote(a.args?.[2] as bigint)
    return { data: { nativeFee: 1000n } }
  },
}))
vi.mock('~/api/client', () => ({
  apiFetch: async (url: string) => {
    if (h.sponsorQuote) return h.sponsorQuote(url)
    return {
      relayer: '0x2222222222222222222222222222222222222222',
      minFeeCawWei: (3n * 10n ** 18n).toString(),
      minFeeEthWei: '1',
      priceAvailable: true,
      cawAddress: '0x3333333333333333333333333333333333333333',
    }
  },
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
  beforeEach(() => {
    h.batches.length = 0
    h.lzQuote = null
    h.sponsorQuote = null
  })

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

  it('holds confirmation disabled while the replacement LayerZero quote is unresolved after selecting max deposit', async () => {
    // Only the initial 100 CAW amount has a resolved LZ quote; 97 CAW remains unresolved.
    h.lzQuote = (amountWei) => (amountWei === 100n * E18 ? { data: { nativeFee: 7n } } : { data: undefined })
    await review(100n * E18, 'balance-label')

    const useMax = await screen.findByText(/topup\.use_max_deposit/)
    fireEvent.click(useMax)

    // While the 97 CAW LZ quote is unresolved, confirm must stay disabled and send nothing.
    expect(button('topup.confirm_button').disabled).toBe(true)
    fireEvent.click(button('topup.confirm_button'))
    expect(h.batches.length).toBe(0)
  })

  it('holds confirmation disabled while depositQuote is fetching with stale previous data', async () => {
    let fetching = false
    h.lzQuote = () => ({ data: { nativeFee: 7n }, isFetching: fetching })
    const { rerender } = render(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    fireEvent.change(screen.getByPlaceholderText('0.0'), { target: { value: '50' } })
    await waitFor(() => expect(button('topup.review_button').disabled).toBe(false))
    fireEvent.click(button('topup.review_button'))
    await waitFor(() => expect(screen.queryByText('topup.fetching_quote')).toBeNull())
    expect(button('topup.confirm_button').disabled).toBe(false)

    fetching = true
    rerender(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    expect(button('topup.confirm_button').disabled).toBe(true)
    fireEvent.click(button('topup.confirm_button'))
    expect(h.batches.length).toBe(0)
  })

  it('waits for both replacement quotes and re-evaluates affordability if the new LZ fee raises the CAW relayer fee', async () => {
    let quote97: LzQuoteResult = { data: undefined }
    h.lzQuote = (amountWei) => (amountWei === 100n * E18 ? { data: { nativeFee: 7n } } : quote97)
    h.sponsorQuote = async (url) => ({
      relayer: RELAYER,
      minFeeCawWei: (url.includes('forwardedValueWei=9') ? 4n * E18 : 3n * E18).toString(),
      minFeeEthWei: '1',
      priceAvailable: true,
      cawAddress: CAW,
    })

    const { rerender } = render(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    fireEvent.click(screen.getByText(/topup\.balance/))
    await waitFor(() => expect(button('topup.review_button').disabled).toBe(false))
    fireEvent.click(button('topup.review_button'))
    await waitFor(() => expect(screen.queryByText('topup.fetching_quote')).toBeNull())

    const useMax = await screen.findByText(/topup\.use_max_deposit/)
    fireEvent.click(useMax)
    expect(button('topup.confirm_button').disabled).toBe(true)

    // Replacement LZ quote arrives with higher fee (9 -> relayer fee becomes 4 CAW, so 97 + 4 > 100).
    quote97 = { data: { nativeFee: 9n } }
    rerender(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    await waitFor(() => expect(screen.queryByText('topup.fetching_quote')).toBeNull())

    expect(await screen.findByText(/topup\.fee_not_covered/)).toBeTruthy()
    expect(screen.getByText(/topup\.fee_not_covered/).textContent).toContain('"fee":"4"')
    expect(button('topup.confirm_button').disabled).toBe(true)
    expect(h.batches.length).toBe(0)
  })

  it('re-enables confirmation and sends the updated LayerZero fee once both replacement quotes resolve', async () => {
    let quote97: LzQuoteResult = { data: undefined }
    h.lzQuote = (amountWei) => (amountWei === 100n * E18 ? { data: { nativeFee: 7n } } : quote97)
    h.sponsorQuote = async () => ({
      relayer: RELAYER,
      minFeeCawWei: FEE.toString(),
      minFeeEthWei: '1',
      priceAvailable: true,
      cawAddress: CAW,
    })

    const { rerender } = render(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    fireEvent.click(screen.getByText(/topup\.balance/))
    await waitFor(() => expect(button('topup.review_button').disabled).toBe(false))
    fireEvent.click(button('topup.review_button'))
    await waitFor(() => expect(screen.queryByText('topup.fetching_quote')).toBeNull())

    fireEvent.click(await screen.findByText(/topup\.use_max_deposit/))
    expect(button('topup.confirm_button').disabled).toBe(true)

    quote97 = { data: { nativeFee: 8n } }
    rerender(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    await waitFor(() => expect(button('topup.confirm_button').disabled).toBe(false))

    fireEvent.click(button('topup.confirm_button'))
    await waitFor(() => expect(h.batches.length).toBe(1))
    expect(h.batches[0][1].value).toBe(8n)
    const b = sentBatch()
    expect(b.deposit).toBe(97n * E18)
    expect(b.fee).toBe(FEE)
  })

  it('refreshes and waits for the sponsor quote when depositFee resolves to the same nativeFee for the updated amount', async () => {
    h.lzQuote = () => ({ data: { nativeFee: 7n } })
    let resolveSecondSponsor: ((v: {
      relayer: string
      minFeeCawWei: string
      minFeeEthWei: string
      priceAvailable: boolean
      cawAddress: string
    }) => void) | null = null
    let sponsorCalls = 0
    h.sponsorQuote = async () => {
      sponsorCalls++
      if (sponsorCalls === 1) {
        return { relayer: RELAYER, minFeeCawWei: FEE.toString(), minFeeEthWei: '1', priceAvailable: true, cawAddress: CAW }
      }
      return new Promise(resolve => { resolveSecondSponsor = resolve })
    }

    render(<TopUpForm tokenId={7} eoaAddress={EOA} cawBalanceWei={100n * E18} ethBalanceWei={10n ** 18n} />)
    fireEvent.click(screen.getByText(/topup\.balance/))
    await waitFor(() => expect(button('topup.review_button').disabled).toBe(false))
    fireEvent.click(button('topup.review_button'))
    await waitFor(() => expect(screen.queryByText('topup.fetching_quote')).toBeNull())

    // Max deposit changes amountWei from 100 to 97, while depositQuote resolves to the same 7n.
    fireEvent.click(await screen.findByText(/topup\.use_max_deposit/))
    await waitFor(() => expect(sponsorCalls).toBe(2))

    // Confirm must stay disabled until the refreshed sponsor quote resolves.
    expect(button('topup.confirm_button').disabled).toBe(true)
    fireEvent.click(button('topup.confirm_button'))
    expect(h.batches.length).toBe(0)

    resolveSecondSponsor!({ relayer: RELAYER, minFeeCawWei: FEE.toString(), minFeeEthWei: '1', priceAvailable: true, cawAddress: CAW })
    await waitFor(() => expect(button('topup.confirm_button').disabled).toBe(false))
    fireEvent.click(button('topup.confirm_button'))
    await waitFor(() => expect(h.batches.length).toBe(1))
    expect(sentBatch().deposit).toBe(97n * E18)
  })
})
