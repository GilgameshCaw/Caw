import React, { useState, useEffect, useMemo } from 'react'
import { useSearchParams, useNavigate, useLocation } from 'react-router-dom'
import { apiFetch } from '~/api/client'
import Feed from '~/components/Feed'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { HiUsers, HiHashtag, HiCollection } from 'react-icons/hi'
import { useMutePreferences } from '~/hooks/useMutePreferences'
import { getUserAvatar } from '~/utils/defaultAvatar'

interface SearchResults {
  caws: any[]
  users: any[]
  hashtags: any[]
  hasMoreCaws?: boolean
  hasMoreUsers?: boolean
  hasMoreHashtags?: boolean
}

interface SearchResultsPageProps {
  defaultTab?: 'all' | 'caws' | 'users' | 'hashtags'
}

const SearchResultsPage: React.FC<SearchResultsPageProps> = ({ defaultTab = 'all' }) => {
  const [searchParams] = useSearchParams()
  const query = searchParams.get('q') || ''
  const { isDark } = useTheme()
  const navigate = useNavigate()
  const location = useLocation()
  const { preferences } = useMutePreferences()
  const [activeTab, setActiveTab] = useState<'all' | 'caws' | 'users' | 'hashtags'>(defaultTab)
  const [results, setResults] = useState<SearchResults | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [previousTab, setPreviousTab] = useState<'all' | 'caws' | 'users' | 'hashtags'>(defaultTab)

  // Filter users based on muted/blocked accounts
  const filteredUsers = useMemo(() => {
    if (!results?.users) return []
    return results.users.filter(user =>
      !preferences.mutedAccounts.includes(user.tokenId) &&
      !preferences.blockedAccounts.includes(user.tokenId)
    )
  }, [results?.users, preferences.mutedAccounts, preferences.blockedAccounts])

  // Update activeTab based on URL path
  useEffect(() => {
    const pathParts = location.pathname.split('/')
    const tabFromPath = pathParts[pathParts.length - 1]
    if (['caws', 'users', 'hashtags'].includes(tabFromPath)) {
      setActiveTab(tabFromPath as any)
    } else if (location.pathname === '/search') {
      setActiveTab('all')
    }
  }, [location.pathname])

  useEffect(() => {
    if (!query) return

    const fetchResults = async () => {
      setLoading(true)
      setError(null)

      // Clear results when switching tabs to avoid undefined errors
      if (previousTab !== activeTab) {
        setResults(null)
        setPreviousTab(activeTab)
      }

      try {
        const data = await apiFetch<SearchResults>(
          `/api/search?q=${encodeURIComponent(query)}&type=${activeTab}`
        )
        // Ensure all properties are present
        const normalizedData: SearchResults = {
          caws: data.caws || [],
          users: data.users || [],
          hashtags: data.hashtags || []
        }
        setResults(normalizedData)
      } catch (err) {
        console.error('Search failed:', err)
        setError('Failed to search. Please try again.')
      } finally {
        setLoading(false)
      }
    }

    fetchResults()
  }, [query, activeTab])

  if (!query) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className={`text-center py-8 ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
            Enter a search query to get started
          </div>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
      <div className="mb-6">
        <h1 className={`text-2xl font-bold mb-2 ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Search Results
        </h1>
        <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
          Results for "{query}"
        </p>
      </div>

      {/* Tab Navigation */}
      <div className={`flex space-x-1 mb-6 border-b ${isDark ? 'border-white/20' : 'border-gray-200'}`}>
        {[
          { id: 'all' as const, label: 'All', icon: HiCollection },
          { id: 'caws' as const, label: 'Caws', icon: HiCollection },
          { id: 'users' as const, label: 'Users', icon: HiUsers },
          { id: 'hashtags' as const, label: 'Hashtags', icon: HiHashtag }
        ].map(tab => (
          <button
            key={tab.id}
            onClick={() => {
              setActiveTab(tab.id)
              const newPath = tab.id === 'all' ? '/search' : `/search/${tab.id}`
              navigate(`${newPath}?q=${encodeURIComponent(query)}`)
            }}
            className={`flex items-center space-x-2 px-4 py-3 transition-all ${
              activeTab === tab.id
                ? isDark
                  ? 'border-b-2 border-blue-500 text-white'
                  : 'border-b-2 border-blue-500 text-gray-900'
                : isDark
                  ? 'text-white/60 hover:text-white'
                  : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            <tab.icon className="w-4 h-4" />
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {/* Results */}
      {loading ? (
        <div className="space-y-4">
          {[...Array(3)].map((_, i) => (
            <div key={i} className={`animate-pulse ${
              isDark ? 'bg-white/10' : 'bg-gray-100'
            } rounded-lg h-32`}></div>
          ))}
        </div>
      ) : error ? (
        <div className="text-red-500 text-center py-8">{error}</div>
      ) : results ? (
        <div className="space-y-6">
          {/* Users Results - Show first on All tab */}
          {(activeTab === 'all' || activeTab === 'users') && filteredUsers.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <div className="flex items-center justify-between mb-3">
                  <h2 className={`text-lg font-semibold ${
                    isDark ? 'text-white' : 'text-gray-900'
                  }`}>Users</h2>
                  {results?.hasMoreUsers && (
                    <button
                      onClick={() => {
                        setActiveTab('users')
                        navigate(`/search/users?q=${encodeURIComponent(query)}`)
                      }}
                      className={`text-sm transition ${
                        isDark
                          ? 'text-blue-400 hover:text-blue-300'
                          : 'text-blue-600 hover:text-blue-500'
                      }`}
                    >
                      View more →
                    </button>
                  )}
                </div>
              )}
              <div className="space-y-3">
                {filteredUsers.map(user => (
                  <a
                    key={user.tokenId}
                    href={`/users/${user.username}`}
                    className={`block p-4 rounded-lg transition ${
                      isDark
                        ? 'bg-white/5 hover:bg-white/10'
                        : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center space-x-3">
                      <img
                        src={getUserAvatar(user)}
                        alt={user.username}
                        className="w-10 h-10 rounded-full object-cover"
                      />
                      <div className="flex-1">
                        <div className="flex items-center space-x-2">
                          <span className={`font-semibold ${
                            isDark ? 'text-white' : 'text-gray-900'
                          }`}>
                            {user.displayName || user.username}
                          </span>
                          {user.verified && (
                            <span className="text-blue-500 text-sm">✓</span>
                          )}
                        </div>
                        <div className={`text-sm ${
                          isDark ? 'text-white/60' : 'text-gray-600'
                        }`}>
                          @{user.username} • {user.followerCount || 0} followers
                        </div>
                      </div>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Hashtags Results */}
          {(activeTab === 'all' || activeTab === 'hashtags') && results?.hashtags && results.hashtags.length > 0 && (
            <div>
              {activeTab === 'all' && (
                <div className="flex items-center justify-between mb-3">
                  <h2 className={`text-lg font-semibold ${
                    isDark ? 'text-white' : 'text-gray-900'
                  }`}>Hashtags</h2>
                  {results.hasMoreHashtags && (
                    <button
                      onClick={() => {
                        setActiveTab('hashtags')
                        navigate(`/search/hashtags?q=${encodeURIComponent(query)}`)
                      }}
                      className={`text-sm transition ${
                        isDark
                          ? 'text-blue-400 hover:text-blue-300'
                          : 'text-blue-600 hover:text-blue-500'
                      }`}
                    >
                      View more →
                    </button>
                  )}
                </div>
              )}
              <div className="space-y-3">
                {results.hashtags.map(hashtag => (
                  <a
                    key={hashtag.tag}
                    href={`/hashtags/${hashtag.tag}`}
                    className={`block p-4 rounded-lg transition ${
                      isDark
                        ? 'bg-white/5 hover:bg-white/10'
                        : 'bg-gray-50 hover:bg-gray-100'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <HiHashtag className={`w-5 h-5 ${
                          isDark ? 'text-white/60' : 'text-gray-600'
                        }`} />
                        <span className={`font-semibold ${
                          isDark ? 'text-white' : 'text-gray-900'
                        }`}>
                          {hashtag.tag}
                        </span>
                      </div>
                      <span className={`text-sm ${
                        isDark ? 'text-white/60' : 'text-gray-600'
                      }`}>
                        {hashtag.usageCount} caws
                      </span>
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* Caws Results */}
          {(activeTab === 'all' || activeTab === 'caws') && (
            <div>
              {activeTab === 'all' && (
                <div className="flex items-center justify-between mb-3">
                  <h2 className={`text-lg font-semibold ${
                    isDark ? 'text-white' : 'text-gray-900'
                  }`}>Caws</h2>
                  {results?.hasMoreCaws && (
                    <button
                      onClick={() => {
                        setActiveTab('caws')
                        navigate(`/search/caws?q=${encodeURIComponent(query)}`)
                      }}
                      className={`text-sm transition ${
                        isDark
                          ? 'text-blue-400 hover:text-blue-300'
                          : 'text-blue-600 hover:text-blue-500'
                      }`}
                    >
                      View more →
                    </button>
                  )}
                </div>
              )}
              <Feed
                filter="search"
                apiEndpoint={`/api/search?q=${encodeURIComponent(query)}&type=caws`}
              />
            </div>
          )}

          {/* No Results */}
          {results && results.caws.length === 0 && filteredUsers.length === 0 && results.hashtags.length === 0 && (
            <div className={`text-center py-8 ${
              isDark ? 'text-white/60' : 'text-gray-600'
            }`}>
              No results found for "{query}"
            </div>
          )}
        </div>
      ) : null}
      </div>
    </MainLayout>
  )
}

export default SearchResultsPage
