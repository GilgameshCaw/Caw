// Real useCreateSession. Which owner is a passkey user's session stored under?
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act } from '@testing-library/react'

const s = vi.hoisted(() => ({
  OWNER: '0x1111111111111111111111111111111111111111', STRAY: '0x2222222222222222222222222222222222222222',
  account: { address: undefined as string | undefined, isConnected: false },
  setSession: vi.fn(), setActiveWallet: vi.fn(), signMessage: vi.fn(async () => '0x' + 'cd'.repeat(65)), posted: [] as any[],
}))
vi.mock('wagmi', () => ({
  useAccount: () => s.account, useChainId: () => 84532, useSignMessage: () => ({ signMessageAsync: s.signMessage }),
  useSwitchChain: () => ({ switchChainAsync: vi.fn() }), usePublicClient: () => null,
}))
vi.mock('@wagmi/core', () => ({ readContract: vi.fn(), getPublicClient: () => null }))
vi.mock('~/config/wagmiConfig', () => ({ wagmiConfig: {} }))
vi.mock('~/hooks/useConnectModalBridge', () => ({ useConnectModalBridge: () => ({ openConnectModal: vi.fn() }) }))
vi.mock('~/hooks/useRootSigner', () => ({
  useRootSigner: () => ({ kind: 'passkey', address: s.OWNER, ensureReady: async () => {}, signDigest: async () => '0x' + 'ab'.repeat(65), signMessage: async () => '0x' }),
}))
vi.mock('~/components/identity/RecoveryProvider', () => ({ useRecoveryContext: () => ({ privateKey: null, address: null, isInRecoveryMode: false }) }))
vi.mock('~/store/sessionKeyStore', () => {
  const st: any = { setSession: s.setSession, setActiveWallet: s.setActiveWallet, setEnabled: vi.fn(), setDecryptedKey: vi.fn() }
  const f: any = (sel: any) => sel(st); f.getState = () => st
  return { useSessionKeyStore: f, setDecryptedKey: vi.fn(), DEFAULT_SCOPE: 0xbf, getEncryptionSignMessage: () => 'x', encryptPrivateKey: vi.fn(async () => 'enc') }
})
vi.mock('~/store/tokenDataStore', () => ({
  useActiveToken: () => ({ tokenId: 1, username: 'alice', owner: s.OWNER, address: s.OWNER }),
  usePriceStore: (sel: any) => sel({ priceMap: {} }),
}))
vi.mock('~/api/client', () => ({
  apiFetch: vi.fn(async (url: string, opts: any) => {
    if (url === '/api/sessions') { s.posted.push(JSON.parse(opts.body)); return { requestId: 'r1', status: 'pending' } }
    if (url.startsWith('/api/sessions/status/')) return { status: 'confirmed', txHash: '0x1', blockNumber: 1 }
    throw new Error('roam path not under test: ' + url)
  }),
}))
vi.mock('~/services/identity/passkey', () => ({ enrollPasskey: vi.fn(), signWithPasskey: vi.fn(async () => ({ sig: '0x', prfSecret: undefined })), passkeyHexToBytes: vi.fn() }))
vi.mock('~/services/identity/eip7702', () => ({ signAuthorizationTuple: vi.fn() }))
vi.mock('~/constants/passkeyStorage', () => ({ getPasskeyCredential: () => null, isPasskeyAddress: () => true }))
vi.mock('~/services/identity/sessionPrf', () => ({ wrapSessionKeyWithPrf: vi.fn(), unwrapSessionKeyWithPrf: vi.fn(), saveSessionRoamMeta: vi.fn() }))
vi.mock('~/services/identity/prf', () => ({ buildPrfSalt: vi.fn(), markPrfCapable: vi.fn(), prfCapableForCredential: () => null }))

import { useCreateSession } from '~/hooks/useSessionKey'

async function create(account: any, walletProtect = false) {
  s.account = account; s.setSession.mockClear(); s.setActiveWallet.mockClear(); s.signMessage.mockClear(); s.posted.length = 0
  const { result } = renderHook(() => useCreateSession())
  await act(async () => { await result.current(undefined, 10_000_000n, 3600, walletProtect, 0n) })
  return s.setSession.mock.calls[0]?.[0]
}

describe('useCreateSession, Pop-B', () => {
  it('stores under the owner with no wallet connected', async () => {
    expect((await create({ address: undefined, isConnected: false })).ownerAddress).toBe(s.OWNER)
  }, 20000)

  it('stores under the owner, not an unrelated connected wallet', async () => {
    const session = await create({ address: s.STRAY, isConnected: true })
    expect(s.posted[0].signer.toLowerCase()).toBe(s.OWNER)
    expect(session.ownerAddress).toBe(s.OWNER)
    expect(s.setActiveWallet).toHaveBeenCalledWith(s.OWNER)
  }, 20000)

  it('does not ask an unrelated wallet to protect the key', async () => {
    const session = await create({ address: s.STRAY, isConnected: true }, true)
    expect(s.signMessage).not.toHaveBeenCalled()
    expect(session.encrypted).toBeUndefined()
  }, 20000)

  it('still lets the owner address reflected in a wallet protect it', async () => {
    const session = await create({ address: s.OWNER, isConnected: true }, true)
    expect(s.signMessage).toHaveBeenCalledTimes(1)
    expect(session.encrypted).toBe(true)
    expect(session.ownerAddress).toBe(s.OWNER)
  }, 20000)
})
