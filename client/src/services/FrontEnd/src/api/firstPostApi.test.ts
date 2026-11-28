import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { apiFetch, CawonceCollisionError, IndexingError } from './client'

const store = vi.hoisted(() => ({
  state: { activeApiHost: undefined as string | undefined },
  sessionToken: undefined as string | undefined,
}))
vi.mock('~/store/tokenDataStore', () => ({
  useTokenDataStore: { getState: () => ({ tokensByAddress: {}, activeTokenId: undefined }) },
}))
vi.mock('~/store/authStore', () => ({
  useAuthStore: { getState: () => ({ sessionToken: store.sessionToken }) },
}))
vi.mock('~/store/verifyWalletStore', () => ({
  useVerifyWalletStore: { getState: () => ({ show: vi.fn() }) },
}))
vi.mock('~/store/instanceStore', () => ({
  useInstanceStore: { getState: () => ({
    activeApiHost: store.state.activeApiHost,
    setActiveApiHost: (host: string) => { store.state.activeApiHost = host },
  }) },
}))

const fixturePayload = JSON.stringify({ data: { text: 'test fixture' }, signature: 'mock-only' })
const result = (status: number, body: object) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
})
const post = () => apiFetch('/api/actions', { method: 'POST', body: fixturePayload })

describe('frontend API client during a first post', () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('fetch', fetchMock)
    store.state.activeApiHost = undefined
    store.sessionToken = undefined
  })
  afterEach(() => vi.unstubAllGlobals())

  it('loads the public feed from the site API without a wallet session', async () => {
    fetchMock.mockResolvedValue(result(200, { items: [] }))
    await expect(apiFetch('/api/caws')).resolves.toEqual({ items: [] })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/caws', expect.any(Object))
    expect(fetchMock.mock.calls[0][1].headers).not.toHaveProperty('x-session-token')
  })

  it('sends the already-signed fixture to its own selected API', async () => {
    store.state.activeApiHost = 'https://caw.example.invalid'
    store.sessionToken = 'isolated-session'
    fetchMock.mockResolvedValue(result(200, { txQueueId: 42 }))
    await expect(post()).resolves.toEqual({ txQueueId: 42 })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://caw.example.invalid/api/actions',
      expect.objectContaining({ method: 'POST', body: fixturePayload, headers: expect.objectContaining({
        'x-session-token': 'isolated-session',
      }) }))
  })

  it('reports pending profile indexing without treating the post as accepted', async () => {
    fetchMock.mockResolvedValue(result(202, { error: 'still indexing', retryAfterSeconds: 2 }))
    const submission = post()
    await expect(submission).rejects.toBeInstanceOf(IndexingError)
    await expect(submission).rejects.toMatchObject({ retryAfterSeconds: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports a duplicate sequence so the caller can obtain a new signature', async () => {
    fetchMock.mockResolvedValue(result(409, { error: 'cawonce_collision', suggestedCawonce: 17 }))
    const submission = post()
    await expect(submission).rejects.toBeInstanceOf(CawonceCollisionError)
    await expect(submission).rejects.toMatchObject({ suggestedCawonce: 17 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
