import { useState, useEffect, useRef } from 'react'
import { apiFetch } from '~/api/client'

/**
 * Cached lookup that resolves an endpoint to a URL string and dedupes
 * across all callers via the shared `cache` map.
 *
 * `endpoint` is normally a relative path ("/api/foo") routed through
 * apiFetch, which handles instance-host failover. If the path is a
 * fully-qualified URL ("https://other-node.com/api/foo"), it bypasses
 * apiFetch and hits that host directly — used for cross-node short-URL
 * resolution where the answer only exists on the originating node's DB.
 */
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
        let data: T
        if (/^https?:\/\//.test(endpoint)) {
          // Cross-origin fetch — bypass apiFetch's instance-host failover
          // since the data only exists on this specific host.
          const res = await fetch(endpoint)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          data = await res.json()
        } else {
          data = await apiFetch<T>(endpoint)
        }
        const resolved = extractRef.current(data)
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
