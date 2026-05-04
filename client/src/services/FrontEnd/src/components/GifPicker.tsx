import React, { useState, useEffect, useCallback, useRef } from 'react'
import { HiSearch, HiX } from 'react-icons/hi'
import { useTheme } from '~/hooks/useTheme'
import { apiFetch } from '~/api/client'
import { useT } from '~/i18n/I18nProvider'

interface Gif {
  id: string
  title: string
  url: string
  preview: string
  width: number
  height: number
  previewWidth: number
  previewHeight: number
}

interface GifPickerProps {
  initialQuery?: string
  onSelect: (gif: Gif) => void
  onClose: () => void
}

// Simple debounce function
function debounce<T extends (...args: any[]) => any>(func: T, wait: number): T {
  let timeout: NodeJS.Timeout
  return ((...args: Parameters<T>) => {
    clearTimeout(timeout)
    timeout = setTimeout(() => func(...args), wait)
  }) as T
}

const GifPicker: React.FC<GifPickerProps> = ({ initialQuery = '', onSelect, onClose }) => {
  const t = useT()
  const { isDark } = useTheme()
  const [query, setQuery] = useState(initialQuery)
  const [gifs, setGifs] = useState<Gif[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Focus input on mount
  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus()
    }
  }, [])

  // Fetch GIFs based on query
  const fetchGifs = useCallback(async (searchQuery: string) => {
    setLoading(true)
    setError(null)

    try {
      const endpoint = searchQuery.trim()
        ? `/api/giphy/search?q=${encodeURIComponent(searchQuery.trim())}&limit=24`
        : '/api/giphy/trending?limit=24'

      const data = await apiFetch<{ gifs: Gif[] }>(endpoint)
      setGifs(data.gifs)
    } catch (err) {
      console.error('Failed to fetch GIFs:', err)
      setError(t('gif.error.load_failed'))
      setGifs([])
    } finally {
      setLoading(false)
    }
  }, [])

  // Debounced search
  const debouncedFetch = useCallback(
    debounce((q: string) => fetchGifs(q), 400),
    [fetchGifs]
  )

  // Initial fetch and query changes
  useEffect(() => {
    if (initialQuery) {
      fetchGifs(initialQuery)
    } else {
      fetchGifs('')
    }
  }, []) // Only run on mount

  // Handle query changes
  useEffect(() => {
    debouncedFetch(query)
  }, [query, debouncedFetch])

  const handleSelect = (gif: Gif) => {
    onSelect(gif)
    onClose()
  }

  return (
    <div className={`rounded-xl border overflow-hidden ${
      isDark ? 'bg-black border-white/20' : 'bg-white border-gray-200'
    }`}>
      {/* Header with search */}
      <div className={`p-3 border-b ${isDark ? 'border-white/20' : 'border-gray-200'}`}>
        <div className="flex items-center justify-between mb-2">
          <span className={`text-sm font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
            {t('gif.title')}
          </span>
          <button
            onClick={onClose}
            className={`p-1 rounded-full transition-colors ${
              isDark ? 'hover:bg-white/10 text-gray-400' : 'hover:bg-gray-100 text-gray-500'
            }`}
          >
            <HiX className="w-5 h-5" />
          </button>
        </div>

        {/* Search input */}
        <div className="relative">
          <HiSearch className={`absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 ${
            isDark ? 'text-gray-500' : 'text-gray-400'
          }`} />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('gif.search_placeholder')}
            className={`w-full pl-9 pr-3 py-2 rounded-lg text-sm transition-colors ${
              isDark
                ? 'bg-white/5 text-white placeholder-white/40 border-white/20 focus:border-yellow-500'
                : 'bg-gray-100 text-gray-900 placeholder-gray-500 border-gray-200 focus:border-yellow-500'
            } border focus:outline-none`}
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded-full ${
                isDark ? 'hover:bg-white/10 text-gray-400' : 'hover:bg-gray-200 text-gray-500'
              }`}
            >
              <HiX className="w-3 h-3" />
            </button>
          )}
        </div>
      </div>

      {/* GIF grid */}
      <div className="p-2 max-h-80 overflow-y-auto">
        {loading ? (
          <div className="grid grid-cols-3 gap-2">
            {[...Array(9)].map((_, i) => (
              <div
                key={i}
                className={`aspect-square rounded-lg animate-pulse ${
                  isDark ? 'bg-white/10' : 'bg-gray-200'
                }`}
              />
            ))}
          </div>
        ) : error ? (
          <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {error}
          </div>
        ) : gifs.length === 0 ? (
          <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            {t('gif.empty')}
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {gifs.map((gif) => (
              <button
                key={gif.id}
                onClick={() => handleSelect(gif)}
                className="relative aspect-square rounded-lg overflow-hidden group focus:outline-none focus:ring-2 focus:ring-yellow-500"
              >
                <img
                  src={gif.preview}
                  alt={gif.title}
                  className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Giphy attribution */}
      <div className={`px-3 py-2 border-t text-center ${
        isDark ? 'border-gray-700' : 'border-gray-200'
      }`}>
        <span className={`text-xs ${isDark ? 'text-gray-500' : 'text-gray-400'}`}>
          Powered by GIPHY
        </span>
      </div>
    </div>
  )
}

export default GifPicker
