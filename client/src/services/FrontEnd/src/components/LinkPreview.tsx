import React, { useEffect, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { HiOutlineExternalLink } from 'react-icons/hi'

interface LinkPreviewProps {
  code: string
  /**
   * Origin host for the short URL (e.g. "https://node-a.com"). When set,
   * the metadata fetch goes to that host's /api/shorturl/<code>. Used for
   * cross-node mirroring: a post created on Node A and rendered on Node B
   * still resolves correctly because Node A's DB is the source of truth
   * for that code. Undefined means "use the local API" (same-node post).
   */
  originHost?: string
  className?: string
}

interface ShortUrlMetadata {
  code: string
  originalUrl: string
  title?: string
  description?: string
  imageUrl?: string
  siteName?: string
  clickCount: number
}

// Cache for metadata to avoid repeated fetches. Keyed by `${host}|${code}`
// so the same code on two mirroring nodes doesn't share resolved values.
const metadataCache = new Map<string, ShortUrlMetadata | null>()
const cacheKey = (host: string | undefined, code: string) =>
  host ? `${host}|${code}` : code

// Defensive entity decode. The shorturl extractor stores raw og:title /
// og:description from upstream HTML attributes, which means values can
// arrive entity-encoded (`&amp;`, `&#39;`, etc.). The server-side fix
// decodes at write time going forward, but existing rows already contain
// encoded strings. Decoding at read keeps them readable without a DB
// migration. Identical helper to the one in api/routes/shorturl.ts —
// kept inline because it's 8 lines and only used here.
function decodeEntities(s: string | undefined): string {
  if (!s) return ''
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
}

const LinkPreview: React.FC<LinkPreviewProps> = ({ code, originHost, className = '' }) => {
  const { isDark } = useTheme()
  const ck = cacheKey(originHost, code)
  const [metadata, setMetadata] = useState<ShortUrlMetadata | null>(metadataCache.get(ck) || null)
  const [loading, setLoading] = useState(!metadataCache.has(ck))
  const [error, setError] = useState(false)
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    if (metadataCache.has(ck)) {
      setMetadata(metadataCache.get(ck) || null)
      setLoading(false)
      return
    }

    const fetchMetadata = async () => {
      try {
        let data: ShortUrlMetadata
        if (originHost) {
          // Cross-node short URL — fetch from the originating host directly,
          // not via apiFetch (which only reaches local + discovered instances).
          const res = await fetch(`${originHost}/api/shorturl/${code}`)
          if (!res.ok) throw new Error(`HTTP ${res.status}`)
          data = await res.json()
        } else {
          data = await apiFetch(`/api/shorturl/${code}`) as ShortUrlMetadata
        }
        metadataCache.set(ck, data)
        setMetadata(data)
      } catch (err) {
        console.error('Failed to fetch link preview:', err)
        metadataCache.set(ck, null)
        setError(true)
      } finally {
        setLoading(false)
      }
    }

    fetchMetadata()
  }, [ck, code, originHost])

  if (loading) {
    return (
      <div className={`animate-pulse rounded-xl border overflow-hidden ${
        isDark ? 'bg-white/5 border-white/10' : 'bg-gray-100 border-gray-200'
      } ${className}`}>
        <div className="p-3">
          <div className={`h-4 w-3/4 rounded ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
          <div className={`h-3 w-1/2 rounded mt-2 ${isDark ? 'bg-white/10' : 'bg-gray-200'}`} />
        </div>
      </div>
    )
  }

  if (error || !metadata) {
    return null // Don't show anything if we can't load the preview
  }

  const displayUrl = metadata.siteName || new URL(metadata.originalUrl).hostname.replace(/^www\./, '')

  return (
    <a
      href={metadata.originalUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={`block rounded-xl border overflow-hidden transition-colors ${
        isDark
          ? 'bg-white/5 border-white/10 hover:bg-white/10'
          : 'bg-gray-50 border-gray-200 hover:bg-gray-100'
      } ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Image Preview */}
      {metadata.imageUrl && !imageError && (
        <div className="w-full h-40 overflow-hidden bg-gray-900/20">
          <img
            src={metadata.imageUrl}
            alt={metadata.title || 'Link preview'}
            className="w-full h-full object-cover"
            onError={() => setImageError(true)}
            loading="lazy"
          />
        </div>
      )}

      {/* Content */}
      <div className="p-3">
        {/* Site name / Domain */}
        <div className={`flex items-center gap-1 text-xs mb-1 ${
          isDark ? 'text-gray-400' : 'text-gray-500'
        }`}>
          <HiOutlineExternalLink className="w-3 h-3" />
          <span>{displayUrl}</span>
        </div>

        {/* Title */}
        {metadata.title && (
          <h4 className={`font-medium line-clamp-2 ${
            isDark ? 'text-white' : 'text-gray-900'
          }`}>
            {decodeEntities(metadata.title)}
          </h4>
        )}

        {/* Description */}
        {metadata.description && (
          <p className={`text-sm line-clamp-2 mt-1 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            {decodeEntities(metadata.description)}
          </p>
        )}
      </div>
    </a>
  )
}

export default LinkPreview
