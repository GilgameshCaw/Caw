/**
 * useValidatorMinTips() reports `total` next to minTipsMap, which is keyed by
 * apiUrl. countAcceptingValidators() computes accepting = total - rejecting,
 * where rejecting counts map entries. If `total` counts registrations instead
 * of URLs, a URL registered many times is one rejecting entry against many
 * counted validators.
 */

import { createElement, type ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi } from 'vitest'

vi.mock('@wagmi/core', () => ({ getPublicClient: vi.fn() }))
vi.mock('~/config/Web3Provider', () => ({ wagmiConfig: {} }))
vi.mock('~/api/client', () => ({ API_HOST: '' }))

import { uniqueByApiUrl, countAcceptingValidators } from './useValidatorMinTips'

const inst = (instanceId: number, apiUrl: string) => ({ instanceId, apiUrl })

describe('uniqueByApiUrl', () => {
  it('keeps the first entry per URL, in first-seen order', () => {
    const out = uniqueByApiUrl([
      inst(1, 'https://b.example'),
      inst(2, 'https://a.example'),
      inst(3, 'https://b.example'),
      inst(4, 'https://a.example'),
    ])
    expect(out.map(i => i.instanceId)).toEqual([1, 2])
  })

  it('returns an empty list for an empty list', () => {
    expect(uniqueByApiUrl([])).toEqual([])
  })
})

describe('useValidatorMinTips with duplicate registrations', () => {
  // Two URLs: A (floor above the ceiling) is registered 18 times, B accepts.
  const registrations = [
    ...Array.from({ length: 18 }, (_, i) => ({ ...inst(i + 1, 'https://a.example'), networkId: 1, owner: '0x1', validatorAddress: '0x2', active: true })),
    { ...inst(19, 'https://b.example'), networkId: 1, owner: '0x1', validatorAddress: '0x2', active: true },
  ]

  it('reports one validator per URL, so 1 of 2 accept instead of 18 of 19', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => ({
      ok: true,
      json: async () => ({ minTipPerActionWei: url.startsWith('https://a.example') ? String(10n ** 15n) : '0' }),
    })))
    const { useInstanceStore } = await import('~/store/instanceStore')
    useInstanceStore.setState({ instances: registrations })
    const { useValidatorMinTips } = await import('./useValidatorMinTips')

    const client = new QueryClient()
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children)
    const { result } = renderHook(() => useValidatorMinTips(), { wrapper })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    const { minTipsMap, total } = result.current
    expect(total).toBe(2)
    // ceiling 0 CAW -> ceilingWei 0 -> only floor-0 validators accept
    const { accepting } = countAcceptingValidators(minTipsMap, total, 0n, 0, 0)
    expect({ accepting, total }).toEqual({ accepting: 1, total: 2 })
  })
})
