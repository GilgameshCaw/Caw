import React, { useState, useEffect, useRef } from 'react'
import { useTheme } from '~/hooks/useTheme'

interface User {
  tokenId: number
  username: string
  displayName?: string
  avatarUrl?: string
  image?: string
}

interface MentionAutocompleteProps {
  text: string
  cursorPosition: number
  onSelect: (username: string, startPos: number, endPos: number) => void
  textareaRef: React.RefObject<HTMLTextAreaElement>
}

const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({
  text,
  cursorPosition,
  onSelect,
  textareaRef
}) => {
  const { isDark } = useTheme()
  const [users, setUsers] = useState<User[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)

  // Detect @ mentions and search for users
  useEffect(() => {
    // Find the @ symbol before cursor
    const textBeforeCursor = text.substring(0, cursorPosition)
    const lastAtIndex = textBeforeCursor.lastIndexOf('@')

    // Check if we're in a mention context
    if (lastAtIndex === -1 || lastAtIndex < textBeforeCursor.length - 20) {
      setUsers([])
      setMentionStart(null)
      return
    }

    // Extract the query after @ (only alphanumeric and underscore)
    const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1)
    const spaceIndex = textAfterAt.indexOf(' ')
    const query = spaceIndex === -1 ? textAfterAt : textAfterAt.substring(0, spaceIndex)

    // Only show suggestions if @ is followed by valid username characters
    if (!/^[a-z0-9_]*$/i.test(query)) {
      setUsers([])
      setMentionStart(null)
      return
    }

    setSearchQuery(query)
    setMentionStart(lastAtIndex)

    // Search for users if query has at least 1 character
    if (query.length >= 1) {
      fetch(`/api/users/search/${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
          setUsers(data.users || [])
          setSelectedIndex(0)
        })
        .catch(err => {
          console.error('Failed to search users:', err)
          setUsers([])
        })
    } else {
      setUsers([])
    }
  }, [text, cursorPosition])

  // Calculate dropdown position based on cursor
  useEffect(() => {
    if (users.length === 0 || !textareaRef.current || mentionStart === null) {
      setPosition(null)
      return
    }

    const textarea = textareaRef.current
    const { offsetTop, offsetLeft, scrollTop, scrollLeft } = textarea

    // Create a temporary div to measure text position
    const div = document.createElement('div')
    const style = window.getComputedStyle(textarea)

    // Copy relevant styles
    ;['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'padding', 'border', 'whiteSpace', 'wordWrap'].forEach(prop => {
      div.style[prop as any] = style[prop as any]
    })

    div.style.position = 'absolute'
    div.style.visibility = 'hidden'
    div.style.width = `${textarea.clientWidth}px`
    div.textContent = text.substring(0, mentionStart + 1)

    document.body.appendChild(div)

    const span = document.createElement('span')
    span.textContent = '@'
    div.appendChild(span)

    const rect = span.getBoundingClientRect()
    const textareaRect = textarea.getBoundingClientRect()

    document.body.removeChild(div)

    // Position dropdown below the @ symbol
    setPosition({
      top: rect.bottom - textareaRect.top + 5,
      left: rect.left - textareaRect.left
    })
  }, [users, text, mentionStart, textareaRef])

  // Handle keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (users.length === 0) return

      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => (prev + 1) % users.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => (prev - 1 + users.length) % users.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (users[selectedIndex]) {
          e.preventDefault()
          handleSelect(users[selectedIndex])
        }
      } else if (e.key === 'Escape') {
        setUsers([])
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [users, selectedIndex])

  const handleSelect = (user: User) => {
    if (mentionStart === null) return

    // Replace @query with @username
    onSelect(user.username, mentionStart, mentionStart + searchQuery.length + 1)
    setUsers([])
    setMentionStart(null)
  }

  if (users.length === 0 || !position) return null

  return (
    <div
      ref={dropdownRef}
      className={`absolute z-50 min-w-[200px] max-w-[300px] rounded-lg border shadow-lg ${
        isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
      }`}
      style={{
        top: `${position.top}px`,
        left: `${position.left}px`,
      }}
    >
      <div className="max-h-[200px] overflow-y-auto">
        {users.map((user, index) => (
          <button
            key={user.tokenId}
            onClick={() => handleSelect(user)}
            className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
              index === selectedIndex
                ? isDark
                  ? 'bg-white/10'
                  : 'bg-gray-100'
                : isDark
                ? 'hover:bg-white/5'
                : 'hover:bg-gray-50'
            }`}
          >
            <img
              src={user.avatarUrl || user.image || '/images/logo.jpeg'}
              alt={user.username}
              className="w-8 h-8 rounded-full object-cover"
            />
            <div className="flex-1 min-w-0">
              <div className={`font-semibold text-sm truncate ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {user.displayName || user.username}
              </div>
              <div className={`text-xs truncate ${isDark ? 'text-gray-400' : 'text-gray-500'}`}>
                @{user.username}
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

export default MentionAutocomplete
