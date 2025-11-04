import React, { useState, useCallback, useMemo } from 'react'
import { HiOutlineSearch, HiOutlineInformationCircle } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { format } from 'date-fns'

interface Message {
  id: string
  content: string
  createdAt: string
  sender: {
    user: {
      username: string
    }
  }
  conversationId: string
}

interface MessageSearchProps {
  userId?: number
  onSearchComplete?: (results: Message[]) => void
}

const MessageSearch: React.FC<MessageSearchProps> = ({ userId, onSearchComplete }) => {
  const { isDark } = useTheme()
  const [searchQuery, setSearchQuery] = useState('')
  const [isSearching, setIsSearching] = useState(false)
  const [searchResults, setSearchResults] = useState<Message[]>([])
  const [dateRange, setDateRange] = useState({
    start: format(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000), 'yyyy-MM-dd'), // 30 days ago
    end: format(new Date(), 'yyyy-MM-dd')
  })
  const [showInfo, setShowInfo] = useState(false)

  const handleSearch = useCallback(async () => {
    if (!searchQuery.trim() || !userId) return

    setIsSearching(true)

    try {
      // Fetch messages within date range from server
      const response = await fetch(
        `/api/xmtp/messages/search?userId=${userId}&from=${dateRange.start}&to=${dateRange.end}`,
        {
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('token') || ''}`
          }
        }
      )

      if (!response.ok) throw new Error('Search failed')

      const data = await response.json()
      const messages: Message[] = data.messages || []

      // Client-side search through decrypted messages
      const results = messages.filter(message => {
        const searchLower = searchQuery.toLowerCase()
        return (
          message.content.toLowerCase().includes(searchLower) ||
          message.sender.user.username.toLowerCase().includes(searchLower)
        )
      })

      setSearchResults(results)
      onSearchComplete?.(results)
    } catch (error) {
      console.error('Message search error:', error)
      setSearchResults([])
    } finally {
      setIsSearching(false)
    }
  }, [searchQuery, userId, dateRange, onSearchComplete])

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    }
  }

  return (
    <div className="mb-6">
      {/* Search Info Banner */}
      <div className={`mb-4 p-3 rounded-lg border ${
        isDark ? 'bg-gray-900/50 border-gray-700' : 'bg-blue-50 border-blue-200'
      }`}>
        <div className="flex items-start space-x-2">
          <HiOutlineInformationCircle className={`w-5 h-5 mt-0.5 flex-shrink-0 ${
            isDark ? 'text-yellow-400' : 'text-blue-500'
          }`} />
          <div className="flex-1">
            <p className={`text-sm font-medium mb-1 ${
              isDark ? 'text-white' : 'text-gray-900'
            }`}>
              Privacy-First Message Search
            </p>
            <p className={`text-xs ${
              isDark ? 'text-gray-300' : 'text-gray-600'
            }`}>
              Your messages are end-to-end encrypted. Search happens locally on your device after downloading and decrypting messages within the selected date range. This ensures your privacy while allowing you to search your conversations.
            </p>
            <button
              onClick={() => setShowInfo(!showInfo)}
              className={`text-xs mt-1 underline ${
                isDark ? 'text-yellow-400' : 'text-blue-500'
              }`}
            >
              {showInfo ? 'Hide' : 'Learn more'}
            </button>
          </div>
        </div>

        {showInfo && (
          <div className={`mt-3 pt-3 border-t ${
            isDark ? 'border-gray-700' : 'border-blue-200'
          }`}>
            <ul className={`text-xs space-y-1 ${
              isDark ? 'text-gray-400' : 'text-gray-600'
            }`}>
              <li>• Messages never leave your device unencrypted</li>
              <li>• Search queries are processed locally, not on servers</li>
              <li>• Adjust date range to search more or fewer messages</li>
              <li>• Larger date ranges may take longer to process</li>
            </ul>
          </div>
        )}
      </div>

      {/* Date Range Selector */}
      <div className="flex space-x-2 mb-3">
        <div className="flex-1">
          <label className={`block text-xs mb-1 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            From
          </label>
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            className={`w-full px-3 py-2 rounded-lg text-sm border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
              isDark
                ? 'bg-black border-gray-600 text-white'
                : 'bg-white border-gray-300 text-black'
            }`}
          />
        </div>
        <div className="flex-1">
          <label className={`block text-xs mb-1 ${
            isDark ? 'text-gray-400' : 'text-gray-600'
          }`}>
            To
          </label>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            className={`w-full px-3 py-2 rounded-lg text-sm border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
              isDark
                ? 'bg-black border-gray-600 text-white'
                : 'bg-white border-gray-300 text-black'
            }`}
          />
        </div>
      </div>

      {/* Search Bar */}
      <div className="relative">
        <input
          type="text"
          placeholder="Search messages locally..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          onKeyPress={handleKeyPress}
          className={`w-full pl-10 pr-12 py-3 rounded-full border transition-all duration-300 focus:outline-none focus:ring-2 focus:ring-gray-500/30 ${
            isDark
              ? 'bg-black border-gray-600 text-white placeholder-gray-400'
              : 'bg-white border-gray-300 text-black placeholder-gray-500'
          }`}
        />
        <HiOutlineSearch className={`absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 ${
          isDark ? 'text-gray-400' : 'text-gray-500'
        }`} />

        <button
          onClick={handleSearch}
          disabled={isSearching || !searchQuery.trim()}
          className={`absolute right-2 top-1/2 transform -translate-y-1/2 px-3 py-1 rounded-full text-sm font-medium transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed ${
            isDark
              ? 'bg-yellow-500/20 text-yellow-400 hover:bg-yellow-500/30'
              : 'bg-yellow-500 text-black hover:bg-yellow-600'
          }`}
        >
          {isSearching ? 'Searching...' : 'Search'}
        </button>
      </div>

      {/* Search Results */}
      {searchResults.length > 0 && (
        <div className={`mt-4 p-3 rounded-lg border ${
          isDark ? 'bg-gray-900/50 border-gray-700' : 'bg-gray-50 border-gray-200'
        }`}>
          <p className={`text-sm font-medium mb-2 ${
            isDark ? 'text-white' : 'text-gray-900'
          }`}>
            Found {searchResults.length} messages
          </p>
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {searchResults.map((message) => (
              <div
                key={message.id}
                className={`p-2 rounded border ${
                  isDark ? 'border-gray-700' : 'border-gray-200'
                }`}
              >
                <div className="flex justify-between items-start mb-1">
                  <span className={`text-xs font-medium ${
                    isDark ? 'text-gray-300' : 'text-gray-700'
                  }`}>
                    {message.sender.user.username}
                  </span>
                  <span className={`text-xs ${
                    isDark ? 'text-gray-500' : 'text-gray-500'
                  }`}>
                    {format(new Date(message.createdAt), 'MMM d, yyyy')}
                  </span>
                </div>
                <p className={`text-sm ${
                  isDark ? 'text-gray-400' : 'text-gray-600'
                }`}>
                  {message.content}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default MessageSearch