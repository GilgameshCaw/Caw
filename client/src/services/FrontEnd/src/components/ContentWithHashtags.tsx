// src/components/ContentWithHashtags.tsx
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import LinkPreview from './LinkPreview'
import { apiFetch } from '~/api/client'

// Cache for short URL original URLs
const shortUrlCache = new Map<string, string | null>()

// Component to render short URL images (fetches original URL)
const ShortUrlImage: React.FC<{
  code: string
  onError: (url: string) => void
  imageErrors: Set<string>
}> = ({ code, onError, imageErrors }) => {
  const [originalUrl, setOriginalUrl] = useState<string | null>(shortUrlCache.get(code) || null)
  const [loading, setLoading] = useState(!shortUrlCache.has(code))

  useEffect(() => {
    if (shortUrlCache.has(code)) {
      setOriginalUrl(shortUrlCache.get(code) || null)
      setLoading(false)
      return
    }

    const fetchOriginalUrl = async () => {
      try {
        const data = await apiFetch(`/api/shorturl/${code}`) as { originalUrl: string }
        shortUrlCache.set(code, data.originalUrl)
        setOriginalUrl(data.originalUrl)
      } catch (err) {
        console.error('Failed to fetch short URL:', err)
        shortUrlCache.set(code, null)
      } finally {
        setLoading(false)
      }
    }

    fetchOriginalUrl()
  }, [code])

  if (loading) {
    return (
      <div className="my-2 max-w-full h-48 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
    )
  }

  if (!originalUrl || imageErrors.has(originalUrl)) {
    return null
  }

  return (
    <div className="my-2 max-w-full">
      <img
        src={originalUrl}
        alt="Embedded content"
        className="max-w-full max-h-96 rounded-lg object-contain"
        loading="lazy"
        onError={() => onError(originalUrl)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

interface Props {
  content: string
  className?: string
}

// Regex to match Giphy URLs
const GIPHY_URL_REGEX = /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\/[^\s]+\.gif/gi

// Regex to match general image URLs (common formats)
const IMAGE_URL_REGEX = /https?:\/\/[^\s]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/gi

// Regex to match short URLs - both relative (/s/code) and absolute (https://domain.com/s/code)
// Supports optional file extensions like .gif, .jpg, etc.
const SHORT_URL_REGEX = /^(?:https?:\/\/[^\/]+)?\/s\/([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?)$/

/**
 * Component that renders text content with clickable hashtags and embedded images/GIFs
 */
const ContentWithHashtags: React.FC<Props> = ({ content, className = '' }) => {
  const navigate = useNavigate()
  const [imageErrors, setImageErrors] = useState<Set<string>>(new Set())

  const handleHashtagClick = (hashtag: string, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Remove # or $ symbol if present and navigate
    const cleanHashtag = hashtag.replace(/^[#$]/, '')
    navigate(`/hashtags/${cleanHashtag}`)
  }

  const handleMentionClick = (mention: string, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Remove @ symbol and navigate to user profile
    const username = mention.replace(/^@/, '')
    navigate(`/users/${username}`)
  }

  const handleImageError = (url: string) => {
    setImageErrors(prev => new Set(prev).add(url))
  }

  const isGiphyUrl = (url: string): boolean => {
    return /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\//i.test(url)
  }

  const isImageUrl = (url: string): boolean => {
    return /\.(?:gif|jpg|jpeg|png|webp)(?:\?|$)/i.test(url)
  }

  const isShortUrl = (url: string): boolean => {
    return SHORT_URL_REGEX.test(url)
  }

  const getShortUrlCode = (url: string): string | null => {
    const match = url.match(SHORT_URL_REGEX)
    return match ? match[1] : null
  }

  // Check if short URL code has a media extension (should be rendered as image)
  const isMediaShortUrl = (code: string): boolean => {
    return /\.(gif|jpg|jpeg|png|webp)$/i.test(code)
  }

  const parseTextWithHashtags = (text: string, keyPrefix: string) => {
    // Regular expression to match hashtags, cashtags, and @mentions
    // Supports international characters and numbers
    const specialRegex = /([@#$][a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+)/g

    const parts = text.split(specialRegex)

    return parts.map((part, index) => {
      // Check if this is an @mention
      if (part.startsWith('@')) {
        return (
          <button
            key={`${keyPrefix}-${index}`}
            onClick={(e) => handleMentionClick(part, e)}
            className={`
              hover:underline cursor-pointer transition-colors duration-200
              bg-transparent border-none p-0 m-0 font-inherit
              text-yellow-500 hover:text-yellow-600 dark:text-yellow-400 dark:hover:text-yellow-300
            `}
            title={`View ${part}'s profile`}
          >
            {part}
          </button>
        )
      }

      // Check if this is a hashtag or cashtag
      if (part.startsWith('#') || part.startsWith('$')) {
        return (
          <button
            key={`${keyPrefix}-${index}`}
            onClick={(e) => handleHashtagClick(part, e)}
            className={`
              hover:underline cursor-pointer transition-colors duration-200
              bg-transparent border-none p-0 m-0 font-inherit
              text-yellow-500 hover:text-yellow-600 dark:text-yellow-400 dark:hover:text-yellow-300
            `}
            title={`View posts with ${part}`}
          >
            {part}
          </button>
        )
      }

      // Regular text
      return part
    })
  }

  const parseContent = (text: string) => {
    // Split by lines first to handle URLs on their own lines
    const lines = text.split('\n')
    const result: React.ReactNode[] = []

    lines.forEach((line, lineIndex) => {
      const trimmedLine = line.trim()

      // Check if this line is a short URL
      if (isShortUrl(trimmedLine)) {
        const code = getShortUrlCode(trimmedLine)
        if (code) {
          // If it's a media short URL (has .gif, .jpg, etc.), render as image
          if (isMediaShortUrl(code)) {
            result.push(
              <ShortUrlImage
                key={`shortimg-${lineIndex}`}
                code={code}
                onError={handleImageError}
                imageErrors={imageErrors}
              />
            )
          } else {
            // Otherwise render as link preview card
            result.push(
              <LinkPreview
                key={`link-${lineIndex}`}
                code={code}
                className="my-2"
              />
            )
          }
        }
      // Check if this line is a Giphy URL or image URL
      } else if (isGiphyUrl(trimmedLine) || (isImageUrl(trimmedLine) && trimmedLine.startsWith('http'))) {
        // Don't show the URL as text if it failed to load
        if (imageErrors.has(trimmedLine)) {
          // Show as link if image failed
          result.push(
            <a
              key={`img-${lineIndex}`}
              href={trimmedLine}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-500 hover:underline break-all"
              onClick={(e) => e.stopPropagation()}
            >
              {trimmedLine}
            </a>
          )
        } else {
          // Render as embedded image/GIF
          result.push(
            <div key={`img-${lineIndex}`} className="my-2 max-w-full">
              <img
                src={trimmedLine}
                alt="Embedded content"
                className="max-w-full max-h-96 rounded-lg object-contain"
                loading="lazy"
                onError={() => handleImageError(trimmedLine)}
                onClick={(e) => e.stopPropagation()}
              />
            </div>
          )
        }
      } else if (trimmedLine) {
        // Regular text line with hashtag parsing
        result.push(
          <span key={`text-${lineIndex}`}>
            {parseTextWithHashtags(line, `line-${lineIndex}`)}
          </span>
        )
      }

      // Add line break between lines (but not after images, short URLs, or at the end)
      if (lineIndex < lines.length - 1 && !isGiphyUrl(trimmedLine) && !isImageUrl(trimmedLine) && !isShortUrl(trimmedLine)) {
        result.push(<br key={`br-${lineIndex}`} />)
      }
    })

    return result
  }

  return (
    <div className={className}>
      {parseContent(content)}
    </div>
  )
}

export default ContentWithHashtags