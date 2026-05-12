// src/pages/HashtagPage.tsx
import React from 'react'
import { useParams } from 'react-router-dom'
import { useNavigate } from '~/utils/localizedRouter'
import Feed from '~/components/Feed'
import { useTheme } from '~/hooks/useTheme'
import { useQuery } from '@tanstack/react-query'
import { HiArrowLeft, HiTrendingUp, HiHashtag } from 'react-icons/hi'
import { useT } from '~/i18n/I18nProvider'

interface TrendingHashtag {
  name: string
  usageCount: number
}

export const HashtagPage: React.FC = () => {
  const t = useT()
  const { hashtag } = useParams<{ hashtag: string }>()
  const navigate = useNavigate()
  const { isDark } = useTheme()
  const cleanHashtag = hashtag?.replace(/^#/, '') || ''

  // Trending hashtags — cached globally, not per-hashtag
  const { data: trendingHashtags = [] } = useQuery<TrendingHashtag[]>({
    queryKey: ['trending-hashtags'],
    queryFn: async () => {
      const res = await fetch('/api/hashtags/trending?limit=10')
      if (!res.ok) return []
      const data = await res.json()
      return data.hashtags || []
    },
    staleTime: 5 * 60 * 1000,
  })

  return (
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center mb-6">
          <button
            onClick={() => navigate(-1)}
            className={`mr-4 p-2 rounded-full transition-colors cursor-pointer ${isDark ? 'hover:bg-gray-800' : 'hover:bg-gray-100'}`}
          >
            <HiArrowLeft className={`h-5 w-5 ${isDark ? 'text-gray-400' : 'text-gray-600'}`} />
          </button>
          <div className="flex items-center">
            <HiHashtag className={`h-6 w-6 mr-2 ${isDark ? 'text-yellow-500' : 'text-amber-800'}`} />
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {cleanHashtag}
            </h1>
          </div>
        </div>

        {/* Trending Hashtags */}
        {trendingHashtags.length > 0 && (
          <div className={`mb-6 p-4 rounded-lg ${isDark ? 'bg-black border border-white/10' : 'bg-gray-100 border border-gray-200'}`}>
            <div className="flex items-center mb-3">
              <HiTrendingUp className="h-5 w-5 text-orange-500 mr-2" />
              <h3 className={`font-semibold ${isDark ? 'text-white' : 'text-gray-900'}`}>
                {t('hashtag.trending')}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {trendingHashtags.slice(0, 5).map((tag) => (
                <button
                  key={tag.name}
                  onClick={() => navigate(`/hashtags/${tag.name}`)}
                  className={`
                    inline-flex items-center px-3 py-1 rounded-full text-sm cursor-pointer
                    ${tag.name === cleanHashtag
                      ? 'bg-yellow-500 text-black'
                      : isDark
                        ? 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                        : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-300'
                    }
                    transition-colors
                  `}
                >
                  <HiHashtag className="h-3 w-3 mr-1" />
                  {tag.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Feed — key forces remount when hashtag changes */}
        <Feed
          key={cleanHashtag}
          filter={`hashtag:${cleanHashtag}`}
          apiEndpoint={`/api/hashtags/${cleanHashtag}/caws`}
        />
      </div>
  )
}

export default HashtagPage
