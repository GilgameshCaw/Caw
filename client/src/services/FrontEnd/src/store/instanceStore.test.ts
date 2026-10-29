/**
 * getApiHosts() feeds the redundant-peer broadcast in api/actions.ts, which
 * POSTs the signed action once per entry. One operator can have many active
 * registrations that share an apiUrl, so the list must hold each URL once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@wagmi/core', () => ({ getPublicClient: vi.fn() }))
vi.mock('~/config/Web3Provider', () => ({ wagmiConfig: {} }))

const inst = (instanceId: number, apiUrl: string, active = true) => ({
  instanceId,
  networkId: 1,
  owner: '0x0000000000000000000000000000000000000001',
  apiUrl,
  validatorAddress: '0x0000000000000000000000000000000000000002',
  active,
})

async function load(apiHost: string) {
  vi.resetModules()
  vi.doMock('~/api/client', () => ({ API_HOST: apiHost }))
  const mod = await import('./instanceStore')
  return mod.useInstanceStore
}

describe('useInstanceStore.getApiHosts', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('lists a URL once when several active instances share it', async () => {
    const store = await load('')
    store.setState({
      instances: [
        inst(1, 'https://a.example'),
        inst(2, 'https://a.example'),
        inst(3, 'https://b.example'),
        inst(4, 'https://a.example'),
      ],
    })
    expect(store.getState().getApiHosts()).toEqual(['https://a.example', 'https://b.example'])
  })

  it('keeps the first-seen order of distinct URLs', async () => {
    const store = await load('')
    store.setState({
      instances: [inst(1, 'https://b.example'), inst(2, 'https://a.example'), inst(3, 'https://b.example')],
    })
    expect(store.getState().getApiHosts()).toEqual(['https://b.example', 'https://a.example'])
  })

  it('puts VITE_API_HOST first and does not repeat it', async () => {
    const store = await load('https://home.example')
    store.setState({
      instances: [
        inst(1, 'https://a.example'),
        inst(2, 'https://home.example'),
        inst(3, 'https://home.example'),
        inst(4, 'https://a.example'),
      ],
    })
    expect(store.getState().getApiHosts()).toEqual(['https://home.example', 'https://a.example'])
  })

  it('ignores inactive instances', async () => {
    const store = await load('')
    store.setState({
      instances: [inst(1, 'https://a.example', false), inst(2, 'https://b.example')],
    })
    expect(store.getState().getApiHosts()).toEqual(['https://b.example'])
  })
})
