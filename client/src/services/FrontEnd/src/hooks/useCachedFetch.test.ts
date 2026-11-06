import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useCachedFetch } from './useCachedFetch'

const api = vi.hoisted(() => ({ body: null as unknown }))

vi.mock('~/api/client', () => ({ apiFetch: vi.fn(async () => api.body) }))

const extract = (data: { originalUrl: string }) => data.originalUrl

async function resolve(endpoint: string, body: unknown, cache = new Map<string, string | null>()) {
  api.body = body
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => body })))
  const { result } = renderHook(() => useCachedFetch('key', cache, endpoint, extract))
  await waitFor(() => expect(result.current.loading).toBe(false))
  return { url: result.current.url, cache }
}

describe('useCachedFetch', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('resolves an http(s) URL from another node', async () => {
    const { url, cache } = await resolve('https://other-node.example/api/shorturl/x', {
      originalUrl: 'https://example.com/a',
    })
    expect(url).toBe('https://example.com/a')
    expect(cache.get('key')).toBe('https://example.com/a')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('resolves an http(s) URL through the local API', async () => {
    const { url } = await resolve('/api/shorturl/x', { originalUrl: 'http://example.com/a' })
    expect(url).toBe('http://example.com/a')
    expect(fetch).not.toHaveBeenCalled()
  })

  it.each([
    ['missing', {}],
    ['a number', { originalUrl: 42 }],
    ['an object', { originalUrl: { href: 'https://example.com' } }],
    ['empty', { originalUrl: '' }],
    ['not a URL', { originalUrl: 'not a url' }],
    ['a data: URL', { originalUrl: 'data:text/plain,x' }],
    ['a javascript: URL', { originalUrl: 'javascript:void(0)' }],
  ])('resolves to null and caches that when originalUrl is %s', async (_name, body) => {
    const { url, cache } = await resolve('https://other-node.example/api/shorturl/x', body)
    expect(url).toBeNull()
    expect(cache.has('key')).toBe(true)
    expect(cache.get('key')).toBeNull()
  })

  it('resolves to null when the body is null', async () => {
    const { url, cache } = await resolve('https://other-node.example/api/shorturl/x', null)
    expect(url).toBeNull()
    expect(cache.get('key')).toBeNull()
  })
})
