import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '~/api/client'

export function useCachedFetch<T = unknown>(
  key: string,
  cache: Map<string, string | null>,
  endpoint: string,
  extractUrl: (data: T) => string
): { url: string | null; loading: boolean } {
  const [url, setUrl] = useState<string | null>(cache.get(key) || null)
  const [loading, setLoading] = useState(!cache.has(key))
  const cacheRef = useRef(cache)
  const extractRef = useRef(extractUrl)
  cacheRef.current = cache
  extractRef.current = extractUrl

  useEffect(() => {
    const c = cacheRef.current
    if (c.has(key)) {
      setUrl(c.get(key) || null)
      setLoading(false)
      return
    }

    const fetchData = async () => {
      try {
        const data = await apiFetch<T>(endpoint)
        const resolved = extractRef.current(data as T)
        c.set(key, resolved)
        setUrl(resolved)
      } catch (err) {
        console.error(`Failed to fetch ${endpoint}:`, err)
        c.set(key, null)
      } finally {
        setLoading(false)
      }
    }

    fetchData()
  }, [key, endpoint])

  return { url, loading }
}
