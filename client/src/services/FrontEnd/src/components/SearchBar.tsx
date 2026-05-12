import React, { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from '~/utils/localizedRouter'
import { HiSearch, HiX } from 'react-icons/hi'
import { HiTrendingUp, HiHashtag, HiUser } from 'react-icons/hi'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import { useT } from '~/i18n/I18nProvider'

interface SearchSuggestion {
  type: 'user' | 'hashtag' | 'trending'
  value: string
  display: string
  avatar?: string
  verified?: boolean
  count?: number
}

// Simple debounce function
function debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
  let timeout: NodeJS.Timeout
  return ((...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }) as T
}

const SearchBar: React.FC = () => {
  const t = useT()
  const navigate = useNavigate()
  const { isDark } = useTheme()
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [selectedIndex, setSelectedIndex] = useState(-1)
  const [isLoading, setIsLoading] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const suggestionsRef = useRef<HTMLDivElement>(null)

  // Debounced search for suggestions
  const fetchSuggestions = useCallback(
    debounce(async (searchQuery: string) => {
      if (searchQuery.length < 1) {
        setSuggestions([])
        return
      }

      setIsLoading(true)
      try {
        const { suggestions } = await apiFetch<{ suggestions: SearchSuggestion[] }>(
          `/api/search/suggestions?q=${encodeURIComponent(searchQuery)}`
        )
        setSuggestions(suggestions)
      } catch (error) {
        console.error('Failed to fetch suggestions:', error)
        setSuggestions([])
      } finally {
        setIsLoading(false)
      }
    }, 300),
    []
  )

  useEffect(() => {
    fetchSuggestions(query)
  }, [query, fetchSuggestions])

  // Close suggestions when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        suggestionsRef.current &&
        !suggestionsRef.current.contains(event.target as Node) &&
        !inputRef.current?.contains(event.target as Node)
      ) {
        setShowSuggestions(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSearch = (searchQuery?: string) => {
    const finalQuery = searchQuery || query
    if (!finalQuery.trim()) return

    setShowSuggestions(false)

    // Navigate to search results page
    if (finalQuery.startsWith('#')) {
      navigate(`/hashtags/${finalQuery.substring(1)}`)
    } else if (finalQuery.startsWith('@')) {
      navigate(`/profile/${finalQuery.substring(1)}`)
    } else {
      navigate(`/search?q=${encodeURIComponent(finalQuery)}`)
    }

    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!showSuggestions || suggestions.length === 0) {
      if (e.key === 'Enter') {
        handleSearch()
      }
      return
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        setSelectedIndex(prev =>
          prev < suggestions.length - 1 ? prev + 1 : prev
        )
        break
      case 'ArrowUp':
        e.preventDefault()
        setSelectedIndex(prev => prev > 0 ? prev - 1 : -1)
        break
      case 'Enter':
        e.preventDefault()
        if (selectedIndex >= 0 && selectedIndex < suggestions.length) {
          handleSearch(suggestions[selectedIndex].value)
        } else {
          handleSearch()
        }
        break
      case 'Escape':
        setShowSuggestions(false)
        setSelectedIndex(-1)
        break
    }
  }

  const getSuggestionIcon = (type: string) => {
    switch (type) {
      case 'user':
        return <HiUser className="w-4 h-4" />
      case 'hashtag':
        return <HiHashtag className="w-4 h-4" />
      default:
        return <HiTrendingUp className="w-4 h-4" />
    }
  }

  return (
    <div className="relative mt-0">
      <div className="relative">
        <HiSearch className={`absolute left-4 top-1/2 transform -translate-y-1/2 w-5 h-5 transition-all duration-300 ${
          isDark ? 'text-white/70' : 'text-gray-600'
        }`} />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setShowSuggestions(true)}
          onKeyDown={handleKeyDown}
          placeholder={t('search.placeholder')}
          className={`w-full rounded-full py-3 pl-12 pr-10 transition-all duration-300 focus:outline-none ${
            isDark
              ? 'bg-black border-yellow-500/30 text-white placeholder-white/50 focus:border-yellow-500/50 focus:bg-black'
              : 'bg-white border-gray-200 text-black placeholder-gray-500 focus:border-gray-300 focus:bg-white'
          } border`}
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-3 top-1/2 transform -translate-y-1/2"
          >
            <HiX className={`w-4 h-4 ${isDark ? 'text-white/70 hover:text-white' : 'text-gray-600 hover:text-gray-800'}`} />
          </button>
        )}
      </div>

      {showSuggestions && (suggestions.length > 0 || isLoading) && (
        <div
          ref={suggestionsRef}
          className={`absolute top-full mt-2 w-full rounded-2xl shadow-lg ${
            isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
          } border overflow-hidden z-50`}
        >
          {isLoading ? (
            <div className={`px-4 py-3 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>{t('search.searching')}</div>
          ) : (
            suggestions.map((suggestion, index) => (
              <button
                key={`${suggestion.type}-${suggestion.value}`}
                onClick={() => handleSearch(suggestion.value)}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`w-full px-4 py-3 flex items-center space-x-3 transition ${
                  selectedIndex === index
                    ? isDark ? 'bg-white/10' : 'bg-gray-100'
                    : ''
                } ${isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'}`}
              >
                <div className={isDark ? 'text-white/50' : 'text-gray-500'}>
                  {getSuggestionIcon(suggestion.type)}
                </div>
                <div className="flex-1 text-left">
                  <div className="flex items-center space-x-2">
                    <span className={isDark ? 'text-white' : 'text-gray-900'}>
                      {suggestion.display}
                    </span>
                    {suggestion.verified && (
                      <span className="text-blue-500 text-xs">✓</span>
                    )}
                  </div>
                  {suggestion.count && (
                    <div className={`text-xs ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                      {t('search.caws_count', { count: suggestion.count })}
                    </div>
                  )}
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}

export default SearchBar
