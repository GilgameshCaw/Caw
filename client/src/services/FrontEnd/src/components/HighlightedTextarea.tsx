import React, { useRef, useEffect, useState } from 'react'
import { useTheme } from '~/hooks/useTheme'

interface HighlightedTextareaProps {
  value: string
  onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
  onClick?: (e: React.MouseEvent<HTMLTextAreaElement>) => void
  onKeyUp?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onDragOver?: (e: React.DragEvent) => void
  onDragLeave?: (e: React.DragEvent) => void
  onDrop?: (e: React.DragEvent) => void
  placeholder?: string
  rows?: number
  className?: string
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>
  fontSize?: 'base' | 'xl'
}

/**
 * Textarea with syntax highlighting for @mentions and #hashtags
 * Uses a mirror div technique: styled div behind transparent textarea
 */
const HighlightedTextarea: React.FC<HighlightedTextareaProps> = ({
  value,
  onChange,
  onClick,
  onKeyUp,
  onDragOver,
  onDragLeave,
  onDrop,
  placeholder,
  rows = 3,
  className = '',
  textareaRef: externalRef,
  fontSize = 'xl'
}) => {
  const { isDark } = useTheme()
  const internalRef = useRef<HTMLTextAreaElement>(null)
  const textareaRef = externalRef || internalRef
  const highlightRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)

  // Sync scroll between textarea and highlight div
  const handleScroll = (e: React.UIEvent<HTMLTextAreaElement>) => {
    setScrollTop(e.currentTarget.scrollTop)
  }

  useEffect(() => {
    if (highlightRef.current) {
      highlightRef.current.scrollTop = scrollTop
    }
  }, [scrollTop])

  // Parse text and apply highlighting
  const getHighlightedText = (text: string) => {
    if (!text) return null

    // Regex for @mentions and #hashtags
    // @mentions: @ followed by alphanumeric/underscore characters
    // #hashtags: # followed by alphanumeric/underscore characters
    const regex = /([@#][a-zA-Z0-9_]+)/g
    const parts = text.split(regex)

    return parts.map((part, index) => {
      if (part.startsWith('@') || part.startsWith('#')) {
        return (
          <span key={index} className="text-yellow-500">
            {part}
          </span>
        )
      }
      return part
    })
  }

  const textSizeClass = fontSize === 'xl' ? 'text-xl' : 'text-base'
  const lineHeight = fontSize === 'xl' ? '1.75rem' : '1.5rem'

  return (
    <div className="relative w-full">
      {/* Highlight layer - renders behind textarea */}
      <div
        ref={highlightRef}
        className={`absolute inset-0 pointer-events-none overflow-hidden whitespace-pre-wrap break-words ${textSizeClass} ${
          isDark ? 'text-white' : 'text-black'
        }`}
        style={{
          padding: '2px 8px 26px 8px',
          lineHeight,
          wordBreak: 'break-word',
          overflowWrap: 'break-word',
        }}
        aria-hidden="true"
      >
        {getHighlightedText(value)}
        {/* Add invisible character to maintain height when empty */}
        {!value && <span className="invisible">.</span>}
      </div>

      {/* Actual textarea - transparent text, handles input */}
      <textarea
        ref={textareaRef as React.RefObject<HTMLTextAreaElement>}
        className={`w-full resize-none border-none outline-none bg-transparent ${textSizeClass} ${className}`}
        style={{
          boxShadow: 'none',
          padding: '2px 8px 26px 8px',
          lineHeight,
          color: 'transparent',
          caretColor: isDark ? 'white' : 'black',
          WebkitTextFillColor: 'transparent',
        }}
        rows={rows}
        placeholder={placeholder}
        value={value}
        onChange={onChange}
        onClick={onClick}
        onKeyUp={onKeyUp}
        onScroll={handleScroll}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      />

      {/* Placeholder overlay when empty */}
      {!value && placeholder && (
        <div
          className={`absolute pointer-events-none ${textSizeClass} ${
            isDark ? 'text-gray-500' : 'text-gray-600'
          }`}
          style={{
            top: '2px',
            left: '8px',
            lineHeight,
          }}
        >
          {placeholder}
        </div>
      )}
    </div>
  )
}

export default HighlightedTextarea
