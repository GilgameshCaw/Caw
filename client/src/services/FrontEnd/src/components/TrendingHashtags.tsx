import React, { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { formatLargeNumber } from '~/utils/numberFormat'

interface TrendingHashtag {
  name: string
  usageCount: number
}

const TrendingHashtags: React.FC = () => {
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchTrendingHashtags = async () => {
      try {
        const response = await fetch('/api/hashtags/trending?limit=7')
        if (response.ok) {
          const data = await response.json()
          setTrendingHashtags(data.hashtags || [])
        }
      } catch (error) {
        console.error('Failed to fetch trending hashtags:', error)
        // Don't show mock data, just show empty state
        setTrendingHashtags([])
      } finally {
        setLoading(false)
      }
    }

    fetchTrendingHashtags()
    // Refresh every 5 minutes
    const interval = setInterval(fetchTrendingHashtags, 5 * 60 * 1000)
    return () => clearInterval(interval)
  }, [])

  const handleHashtagClick = (hashtag: string) => {
    navigate(`/hashtags/${hashtag}`)
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {[...Array(7)].map((_, i) => (
          <div key={i} className="h-12 bg-gray-800 rounded-lg"></div>
        ))}
      </div>
    )
  }

  if (trendingHashtags.length === 0) {
    return (
      <div className={`text-center py-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        No trending hashtags yet
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {trendingHashtags.map((item, index) => (
        <button
          key={item.name}
          onClick={() => handleHashtagClick(item.name)}
          className={`w-full cursor-pointer p-3 rounded-lg transition-colors duration-200 group ${
            isDark
              ? 'hover:bg-white/10'
              : 'hover:bg-gray-200/50'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <span className={`font-medium transition-colors duration-200 ${
                isDark
                  ? 'text-gray-300 group-hover:text-white'
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                #{item.name}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <span className={`text-xs transition-colors duration-200 ${
                isDark
                  ? 'text-gray-400 group-hover:text-gray-300'
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {item.usageCount === 1 ? '1 caw' : `${formatLargeNumber(item.usageCount)} caws`}
              </span>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

export default TrendingHashtags
