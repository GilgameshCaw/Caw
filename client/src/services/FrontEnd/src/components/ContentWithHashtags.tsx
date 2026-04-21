// src/components/ContentWithHashtags.tsx
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import LinkPreview from './LinkPreview'
import Tooltip from '~/components/Tooltip'
import { useCachedFetch } from '~/hooks/useCachedFetch'
import { useTheme } from '~/hooks/useTheme'

// Caches
const shortUrlCache = new Map<string, string | null>()

// Shared loading skeleton
const MediaSkeleton = () => (
  <div className="my-2 max-w-full h-48 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
)

// Component to render short URL images
const ShortUrlImage: React.FC<{
  code: string
  onError: (url: string) => void
  imageErrors: Set<string>
}> = ({ code, onError, imageErrors }) => {
  const { url: originalUrl, loading } = useCachedFetch(
    code,
    shortUrlCache,
    `/api/shorturl/${code}`,
    (data: { originalUrl: string }) => data.originalUrl
  )

  if (loading) return <MediaSkeleton />
  if (!originalUrl || imageErrors.has(originalUrl)) return null

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

// Component to render an inline short URL link — shows the original URL
// (truncated) as link text, but the href points to the short URL for analytics.
const ShortUrlLink: React.FC<{ code: string; shortHref: string }> = ({ code, shortHref }) => {
  const { isDark } = useTheme()
  const { url: originalUrl, loading } = useCachedFetch(
    code,
    shortUrlCache,
    `/api/shorturl/${code}`,
    (data: { originalUrl: string }) => data.originalUrl
  )

  // Display the original URL, stripped of protocol and truncated if too long
  const displayText = (() => {
    if (loading || !originalUrl) return shortHref
    const stripped = originalUrl.replace(/^https?:\/\//, '')
    return stripped.length > 40 ? stripped.slice(0, 37) + '…' : stripped
  })()

  return (
    <a
      href={shortHref}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      className={`${isDark ? 'text-yellow-400 hover:text-yellow-300' : 'text-amber-800 hover:text-amber-900'} hover:underline break-all`}
    >
      {displayText}
    </a>
  )
}

// Component to render short URL videos
const ShortUrlVideo: React.FC<{
  code: string
  onError: (url: string) => void
  videoErrors: Set<string>
}> = ({ code, onError, videoErrors }) => {
  const { url: originalUrl, loading } = useCachedFetch(
    code,
    shortUrlCache,
    `/api/shorturl/${code}`,
    (data: { originalUrl: string }) => data.originalUrl
  )

  if (loading) return <MediaSkeleton />
  if (!originalUrl || videoErrors.has(originalUrl)) return null

  return (
    <div className="my-2 max-w-full">
      <video
        src={originalUrl}
        controls
        className="max-w-full max-h-96 min-w-[100px] rounded-lg"
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
  const { isDark } = useTheme()
  const linkClass = isDark
    ? 'text-yellow-400 hover:text-yellow-300'
    : 'text-amber-800 hover:text-amber-900'
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

  const isVideoUrl = (url: string): boolean => {
    return /\.(?:mp4|webm|mov|avi|mkv|ogg|ogv)(?:\?|$)/i.test(url)
  }

  const isShortUrl = (url: string): boolean => {
    return SHORT_URL_REGEX.test(url)
  }

  // Check if short URL code has a video extension
  const isVideoShortUrl = (code: string): boolean => {
    return /\.(mp4|webm|mov|avi|mkv|ogg|ogv)$/i.test(code)
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
    // Regular expression that matches hashtags, cashtags, @mentions, AND short URLs
    // (so we can render short URLs as clickable links pointing to the original URL).
    // Short URLs: /s/code or https://host/s/code (with optional extension)
    // Hashtags/cashtags/mentions must contain at least one letter — pure-numeric
    // sequences like "$100" or "#5" should render as plain text.
    const specialRegex = /((?:https?:\/\/[^\s]+)?\/s\/[a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?|[@#$](?=[a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]*[a-zA-Z_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9])[a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+)/g

    const parts = text.split(specialRegex)

    return parts.map((part, index) => {
      // Check if this is a short URL
      const shortUrlMatch = part.match(/^((?:https?:\/\/[^\s\/]+)?\/s\/([a-zA-Z0-9]+(?:\.[a-zA-Z0-9]+)?))$/)
      if (shortUrlMatch) {
        const shortHref = shortUrlMatch[1]
        const code = shortUrlMatch[2]
        // Skip media short URLs — they're handled by parseContent as images/videos
        if (isMediaShortUrl(code) || isVideoShortUrl(code)) return part
        return (
          <ShortUrlLink key={`${keyPrefix}-${index}`} code={code} shortHref={shortHref} />
        )
      }

      // Check if this is an @mention
      if (part.startsWith('@')) {
        return (
          <Tooltip key={`${keyPrefix}-${index}`} text={`View ${part}'s profile`} className="inline">
            <button
              onClick={(e) => handleMentionClick(part, e)}
              className={`
                hover:underline cursor-pointer transition-colors duration-200
                bg-transparent border-none p-0 m-0 font-inherit
                ${linkClass}
              `}
            >
              {part}
            </button>
          </Tooltip>
        )
      }

      // Check if this is a hashtag or cashtag
      if (part.startsWith('#') || part.startsWith('$')) {
        return (
          <Tooltip key={`${keyPrefix}-${index}`} text={`View posts with ${part}`} className="inline">
            <button
              onClick={(e) => handleHashtagClick(part, e)}
              className={`
                hover:underline cursor-pointer transition-colors duration-200
                bg-transparent border-none p-0 m-0 font-inherit
                ${linkClass}
              `}
            >
              {part}
            </button>
          </Tooltip>
        )
      }

      // Regular text
      return part
    })
  }

  const parseContent = (text: string) => {
    // Extract all media in a single pass to preserve order
    // Each match includes its position so we can sort by original order
    const mediaMatches: { type: 'image' | 'shortImage' | 'shortVideo'; data: string; code?: string; position: number }[] = []

    // Pattern for short URLs with extensions (e.g., /s/abc123.png, /s/abc123.mov)
    const shortUrlWithExtPattern = /(?:https?:\/\/[^\s]+)?\/s\/([a-zA-Z0-9]+\.(gif|jpg|jpeg|png|webp|mp4|webm|mov))/g
    // Pattern for direct image URLs
    const imageUrlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/g

    // Find all matches with their positions
    let match: RegExpExecArray | null

    // Short URLs with media extensions (images and videos)
    while ((match = shortUrlWithExtPattern.exec(text)) !== null) {
      const code = match[1]
      const isVideo = /\.(mp4|webm|mov)$/i.test(code)
      mediaMatches.push({
        type: isVideo ? 'shortVideo' : 'shortImage',
        data: match[0],
        code: code,
        position: match.index
      })
    }

    // Direct image URLs (excluding short URLs)
    while ((match = imageUrlPattern.exec(text)) !== null) {
      // Skip if it's a short URL (already handled)
      if (match[0].includes('/s/')) continue
      mediaMatches.push({
        type: 'image',
        data: match[0],
        position: match.index
      })
    }

    // Sort by position to maintain original order
    mediaMatches.sort((a, b) => a.position - b.position)

    // Remove all media from text
    let processedText = text
      .replace(shortUrlWithExtPattern, '')
      .replace(imageUrlPattern, (match) => match.includes('/s/') ? match : '')

    // Clean up extra spaces left by removed refs (but preserve newlines!)
    processedText = processedText
      .replace(/[ \t]+/g, ' ')  // Collapse multiple spaces/tabs (not newlines)
      .replace(/^ +/gm, '')     // Remove leading spaces on each line
      .replace(/\n{3,}/g, '\n\n') // Collapse 3+ newlines to 2
      .trim()

    // Split by lines first to handle URLs on their own lines
    const lines = processedText.split('\n')
    const result: React.ReactNode[] = []

    lines.forEach((line, lineIndex) => {
      const trimmedLine = line.trim()

      // Skip empty lines (after media extraction)
      if (!trimmedLine) {
        // Add line break for empty lines between text
        if (lineIndex < lines.length - 1 && lineIndex > 0) {
          result.push(<br key={`br-${lineIndex}`} />)
        }
        return
      }

      // Check if this line is a short URL (without media extension - for link previews)
      if (isShortUrl(trimmedLine)) {
        const code = getShortUrlCode(trimmedLine)
        if (code && !isMediaShortUrl(code) && !isVideoShortUrl(code)) {
          // Render as link preview card (non-media short URLs)
          result.push(
            <LinkPreview
              key={`link-${lineIndex}`}
              code={code}
              className="my-2"
            />
          )
          return
        }
      }

      // Regular text line with hashtag parsing
      result.push(
        <span key={`text-${lineIndex}`}>
          {parseTextWithHashtags(line, `line-${lineIndex}`)}
        </span>
      )

      // Add line break between text lines
      if (lineIndex < lines.length - 1) {
        result.push(<br key={`br-${lineIndex}`} />)
      }
    })

    // Render all media in order (sorted by original position in text)
    mediaMatches.forEach((media, idx) => {
      if (media.type === 'shortImage' && media.code) {
        result.push(
          <ShortUrlImage
            key={`shortimg-${idx}`}
            code={media.code}
            onError={handleImageError}
            imageErrors={imageErrors}
          />
        )
      } else if (media.type === 'shortVideo' && media.code) {
        result.push(
          <ShortUrlVideo
            key={`shortvid-${idx}`}
            code={media.code}
            onError={handleImageError}
            videoErrors={imageErrors}
          />
        )
      } else if (media.type === 'image') {
        result.push(
          <div key={`img-${idx}`} className="my-2 max-w-full">
            <img
              src={media.data}
              alt="Embedded content"
              className="max-w-full max-h-96 rounded-lg object-contain"
              loading="lazy"
              onError={() => handleImageError(media.data)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
        )
      }
    })

    return result
  }

  return (
    <div className={`break-words ${className}`}>
      {parseContent(content)}
    </div>
  )
}

export default ContentWithHashtags