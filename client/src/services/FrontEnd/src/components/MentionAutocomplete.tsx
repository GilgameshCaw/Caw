import React, { useState, useEffect, useRef } from 'react'
import { useTheme } from '~/hooks/useTheme'
import { UserAvatar } from '~/components/Avatar'

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
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  /**
   * Optional list of users to surface first (e.g. participants of the
   * current DM / group chat). Matched locally against `username` and
   * `displayName` so the people most likely being addressed pop up
   * instantly without a server roundtrip. Remote /api/users/search
   * results are appended below, deduped against this list.
   */
  priorityUsers?: User[]
}

const MentionAutocomplete: React.FC<MentionAutocompleteProps> = ({
  text,
  cursorPosition,
  onSelect,
  textareaRef,
  priorityUsers,
}) => {
  const { isDark } = useTheme()
  const [users, setUsers] = useState<User[]>([])
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [isVisible, setIsVisible] = useState(false)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [dropdownPosition, setDropdownPosition] = useState<{ top: number; left: number } | null>(null)
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
      setIsVisible(false)
      return
    }

    // Extract the query after @ (only alphanumeric and underscore)
    const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1)

    // Hide if there's a space after the @ query (user finished typing the mention)
    if (textAfterAt.includes(' ')) {
      setUsers([])
      setMentionStart(null)
      setIsVisible(false)
      return
    }

    const query = textAfterAt

    // Only show suggestions if @ is followed by valid username characters
    if (!/^[a-z0-9_]*$/i.test(query)) {
      setUsers([])
      setMentionStart(null)
      setIsVisible(false)
      return
    }

    setSearchQuery(query)
    setMentionStart(lastAtIndex)

    // Filter the priority list (e.g. DM/group participants) locally so
    // the people most likely being addressed surface instantly. Empty
    // query → show full priority list so "@" alone in a DM opens a
    // picker of the chat's members.
    const q = query.toLowerCase()
    const priorityMatches = (priorityUsers || []).filter(u => {
      if (!q) return true
      return (
        u.username.toLowerCase().includes(q) ||
        (u.displayName || '').toLowerCase().includes(q)
      )
    })

    if (query.length >= 1) {
      fetch(`/api/users/search/${encodeURIComponent(query)}`)
        .then(res => res.json())
        .then(data => {
          const remote: User[] = data.users || []
          // Dedupe: priority entries win over remote ones (same tokenId).
          const seen = new Set(priorityMatches.map(u => u.tokenId))
          const merged = [...priorityMatches, ...remote.filter(u => !seen.has(u.tokenId))]
          setUsers(merged)
          setSelectedIndex(0)
          setIsVisible(merged.length > 0)
        })
        .catch(err => {
          console.error('Failed to search users:', err)
          // Even if the remote search fails, show the priority matches.
          setUsers(priorityMatches)
          setSelectedIndex(0)
          setIsVisible(priorityMatches.length > 0)
        })
    } else if (priorityMatches.length > 0) {
      // Bare "@" with a populated priority list — show participants.
      setUsers(priorityMatches)
      setSelectedIndex(0)
      setIsVisible(true)
    } else {
      setUsers([])
      setIsVisible(false)
    }
  }, [text, cursorPosition, priorityUsers])

  // Calculate dropdown position based on cursor position in textarea
  useEffect(() => {
    if (!isVisible || !textareaRef.current || mentionStart === null) {
      setDropdownPosition(null)
      return
    }

    const textarea = textareaRef.current
    const textareaRect = textarea.getBoundingClientRect()

    // Create a mirror div to measure text position
    const mirror = document.createElement('div')
    const style = window.getComputedStyle(textarea)

    // Copy textarea styles to mirror
    const stylesToCopy = [
      'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
      'letterSpacing', 'lineHeight', 'textTransform',
      'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
      'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
      'boxSizing', 'wordWrap', 'whiteSpace', 'wordBreak'
    ]

    stylesToCopy.forEach(prop => {
      mirror.style[prop as any] = style.getPropertyValue(prop.replace(/([A-Z])/g, '-$1').toLowerCase())
    })

    mirror.style.position = 'absolute'
    mirror.style.top = '-9999px'
    mirror.style.left = '-9999px'
    mirror.style.visibility = 'hidden'
    mirror.style.width = `${textarea.clientWidth}px`
    mirror.style.height = 'auto'
    mirror.style.overflow = 'hidden'

    // Add text up to the @ symbol
    const textUpToMention = text.substring(0, mentionStart)
    mirror.textContent = textUpToMention

    // Add a span for the @ to get its position
    const marker = document.createElement('span')
    marker.textContent = '@'
    mirror.appendChild(marker)

    document.body.appendChild(mirror)

    const markerRect = marker.getBoundingClientRect()
    const mirrorRect = mirror.getBoundingClientRect()

    // Calculate position relative to textarea
    const relativeTop = markerRect.top - mirrorRect.top
    const relativeLeft = markerRect.left - mirrorRect.left

    document.body.removeChild(mirror)

    // Position dropdown below the @ symbol
    const top = textareaRect.top + relativeTop + parseInt(style.paddingTop) + 20 // 20px below the line
    const left = Math.max(textareaRect.left + relativeLeft, textareaRect.left) // Don't go past textarea left edge

    // Make sure dropdown doesn't go off-screen to the right
    const maxLeft = window.innerWidth - 290 // 280px width + 10px margin

    setDropdownPosition({
      top: Math.min(top, window.innerHeight - 220), // Don't go past bottom
      left: Math.min(left, maxLeft)
    })
  }, [isVisible, textareaRef, mentionStart, text])

  // Handle keyboard navigation
  useEffect(() => {
    if (!isVisible || users.length === 0) return

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex(prev => (prev + 1) % users.length)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex(prev => (prev - 1 + users.length) % users.length)
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        if (users[selectedIndex] && mentionStart !== null) {
          e.preventDefault()
          onSelect(users[selectedIndex].username, mentionStart, mentionStart + searchQuery.length + 1)
          setUsers([])
          setMentionStart(null)
          setIsVisible(false)
        }
      } else if (e.key === 'Escape') {
        setIsVisible(false)
        setUsers([])
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isVisible, users, selectedIndex, mentionStart, searchQuery, onSelect])

  const handleSelect = (user: User) => {
    if (mentionStart === null) return

    // Replace @query with @username
    onSelect(user.username, mentionStart, mentionStart + searchQuery.length + 1)
    setUsers([])
    setMentionStart(null)
    setIsVisible(false)
  }

  if (!isVisible || users.length === 0 || !dropdownPosition) return null

  return (
    <div
      ref={dropdownRef}
      className={`fixed z-[9999] w-[280px] rounded-lg border shadow-lg ${
        isDark ? 'bg-gray-900 border-white/20' : 'bg-white border-gray-200'
      }`}
      style={{
        top: `${dropdownPosition.top}px`,
        left: `${dropdownPosition.left}px`,
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
            <UserAvatar
              user={user}
              alt={user.username}
              className="w-8 h-8 rounded-full"
              size="small"
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
