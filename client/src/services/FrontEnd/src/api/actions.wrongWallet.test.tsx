// Real useSignAndSubmitAction, up to its first owner check. What it does after that isn't under test.
import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const s = vi.hoisted(() => ({
  OWNER: '0x1111111111111111111111111111111111111111', STRAY: '0x2222222222222222222222222222222222222222',
  account: { address: '0x2222222222222222222222222222222222222222' as string, isConnected: true },
  population: 'B' as 'A' | 'B',
}))
vi.mock('wagmi', () => ({
  useAccount: () => s.account, useChainId: () => 84532, useSwitchChain: () => ({ switchChainAsync: vi.fn() }),
  useSignTypedData: () => ({ signTypedDataAsync: vi.fn() }),
}))
vi.mock('wagmi/chains', () => ({ baseSepolia: { id: 84532 } }))
vi.mock('@wagmi/core', () => ({ readContract: vi.fn(async () => { throw new Error('past the owner check') }) }))
vi.mock('~/config/Web3Provider', () => ({ wagmiConfig: {} }))
vi.mock('~/hooks/useConnectModalBridge', () => ({ useConnectModalBridge: () => ({ openConnectModal: vi.fn() }) }))
vi.mock('~/hooks/useWalletPopulation', () => ({ useWalletPopulation: () => ({ population: s.population, address: s.OWNER, loading: false }) }))
vi.mock('~/hooks/useRootSigner', () => ({ useRootSigner: () => ({ kind: 'passkey', address: s.OWNER }) }))
// true so that signAndSubmit goes straight to requestAndSubmit for Pop-A too: the store below has no session.
vi.mock('~/hooks/useHasActiveSession', () => ({ useHasActiveSession: () => true }))
vi.mock('~/store/sessionKeyStore', () => {
  const st: any = { getActiveSessionForAddress: () => null, getActiveSession: () => null, enabled: false, sessions: {} }
  const f: any = (sel: any) => (sel ? sel(st) : st); f.getState = () => st
  return { useSessionKeyStore: f }
})
vi.mock('~/store/tokenDataStore', () => {
  const tok = { tokenId: 1, username: 'alice', address: s.OWNER, owner: s.OWNER, cawonce: 1, stakedAmount: 10n ** 30n }
  const st: any = { activeTokenId: 1, tokensByAddress: { [s.OWNER]: [tok] }, setCawonce: vi.fn() }
  const f: any = (sel: any) => (sel ? sel(st) : st); f.getState = () => st
  return { useActiveToken: () => tok, useTokenDataStore: f }
})
vi.mock('~/components/modals/QuickSignRenewModal', () => ({ useQuickSignRenewStore: { getState: () => ({ show: vi.fn() }), setState: vi.fn() } }))
vi.mock('~/components/modals/QuickSignModal', () => ({ useQuickSignPromptStore: { getState: () => ({ show: vi.fn(), skipOnce: true, suppressPrompt: true }), setState: vi.fn() } }))
vi.mock('./client', () => ({ apiFetch: vi.fn(async () => { throw new Error('past the owner check') }), retryOnIndexing: vi.fn(), API_HOST: '' }))

import { useSignAndSubmitAction } from './actions'

const WRONG = 'Wrong wallet connected. Please switch to the correct wallet.'
// Whatever the path does next stands in for "got past the check". It may reject or never settle here.
const outcome = async () => {
  const { result } = renderHook(() => useSignAndSubmitAction())
  const submit = (result.current as any)({ actionType: 'like', senderId: 1, receiverId: 2, receiverCawonce: 1, networkId: 1 } as any)
  return Promise.race([
    submit.then(() => 'past', (e: any) => e?.message ?? String(e)),
    new Promise(r => setTimeout(() => r('past'), 500)),
  ])
}

describe('useSignAndSubmitAction owner check', () => {
  it('stops Pop-A on the wrong wallet', async () => {
    s.population = 'A'
    expect(await outcome()).toBe(WRONG)
  })
  it('lets Pop-B with an unrelated wallet through to its passkey path', async () => {
    s.population = 'B'
    expect(await outcome()).not.toBe(WRONG)
  })
})
