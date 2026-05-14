import React, { useState, useEffect } from 'react'
import { Link } from '~/utils/localizedRouter'
import { useTheme } from '~/hooks/useTheme'
import { useMutePreferences } from '~/hooks/useMutePreferences'
import { HiArrowLeft, HiX, HiVolumeOff, HiFilter, HiUserRemove, HiEyeOff, HiTrash, HiChevronDown, HiChevronUp } from 'react-icons/hi'
import { apiFetch } from '~/api/client'
import { CawItem } from '~/types'
import ContentWithHashtags from '~/components/ContentWithHashtags'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { useT } from '~/i18n/I18nProvider'

interface HiddenPostData {
  id: string
  username: string
  content: string
  timestamp: string
  loading: boolean
  error: boolean
  hasImage?: boolean
  imageData?: string
  imageUrl?: string
}

interface UserData {
  tokenId: number
  username: string
  displayName?: string
  loading: boolean
  error: boolean
}

interface MutedThreadData {
  id: string
  content: string
  createdAt: string
  user: {
    tokenId: number
    username: string
    displayName?: string
    avatarUrl?: string
  }
  loading: boolean
  error: boolean
}

const MutedContentPage: React.FC = () => {
  const t = useT()
  const { isDark } = useTheme()
  const {
    preferences,
    removeMutedWord,
    removeMutedThread,
    removeHiddenPost,
    removeMutedAccount,
    removeBlockedAccount,
    clearAllMutes
  } = useMutePreferences()

  const activeTokenId = useTokenDataStore(s => s.activeTokenId)
  const activeToken = useTokenDataStore(s => {
    const tokens = Object.values(s.tokensByAddress).flat()
    return tokens.find(t => t.tokenId === s.activeTokenId) || tokens[0]
  })

  const [expandedPosts, setExpandedPosts] = useState<Set<string>>(new Set())
  const [postData, setPostData] = useState<Record<string, HiddenPostData>>({})
  const [userData, setUserData] = useState<Record<string, UserData>>({})
  const [threadData, setThreadData] = useState<Record<string, MutedThreadData>>({})

  // Fetch thread data for muted threads (from localStorage)
  useEffect(() => {
    const fetchThreadData = async (threadId: string) => {
      if (threadData[threadId]) return // Already fetched

      setThreadData(prev => ({
        ...prev,
        [threadId]: { id: threadId, content: '', createdAt: '', user: { tokenId: 0, username: '' }, loading: true, error: false }
      }))

      try {
        const response = await apiFetch<{ caw: CawItem }>(`/api/caws/${threadId}`)
        if (response?.caw) {
          setThreadData(prev => ({
            ...prev,
            [threadId]: {
              id: threadId,
              content: response.caw.content || '',
              createdAt: response.caw.timestamp,
              user: {
                tokenId: response.caw.user?.tokenId || 0,
                username: response.caw.user?.username || 'Unknown',
                displayName: response.caw.user?.displayName,
                avatarUrl: response.caw.user?.avatarUrl
              },
              loading: false,
              error: false
            }
          }))
        }
      } catch (err) {
        console.error('Failed to fetch thread data:', err)
        setThreadData(prev => ({
          ...prev,
          [threadId]: { id: threadId, content: '', createdAt: '', user: { tokenId: 0, username: '' }, loading: false, error: true }
        }))
      }
    }

    preferences.mutedThreads.forEach(threadId => {
      fetchThreadData(threadId)
    })
  }, [preferences.mutedThreads])

  // Fetch user data for muted/blocked accounts
  useEffect(() => {
    const fetchUserData = async (tokenId: string) => {
      if (userData[tokenId]) return // Already fetched

      setUserData(prev => ({
        ...prev,
        [tokenId]: { tokenId: Number(tokenId), username: '', loading: true, error: false }
      }))

      try {
        const user = await apiFetch<{ tokenId: number; username: string; displayName?: string }>(`/api/users/by-token/${tokenId}`)
        setUserData(prev => ({
          ...prev,
          [tokenId]: {
            tokenId: Number(tokenId),
            username: user.username,
            displayName: user.displayName,
            loading: false,
            error: false
          }
        }))
      } catch (err) {
        console.error('Failed to fetch user data:', err)
        setUserData(prev => ({
          ...prev,
          [tokenId]: { tokenId: Number(tokenId), username: '', loading: false, error: true }
        }))
      }
    }

    // Fetch data for all muted and blocked accounts
    const allAccountIds = [...new Set([...preferences.mutedAccounts, ...preferences.blockedAccounts])]
    allAccountIds.forEach(tokenId => {
      fetchUserData(String(tokenId))
    })
  }, [preferences.mutedAccounts, preferences.blockedAccounts])

  // Fetch post data for hidden posts
  useEffect(() => {
    const fetchPostData = async (postId: string) => {
      if (postData[postId]) return // Already fetched

      setPostData(prev => ({
        ...prev,
        [postId]: { id: postId, username: '', content: '', timestamp: '', loading: true, error: false }
      }))

      try {
        const response = await apiFetch<{ caw: CawItem }>(`/api/caws/${postId}`)
        const caw = response.caw
        setPostData(prev => ({
          ...prev,
          [postId]: {
            id: postId,
            username: caw.user?.username || 'unknown',
            content: caw.content || '',
            timestamp: caw.timestamp || '',
            loading: false,
            error: false,
            hasImage: caw.hasImage,
            imageData: caw.imageData,
            imageUrl: caw.imageUrl
          }
        }))
      } catch (err) {
        console.error('Failed to fetch post data:', err)
        setPostData(prev => ({
          ...prev,
          [postId]: { id: postId, username: '', content: '', timestamp: '', loading: false, error: true }
        }))
      }
    }

    // Fetch data for all hidden posts
    preferences.hiddenPosts.forEach(postId => {
      fetchPostData(postId)
    })
  }, [preferences.hiddenPosts])

  const toggleExpanded = (postId: string) => {
    setExpandedPosts(prev => {
      const newSet = new Set(prev)
      if (newSet.has(postId)) {
        newSet.delete(postId)
      } else {
        newSet.add(postId)
      }
      return newSet
    })
  }

  const formatDate = (timestamp: string): string => {
    if (!timestamp) return ''
    const date = new Date(timestamp)
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
  }

  const totalMutes =
    preferences.mutedWords.length +
    preferences.mutedThreads.length +
    preferences.hiddenPosts.length +
    preferences.mutedAccounts.length +
    preferences.blockedAccounts.length

  return (
      <div className="max-w-2xl mx-auto px-3 sm:px-6 py-4">
        {/* Header */}
        <div className="flex items-center gap-4 mb-6">
          <Link
            to="/settings"
            className={`p-2 rounded-full transition-colors cursor-pointer ${
              isDark ? 'hover:bg-white/10' : 'hover:bg-gray-100'
            }`}
          >
            <HiArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
              {t('muted.title')}
            </h1>
            <p className={`text-sm ${isDark ? 'text-white/60' : 'text-gray-600'}`}>
              {t('muted.subtitle')}
            </p>
          </div>
        </div>

        {/* Browser-specific notice */}
        <div className={`mb-6 px-4 py-3 rounded-lg text-sm ${
          isDark ? 'bg-white/5 text-white/60' : 'bg-gray-50 text-gray-600'
        }`}>
          {t('muted.storage_notice')}
        </div>

        {/* Clear All */}
        {totalMutes > 0 && (
          <button
            onClick={() => {
              if (confirm(t('muted.clear_all_confirm'))) {
                clearAllMutes()
              }
            }}
            className={`w-full mb-6 py-3 px-4 rounded-lg flex items-center justify-center gap-2 transition-colors ${
              isDark
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20'
                : 'bg-red-50 text-red-600 hover:bg-red-100'
            }`}
          >
            <HiTrash className="w-4 h-4" />
            {t('muted.clear_all')} ({totalMutes})
          </button>
        )}

        {/* Muted Words */}
        <section className="mb-8">
          <div className={`flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <HiFilter className="w-5 h-5" />
            <h2 className="font-semibold">{t('muted.section.words')}</h2>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              ({preferences.mutedWords.length})
            </span>
          </div>
          {preferences.mutedWords.length === 0 ? (
            <p className={`text-sm py-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              {t('muted.empty.words')}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {preferences.mutedWords.map(word => (
                <span
                  key={word}
                  className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm ${
                    isDark
                      ? 'bg-white/10 text-white'
                      : 'bg-gray-100 text-gray-900'
                  }`}
                >
                  {word}
                  <button
                    onClick={() => removeMutedWord(word)}
                    className={`ml-1 p-0.5 rounded-full transition-colors ${
                      isDark ? 'hover:bg-white/20' : 'hover:bg-gray-200'
                    }`}
                  >
                    <HiX className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </section>

        {/* Muted Threads */}
        <section className="mb-8">
          <div className={`flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <HiVolumeOff className="w-5 h-5" />
            <h2 className="font-semibold">{t('muted.section.threads')}</h2>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              ({preferences.mutedThreads.length})
            </span>
          </div>
          {preferences.mutedThreads.length === 0 ? (
            <p className={`text-sm py-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              {t('muted.empty.threads')}
            </p>
          ) : (
            <div className="space-y-2">
              {preferences.mutedThreads.map(threadId => {
                const thread = threadData[threadId]
                return (
                  <div
                    key={threadId}
                    className={`flex items-center justify-between px-4 py-3 rounded-lg ${
                      isDark ? 'bg-white/5' : 'bg-gray-50'
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      {thread?.loading ? (
                        <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                          Loading...
                        </span>
                      ) : thread?.error ? (
                        <Link
                          to={`/caws/${threadId}`}
                          className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'} hover:underline`}
                        >
                          Thread #{threadId}
                        </Link>
                      ) : thread ? (
                        <>
                          <Link
                            to={`/caws/${threadId}`}
                            className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'} hover:underline`}
                          >
                            @{thread.user.username}: {formatDate(thread.createdAt)}
                          </Link>
                          <p className={`text-xs truncate mt-1 ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                            {thread.content.slice(0, 100)}{thread.content.length > 100 ? '...' : ''}
                          </p>
                        </>
                      ) : (
                        <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                          Thread #{threadId}
                        </span>
                      )}
                    </div>
                    <button
                      onClick={() => removeMutedThread(threadId)}
                      className={`text-sm px-3 py-1 rounded transition-colors ml-2 ${
                        isDark
                          ? 'text-white/60 hover:text-white hover:bg-white/10'
                          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                      }`}
                    >
                      Unmute
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Hidden Posts */}
        <section className="mb-8">
          <div className={`flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <HiEyeOff className="w-5 h-5" />
            <h2 className="font-semibold">{t('muted.section.hidden_posts')}</h2>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              ({preferences.hiddenPosts.length})
            </span>
          </div>
          {preferences.hiddenPosts.length === 0 ? (
            <p className={`text-sm py-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              No hidden posts. Posts you hide won't appear in your feed.
            </p>
          ) : (
            <div className="space-y-2">
              {preferences.hiddenPosts.map(postId => {
                const post = postData[postId]
                const isExpanded = expandedPosts.has(postId)

                return (
                  <div
                    key={postId}
                    className={`rounded-lg ${
                      isDark ? 'bg-white/5' : 'bg-gray-50'
                    }`}
                  >
                    <div className="flex items-center justify-between px-4 py-3">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        {post?.loading ? (
                          <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                            Loading...
                          </span>
                        ) : post?.error ? (
                          <Link
                            to={`/caws/${postId}`}
                            className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'} hover:underline`}
                          >
                            Post #{postId}
                          </Link>
                        ) : post ? (
                          <Link
                            to={`/caws/${postId}`}
                            className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'} hover:underline truncate`}
                          >
                            @{post.username}: {formatDate(post.timestamp)}
                          </Link>
                        ) : (
                          <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                            Post #{postId}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => toggleExpanded(postId)}
                          className={`text-sm px-3 py-1 rounded transition-colors flex items-center gap-1 ${
                            isDark
                              ? 'text-white/60 hover:text-white hover:bg-white/10'
                              : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                          }`}
                        >
                          {isExpanded ? (
                            <>
                              <HiChevronUp className="w-4 h-4" />
                              Hide
                            </>
                          ) : (
                            <>
                              <HiChevronDown className="w-4 h-4" />
                              Show
                            </>
                          )}
                        </button>
                        <button
                          onClick={() => removeHiddenPost(postId)}
                          className={`text-sm px-3 py-1 rounded transition-colors ${
                            isDark
                              ? 'text-white/60 hover:text-white hover:bg-white/10'
                              : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                          }`}
                        >
                          Unhide
                        </button>
                      </div>
                    </div>

                    {/* Expanded post content */}
                    {isExpanded && post && !post.loading && !post.error && (
                      <div className={`px-4 pb-3 border-t ${
                        isDark ? 'border-white/10' : 'border-gray-200'
                      }`}>
                        <div className={`text-sm pt-3 ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                          {post.content ? (
                            <ContentWithHashtags content={post.content} postId={post.id} />
                          ) : (
                            <span className="italic opacity-50">No content</span>
                          )}
                        </div>

                        {/* Image Display */}
                        {post.hasImage && (
                          <div className="mt-3">
                            {(() => {
                              if (post.imageData) {
                                if (post.imageData.startsWith('urls:')) {
                                  // Off-chain images stored as URLs (including Giphy)
                                  const urls = post.imageData.replace('urls:', '').split('|||')
                                  return (
                                    (() => {
                                      const count = urls.length
                                      if (count <= 0) return null

                                      if (count === 1) {
                                        const url = urls[0]
                                        return (
                                          <div className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 w-full max-w-md">
                                            <img
                                              src={url}
                                              alt="Post image"
                                              className="block w-full h-auto"
                                              onError={(e) => {
                                                e.currentTarget.style.display = 'none'
                                              }}
                                            />
                                          </div>
                                        )
                                      }

                                      const gridClass =
                                        count === 2
                                            ? 'grid grid-cols-2 gap-2 aspect-video rounded-lg overflow-hidden max-w-md'
                                            : count === 3
                                              ? 'grid grid-cols-2 grid-rows-2 gap-2 aspect-video rounded-lg overflow-hidden max-w-md'
                                              : 'grid grid-cols-2 grid-rows-2 gap-2 aspect-video rounded-lg overflow-hidden max-w-md'

                                      const cellClass = (i: number) =>
                                        count === 3 && i === 0 ? 'row-span-2 w-full h-full' : 'w-full h-full'

                                      return (
                                        <div className={gridClass}>
                                          {urls.slice(0, 4).map((url, index) => (
                                            <div key={index} className={`relative w-full h-full overflow-hidden border border-gray-200 dark:border-gray-700 ${cellClass(index)}`}>
                                              <img
                                                src={url}
                                                alt={`Post image ${index + 1}`}
                                                className="block w-full h-full object-cover"
                                                onError={(e) => {
                                                  e.currentTarget.style.display = 'none'
                                                }}
                                              />
                                            </div>
                                          ))}
                                        </div>
                                      )
                                    })()
                                  )
                                } else {
                                  // On-chain images stored as base64
                                  const images = post.imageData.split('|||')
                                  return (
                                    (() => {
                                      const count = images.length
                                      if (count <= 0) return null

                                      if (count === 1) {
                                        const imageBase64 = images[0]
                                        return (
                                          <div className="relative rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 w-full max-w-md">
                                            <img
                                              src={`data:image/jpeg;base64,${imageBase64}`}
                                              alt="Post image"
                                              className="block w-full h-auto"
                                              onError={(e) => {
                                                e.currentTarget.style.display = 'none'
                                              }}
                                            />
                                          </div>
                                        )
                                      }

                                      const gridClass =
                                        count === 2
                                            ? 'grid grid-cols-2 gap-2 aspect-video rounded-lg overflow-hidden max-w-md'
                                            : count === 3
                                              ? 'grid grid-cols-2 grid-rows-2 gap-2 aspect-video rounded-lg overflow-hidden max-w-md'
                                              : 'grid grid-cols-2 grid-rows-2 gap-2 aspect-video rounded-lg overflow-hidden max-w-md'

                                      const cellClass = (i: number) =>
                                        count === 3 && i === 0 ? 'row-span-2 w-full h-full' : 'w-full h-full'

                                      return (
                                        <div className={gridClass}>
                                          {images.slice(0, 4).map((imageBase64, index) => (
                                            <div key={index} className={`relative w-full h-full overflow-hidden border border-gray-200 dark:border-gray-700 ${cellClass(index)}`}>
                                              <img
                                                src={`data:image/jpeg;base64,${imageBase64}`}
                                                alt={`Post image ${index + 1}`}
                                                className="block w-full h-full object-cover"
                                                onError={(e) => {
                                                  e.currentTarget.style.display = 'none'
                                                }}
                                              />
                                            </div>
                                          ))}
                                        </div>
                                      )
                                    })()
                                  )
                                }
                              } else if (post.imageUrl) {
                                // Legacy single image URL
                                return (
                                  <div className="relative max-w-md rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700">
                                    <img
                                      src={post.imageUrl}
                                      alt="Post image"
                                      className="block w-full h-auto"
                                      onError={(e) => {
                                        e.currentTarget.style.display = 'none'
                                      }}
                                    />
                                  </div>
                                )
                              }
                              return null
                            })()}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Muted Accounts */}
        <section className="mb-8">
          <div className={`flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <HiVolumeOff className="w-5 h-5" />
            <h2 className="font-semibold">{t('muted.section.accounts')}</h2>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              ({preferences.mutedAccounts.length})
            </span>
          </div>
          {preferences.mutedAccounts.length === 0 ? (
            <p className={`text-sm py-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              No muted accounts. Posts from muted accounts won't appear in your feed.
            </p>
          ) : (
            <div className="space-y-2">
              {preferences.mutedAccounts.map(tokenId => {
                const user = userData[String(tokenId)]
                return (
                  <div
                    key={tokenId}
                    className={`flex items-center justify-between px-4 py-3 rounded-lg ${
                      isDark ? 'bg-white/5' : 'bg-gray-50'
                    }`}
                  >
                    {user?.loading ? (
                      <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                        Loading...
                      </span>
                    ) : user?.username ? (
                      <Link
                        to={`/users/${user.username}`}
                        className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'} hover:underline`}
                      >
                        @{user.username}
                      </Link>
                    ) : (
                      <span className={`text-sm ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                        User #{tokenId}
                      </span>
                    )}
                    <button
                      onClick={() => {
                        const effectiveTokenId = activeTokenId || activeToken?.tokenId
                        removeMutedAccount(tokenId, effectiveTokenId)
                      }}
                      className={`text-sm px-3 py-1 rounded transition-colors ${
                        isDark
                          ? 'text-white/60 hover:text-white hover:bg-white/10'
                          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                      }`}
                    >
                      Unmute
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* Blocked Accounts */}
        <section className="mb-8">
          <div className={`flex items-center gap-2 mb-3 ${isDark ? 'text-white' : 'text-gray-900'}`}>
            <HiUserRemove className="w-5 h-5" />
            <h2 className="font-semibold">{t('muted.section.blocked')}</h2>
            <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
              ({preferences.blockedAccounts.length})
            </span>
          </div>
          {preferences.blockedAccounts.length === 0 ? (
            <p className={`text-sm py-4 ${isDark ? 'text-white/40' : 'text-gray-400'}`}>
              No blocked accounts. Posts and profiles from blocked accounts will be hidden from your view.
            </p>
          ) : (
            <div className="space-y-2">
              {preferences.blockedAccounts.map(tokenId => {
                const user = userData[String(tokenId)]
                return (
                  <div
                    key={tokenId}
                    className={`flex items-center justify-between px-4 py-3 rounded-lg ${
                      isDark ? 'bg-white/5' : 'bg-gray-50'
                    }`}
                  >
                    {user?.loading ? (
                      <span className={`text-sm ${isDark ? 'text-white/50' : 'text-gray-500'}`}>
                        Loading...
                      </span>
                    ) : user?.username ? (
                      <Link
                        to={`/users/${user.username}`}
                        className={`text-sm ${isDark ? 'text-blue-400' : 'text-blue-600'} hover:underline`}
                      >
                        @{user.username}
                      </Link>
                    ) : (
                      <span className={`text-sm ${isDark ? 'text-white/80' : 'text-gray-700'}`}>
                        User #{tokenId}
                      </span>
                    )}
                    <button
                      onClick={() => {
                        const effectiveTokenId = activeTokenId || activeToken?.tokenId
                        removeBlockedAccount(tokenId, effectiveTokenId)
                      }}
                      className={`text-sm px-3 py-1 rounded transition-colors ${
                        isDark
                          ? 'text-white/60 hover:text-white hover:bg-white/10'
                          : 'text-gray-600 hover:text-gray-900 hover:bg-gray-100'
                      }`}
                    >
                      Unblock
                    </button>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
  )
}

export default MutedContentPage
