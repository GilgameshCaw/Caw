// src/components/ContentWithHashtags.tsx
import React from 'react'
import { useNavigate } from 'react-router-dom'

interface Props {
  content: string
  className?: string
}

/**
 * Component that renders text content with clickable hashtags
 */
const ContentWithHashtags: React.FC<Props> = ({ content, className = '' }) => {
  const navigate = useNavigate()

  const handleHashtagClick = (hashtag: string, event: React.MouseEvent) => {
    event.preventDefault()
    event.stopPropagation()
    // Remove # or $ symbol if present and navigate
    const cleanHashtag = hashtag.replace(/^[#$]/, '')
    navigate(`/hashtags/${cleanHashtag}`)
  }

  const parseContent = (text: string) => {
    // Regular expression to match hashtags and cashtags
    // Supports international characters and numbers
    const hashtagRegex = /([#$][a-zA-Z0-9_\u00C0-\u017F\u1E00-\u1EFF\u0100-\u024F\u1EA0-\u1EF9]+)/g

    const parts = text.split(hashtagRegex)

    return parts.map((part, index) => {
      if (hashtagRegex.test(part)) {
        // This is a hashtag or cashtag
        const isHashtag = part.startsWith('#')
        const isCashtag = part.startsWith('$')

        return (
          <button
            key={index}
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

  return (
    <div className={className}>
      {parseContent(content)}
    </div>
  )
}

export default ContentWithHashtags