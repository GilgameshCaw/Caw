/**
 * apiFetch: the error for a non-2xx answer carries the status, and the server's
 * Retry-After when it sent one, along with the message it always had.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

// apiFetch reads these stores only to build its headers and pick a host. The
// real ones pull in the wallet setup, which this test has no use for.
vi.mock('~/store/tokenDataStore', () => ({ useTokenDataStore: { getState: () => ({ tokensByAddress: {}, activeTokenId: undefined }) } }))
vi.mock('~/store/authStore', () => ({ useAuthStore: { getState: () => ({ sessionToken: null }) } }))
vi.mock('~/store/verifyWalletStore', () => ({ useVerifyWalletStore: { getState: () => ({ show: () => {} }) } }))
vi.mock('~/store/instanceStore', () => ({ useInstanceStore: { getState: () => ({ activeApiHost: undefined, setActiveApiHost: () => {} }) } }))

import { apiFetch, type ApiStatusError } from './client'

afterEach(() => { vi.unstubAllGlobals() })

const answer = (res: unknown) => vi.stubGlobal('fetch', vi.fn(async () => res))
const failure = async (): Promise<ApiStatusError> => {
  try {
    await apiFetch('/api/translate', { method: 'POST', body: '{}' })
  } catch (e) {
    return e as ApiStatusError
  }
  throw new Error('apiFetch did not throw')
}

describe('apiFetch errors', () => {
  it('a 429 carries its status and the Retry-After, and keeps its message', async () => {
    answer(new Response(
      JSON.stringify({ error: 'Translation rate limit exceeded. Please try again in a minute.' }),
      { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '42' } },
    ))
    const err = await failure()
    expect(err.message).toBe('API 429: Translation rate limit exceeded. Please try again in a minute.')
    expect(err.status).toBe(429)
    expect(err.retryAfterSeconds).toBe(42)
  })

  it('an error without a Retry-After has a status and no retryAfterSeconds', async () => {
    answer(new Response(JSON.stringify({ error: 'Internal error' }), { status: 500 }))
    const err = await failure()
    expect(err.message).toBe('API 500: Internal error')
    expect(err.status).toBe(500)
    expect(err.retryAfterSeconds).toBeUndefined()
  })

  it('a Retry-After that is not a number is left out', async () => {
    answer(new Response('{}', { status: 503, headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } }))
    const err = await failure()
    expect(err.status).toBe(503)
    expect(err.retryAfterSeconds).toBeUndefined()
  })

  it('an answer object with no headers still gives the error', async () => {
    answer({ ok: false, status: 502, statusText: 'Bad Gateway', json: async () => ({}) })
    const err = await failure()
    expect(err.message).toBe('API 502 Bad Gateway')
    expect(err.status).toBe(502)
  })
})
