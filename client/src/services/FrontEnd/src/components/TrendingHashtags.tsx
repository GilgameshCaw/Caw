import React from 'react'
import { useQuery } from '@tanstack/react-query'
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

  const { data: trendingHashtags = [], isLoading: loading } = useQuery<TrendingHashtag[]>({
    queryKey: ['trendingHashtags'],
    queryFn: async () => {
      const response = await fetch('/api/hashtags/trending?limit=7')
      if (!response.ok) return []
      const data = await response.json()
      return data.hashtags || []
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })

  const handleHashtagClick = (hashtag: string) => {
    navigate(`/hashtags/${hashtag}`)
  }

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        {[...Array(7)].map((_, i) => (
          <div key={i} className={`h-12 rounded-lg ${isDark ? 'bg-gray-800' : 'bg-gray-200'}`}></div>
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
      {trendingHashtags.map((item) => (
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
              <span
                className={`font-medium block overflow-hidden whitespace-nowrap transition-colors duration-200 ${
                  isDark
                    ? 'text-gray-300 group-hover:text-white'
                    : 'text-gray-600 group-hover:text-black'
                }`}
                style={{ maxWidth: 132, textOverflow: 'ellipsis' }}
                title={`#${item.name}`}
              >
                #{item.name}
              </span>
            </div>
            <div className="flex items-center space-x-2">
              <span className={`text-xs transition-colors duration-200 ${
                isDark
                  ? 'text-yellow-500/70 group-hover:text-yellow-400'
                  : 'text-amber-800/70 group-hover:text-amber-900'
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
