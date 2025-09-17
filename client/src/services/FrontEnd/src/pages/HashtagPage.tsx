// src/pages/HashtagPage.tsx
import React, { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import MainLayout from '~/layouts/MainLayout'
import Feed from '~/components/Feed'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft, HiTrendingUp, HiHashtag } from 'react-icons/hi'
import { formatUsageCount } from '~/utils/numberFormat'

interface HashtagInfo {
  name: string
  usageCount: number
  createdAt?: string
  updatedAt?: string
}

interface TrendingHashtag {
  name: string
  usageCount: number
}

export const HashtagPage: React.FC = () => {
  const { hashtag } = useParams<{ hashtag: string }>()
  const navigate = useNavigate()
  const { isDark } = useTheme()

  const [hashtagInfo, setHashtagInfo] = useState<HashtagInfo | null>(null)
  const [trendingHashtags, setTrendingHashtags] = useState<TrendingHashtag[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Clean hashtag name (remove # if present)
  const cleanHashtag = hashtag?.replace(/^#/, '') || ''

  useEffect(() => {
    if (!cleanHashtag) {
      setError('Invalid hashtag')
      setLoading(false)
      return
    }

    const fetchHashtagData = async () => {
      try {
        setLoading(true)

        // Fetch hashtag info and trending hashtags in parallel
        const [hashtagResponse, trendingResponse] = await Promise.all([
          fetch(`/api/hashtags/${cleanHashtag}`),
          fetch('/api/hashtags/trending?limit=10')
        ])

        if (hashtagResponse.ok) {
          const hashtagData = await hashtagResponse.json()
          setHashtagInfo(hashtagData.hashtag)
        } else {
          // Hashtag doesn't exist yet, create placeholder
          setHashtagInfo({
            name: cleanHashtag,
            usageCount: 0
          })
        }

        if (trendingResponse.ok) {
          const trendingData = await trendingResponse.json()
          setTrendingHashtags(trendingData.hashtags || [])
        }

      } catch (err) {
        console.error('Error fetching hashtag data:', err)
        setError('Failed to load hashtag data')

        // Fallback to mock data
        setHashtagInfo({
          name: cleanHashtag,
          usageCount: 42
        })
        setTrendingHashtags([
          { name: "CawProtocol", usageCount: 1542 },
          { name: "Web3", usageCount: 1234 },
          { name: "DeFi", usageCount: 987 },
          { name: "NFT", usageCount: 856 },
          { name: "Blockchain", usageCount: 743 }
        ])
      } finally {
        setLoading(false)
      }
    }

    fetchHashtagData()
  }, [cleanHashtag])

  const handleBack = () => {
    navigate(-1)
  }

  const handleHashtagClick = (hashtagName: string) => {
    navigate(`/hashtags/${hashtagName}`)
  }

  if (loading) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className="animate-pulse">
            <div className="h-8 bg-gray-800 rounded mb-4"></div>
            <div className="h-4 bg-gray-800 rounded w-1/3 mb-6"></div>
            {/* Trending hashtags skeleton */}
            <div className="mb-6 p-4 bg-gray-800 rounded-lg">
              <div className="h-5 bg-gray-700 rounded w-1/3 mb-3"></div>
              <div className="flex flex-wrap gap-2">
                {[...Array(5)].map((_, i) => (
                  <div key={i} className="h-6 bg-gray-700 rounded-full w-16"></div>
                ))}
              </div>
            </div>
            {/* Posts skeleton */}
            <div className="space-y-4">
              {[...Array(3)].map((_, i) => (
                <div key={i} className="h-32 bg-gray-800 rounded"></div>
              ))}
            </div>
          </div>
        </div>
      </MainLayout>
    )
  }

  if (error && !hashtagInfo) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className="text-center py-12">
            <HiHashtag className="mx-auto h-12 w-12 text-gray-400 mb-4" />
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-2">
              Hashtag not found
            </h2>
            <p className="text-gray-600 dark:text-gray-400 mb-6">
              The hashtag you're looking for doesn't exist or hasn't been used yet.
            </p>
            <button
              onClick={handleBack}
              className="inline-flex items-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
            >
              <HiArrowLeft className="mr-2 h-4 w-4" />
              Go Back
            </button>
          </div>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header */}
        <div className="flex items-center mb-6">
          <button
            onClick={handleBack}
            className="mr-4 p-2 rounded-full hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
          >
            <HiArrowLeft className="h-5 w-5 text-gray-600 dark:text-gray-400" />
          </button>

          <div className="flex-1">
            <div className="flex items-center mb-2">
              <HiHashtag className="h-6 w-6 text-blue-600 mr-2" />
              <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
                {hashtagInfo?.name}
              </h1>
            </div>

            <p className="text-gray-600 dark:text-gray-400">
              {hashtagInfo?.usageCount === 0
                ? 'No posts yet'
                : formatUsageCount(hashtagInfo.usageCount)
              }
            </p>
          </div>
        </div>

        {/* Trending Hashtags Sidebar */}
        {trendingHashtags.length > 0 && (
          <div className="mb-6 p-4 bg-gray-800 rounded-lg">
            <div className="flex items-center mb-3">
              <HiTrendingUp className="h-5 w-5 text-orange-500 mr-2" />
              <h3 className="font-semibold text-white">
                Trending Hashtags
              </h3>
            </div>

            <div className="flex flex-wrap gap-2">
              {trendingHashtags.slice(0, 5).map((tag) => (
                <button
                  key={tag.name}
                  onClick={() => handleHashtagClick(tag.name)}
                  className={`
                    inline-flex items-center px-3 py-1 rounded-full text-sm
                    ${tag.name === cleanHashtag
                      ? 'bg-yellow-500 text-black'
                      : 'bg-gray-700 text-gray-300 hover:bg-gray-600 border border-gray-600'
                    }
                    transition-colors
                  `}
                >
                  <HiHashtag className="h-3 w-3 mr-1" />
                  {tag.name}
                  <span className="ml-2 text-xs opacity-75">
                    {formatUsageCount(tag.usageCount)}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Posts Feed */}
        <div>
          {hashtagInfo?.usageCount === 0 ? (
            <div className="text-center py-12">
              <HiHashtag className="mx-auto h-12 w-12 text-gray-400 mb-4" />
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                No posts with #{cleanHashtag} yet
              </h3>
              <p className="text-gray-600 dark:text-gray-400">
                Be the first to use this hashtag in your caw!
              </p>
            </div>
          ) : (
            <Feed
              filter={`hashtag:${cleanHashtag}`}
              apiEndpoint={`/api/hashtags/${cleanHashtag}/caws`}
            />
          )}
        </div>
      </div>
    </MainLayout>
  )
}

export default HashtagPage