import React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { useTheme } from '~/hooks/useTheme'
import { formatLargeNumber } from '~/utils/numberFormat'

interface Hashtag {
  name: string
  usageCount: number
}

const DiscussionHashtags: React.FC = () => {
  const { isDark } = useTheme()
  const navigate = useNavigate()

  const { data: hashtags = [], isLoading } = useQuery<Hashtag[]>({
    queryKey: ['discussionHashtags'],
    queryFn: async () => {
      const res = await fetch('/api/hashtags/trending?limit=6')
      if (!res.ok) throw new Error('Failed to fetch hashtags')
      const data = await res.json()
      return data.hashtags || []
    },
    staleTime: 5 * 60 * 1000, // Cache for 5 minutes
    refetchInterval: 5 * 60 * 1000
  })

  const handleHashtagClick = (hashtag: string) => {
    navigate(`/hashtags/${hashtag}`)
  }

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(6)].map((_, i) => (
          <div
            key={i}
            className={`h-12 rounded-lg animate-pulse ${
              isDark ? 'bg-white/5' : 'bg-gray-100'
            }`}
          />
        ))}
      </div>
    )
  }

  if (hashtags.length === 0) {
    return (
      <div className={`text-center py-4 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
        No discussion topics yet
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {hashtags.map((topic) => (
        <button
          key={topic.name}
          onClick={() => handleHashtagClick(topic.name)}
          className={`w-full text-left cursor-pointer p-3 rounded-lg transition-colors duration-200 group ${
            isDark
              ? 'hover:bg-white/10'
              : 'hover:bg-gray-200/50'
          }`}
        >
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <span className={`font-medium transition-colors duration-200 ${
                isDark
                  ? 'text-gray-300 group-hover:text-white'
                  : 'text-gray-600 group-hover:text-black'
              }`}>
                #{topic.name}
              </span>
            </div>
            <div className="flex items-center">
              <span className={`text-xs transition-colors duration-200 ${
                isDark
                  ? 'text-gray-400 group-hover:text-gray-300'
                  : 'text-gray-500 group-hover:text-gray-600'
              }`}>
                {topic.usageCount === 1 ? '1 post' : `${formatLargeNumber(topic.usageCount)} posts`}
              </span>
            </div>
          </div>
        </button>
      ))}
    </div>
  )
}

export default DiscussionHashtags
