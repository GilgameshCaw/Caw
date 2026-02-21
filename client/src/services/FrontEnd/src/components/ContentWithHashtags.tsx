// src/components/ContentWithHashtags.tsx
import React, { useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface Props {
  content: string
  className?: string
}

// Regex to match Giphy URLs
const GIPHY_URL_REGEX = /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\/[^\s]+\.gif/gi

// Regex to match general image URLs (common formats)
const IMAGE_URL_REGEX = /https?:\/\/[^\s]+\.(?:gif|jpg|jpeg|png|webp)(?:\?[^\s]*)?/gi

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

  const handleImageError = (url: string) => {
    setImageErrors(prev => new Set(prev).add(url))
  }

  const isGiphyUrl = (url: string): boolean => {
    return /https?:\/\/(?:media\d?\.giphy\.com|i\.giphy\.com)\/media\//i.test(url)
  }

  const isImageUrl = (url: string): boolean => {
    return /\.(?:gif|jpg|jpeg|png|webp)(?:\?|$)/i.test(url)
  }

  const parseTextWithHashtags = (text: string, keyPrefix: string) => {
    // Regular expression to match hashtags and cashtags
    // Supports international characters and numbers
    const hashtagRegex = /([#$][a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+)/g

    const parts = text.split(hashtagRegex)

    return parts.map((part, index) => {
      if (hashtagRegex.test(part)) {
        // This is a hashtag or cashtag
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

      // Check if this line is a Giphy URL or image URL
      if (isGiphyUrl(trimmedLine) || (isImageUrl(trimmedLine) && trimmedLine.startsWith('http'))) {
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

      // Add line break between lines (but not after images or at the end)
      if (lineIndex < lines.length - 1 && !isGiphyUrl(trimmedLine) && !isImageUrl(trimmedLine)) {
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