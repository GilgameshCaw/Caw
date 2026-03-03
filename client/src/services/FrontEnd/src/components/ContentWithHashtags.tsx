// src/components/ContentWithHashtags.tsx
import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import LinkPreview from './LinkPreview'
import { apiFetch } from '~/api/client'

// Cache for short URL original URLs
const shortUrlCache = new Map<string, string | null>()

// Cache for on-chain image data
const onChainImageCache = new Map<string, string | null>()

// Component to render on-chain images (fetches base64 data from API)
const OnChainImage: React.FC<{
  imageRef: string
  onError: (ref: string) => void
  imageErrors: Set<string>
}> = ({ imageRef, onError, imageErrors }) => {
  const [imageData, setImageData] = useState<string | null>(onChainImageCache.get(imageRef) || null)
  const [loading, setLoading] = useState(!onChainImageCache.has(imageRef))

  useEffect(() => {
    if (onChainImageCache.has(imageRef)) {
      setImageData(onChainImageCache.get(imageRef) || null)
      setLoading(false)
      return
    }

    const fetchImage = async () => {
      try {
        const data = await apiFetch(`/api/on-chain-images/ref/${imageRef}`) as { base64Data: string }
        const base64Url = data.base64Data.startsWith('data:')
          ? data.base64Data
          : `data:image/jpeg;base64,${data.base64Data}`
        onChainImageCache.set(imageRef, base64Url)
        setImageData(base64Url)
      } catch (err) {
        console.error('Failed to fetch on-chain image:', err)
        onChainImageCache.set(imageRef, null)
      } finally {
        setLoading(false)
      }
    }

    fetchImage()
  }, [imageRef])

  if (loading) {
    return (
      <div className="my-2 max-w-full h-48 bg-gray-200 dark:bg-gray-700 rounded-lg animate-pulse" />
    )
  }

  if (!imageData || imageErrors.has(imageRef)) {
    return null
  }

  return (
    <div className="my-2 max-w-full">
      <img
        src={imageData}
        alt="On-chain image"
        className="max-w-full max-h-96 rounded-lg object-contain"
        loading="lazy"
        onError={() => onError(imageRef)}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  )
}

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

// Component to render short URL videos (fetches original URL)
const ShortUrlVideo: React.FC<{
  code: string
  onError: (url: string) => void
  videoErrors: Set<string>
}> = ({ code, onError, videoErrors }) => {
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

  if (!originalUrl || videoErrors.has(originalUrl)) {
    return null
  }

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

// Regex to match on-chain image references [img:userId:cawonce]
const ON_CHAIN_IMAGE_REGEX = /\[img:(\d+):(\d+)\]/g

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
    // Extract all media in a single pass to preserve order
    // Each match includes its position so we can sort by original order
    const mediaMatches: { type: 'onchain' | 'image' | 'shortImage' | 'shortVideo'; data: string; code?: string; position: number }[] = []

    // Pattern for on-chain images [img:userId:cawonce]
    const onChainPattern = /\[img:(\d+):(\d+)\]/g
    // Pattern for short URLs with extensions (e.g., /s/abc123.png, /s/abc123.mov)
    const shortUrlWithExtPattern = /(?:https?:\/\/[^\s]+)?\/s\/([a-zA-Z0-9]+\.(gif|jpg|jpeg|png|webp|mp4|webm|mov))/g
    // Pattern for direct image URLs
    const imageUrlPattern = /https?:\/\/[^\s<>"{}|\\^`[\]]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/g

    // Find all matches with their positions
    let match: RegExpExecArray | null

    // On-chain images
    while ((match = onChainPattern.exec(text)) !== null) {
      mediaMatches.push({
        type: 'onchain',
        data: `img:${match[1]}:${match[2]}`,
        position: match.index
      })
    }

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
      .replace(onChainPattern, '')
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
      if (media.type === 'onchain') {
        result.push(
          <OnChainImage
            key={`onchain-${idx}-${media.data}`}
            imageRef={media.data}
            onError={handleImageError}
            imageErrors={imageErrors}
          />
        )
      } else if (media.type === 'shortImage' && media.code) {
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
    <div className={className}>
      {parseContent(content)}
    </div>
  )
}

export default ContentWithHashtags