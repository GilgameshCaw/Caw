import React, { useEffect, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { HiOutlineExternalLink } from 'react-icons/hi'

interface LinkPreviewProps {
  code: string
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

// Cache for metadata to avoid repeated fetches
const metadataCache = new Map<string, ShortUrlMetadata | null>()

const LinkPreview: React.FC<LinkPreviewProps> = ({ code, className = '' }) => {
  const { isDark } = useTheme()
  const [metadata, setMetadata] = useState<ShortUrlMetadata | null>(metadataCache.get(code) || null)
  const [loading, setLoading] = useState(!metadataCache.has(code))
  const [error, setError] = useState(false)
  const [imageError, setImageError] = useState(false)

  useEffect(() => {
    if (metadataCache.has(code)) {
      setMetadata(metadataCache.get(code) || null)
      setLoading(false)
      return
    }

    const fetchMetadata = async () => {
      try {
        const data = await apiFetch(`/api/shorturl/${code}`) as ShortUrlMetadata
        metadataCache.set(code, data)
        setMetadata(data)
      } catch (err) {
        console.error('Failed to fetch link preview:', err)
        metadataCache.set(code, null)
        setError(true)
      } finally {
        setLoading(false)
      }
    }

    fetchMetadata()
  }, [code])

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
            {metadata.title}
          </h4>
        )}

        {/* Description */}
        {metadata.description && (
          <p className={`text-sm line-clamp-2 mt-1 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            {metadata.description}
          </p>
        )}
      </div>
    </a>
  )
}

export default LinkPreview
