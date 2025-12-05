import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import PostForm from "~/components/PostForm";
import MainLayout from '~/layouts/MainLayout'
import FeedItem from '~/components/FeedItem'
import { apiFetch } from '~/api/client'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { useTokenDataStore } from '~/store/tokenDataStore'
import { HiArrowLeft } from 'react-icons/hi'

export const CawPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const [caw, setCaw]           = useState<CawItem | null>(null)
  const [comments, setComments] = useState<CawItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const { isDark } = useTheme()
  const activeTokenId = useTokenDataStore(s => s.activeTokenId)

  // Function to refresh comments after posting a reply
  const refreshComments = async () => {
    try {
      const { caw: fetched, comments: fetchedComments } =
        await apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
      setCaw(fetched)
      setComments(fetchedComments)
    } catch (error) {
      console.error('Error refreshing comments:', error)
    }
  }

  // Poll for updates when caw is pending
  useEffect(() => {
    if (!caw || caw.status !== 'PENDING') return

    const interval = setInterval(async () => {
      try {
        const { caw: fetched, comments: fetchedComments } =
          await apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
        setCaw(fetched)
        setComments(fetchedComments)

        // Stop polling if no longer pending
        if (fetched.status !== 'PENDING') {
          clearInterval(interval)
        }
      } catch (error) {
        console.error('Error polling for caw updates:', error)
      }
    }, 2000) // Poll every 2 seconds

    return () => clearInterval(interval)
  }, [caw?.status, id])

  // Load caw and comments - refetch when id or activeTokenId changes
  useEffect(() => {
    (async () => {
      try {
        setLoading(true)
        setError(null)

        const { caw: fetched, comments: fetchedComments } =
          await apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
        setCaw(fetched)
        setComments(fetchedComments)
      } catch (err) {
        console.error('Error loading caw:', err)
        setError('Failed to load post')
      } finally {
        setLoading(false)
      }
    })()
  }, [id, activeTokenId])

  if (loading) return <MainLayout><div className="flex items-center justify-center h-64 text-white">Loading…</div></MainLayout>
  if (error) return <MainLayout><div className="flex items-center justify-center h-64 text-red-500">{error}</div></MainLayout>
  if (!caw) return <MainLayout><div className="flex items-center justify-center h-64 text-gray-500">Post not found</div></MainLayout>

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Header with back button and title */}
        <div className="flex items-center space-x-4 mb-6 pb-4 border-b border-white/20">
          <Link 
            to="/home" 
            className={`p-2 rounded-full transition-all duration-200 cursor-pointer hover:bg-white/10 ${
              isDark ? 'text-white' : 'text-black'
            }`}
          >
            <HiArrowLeft className="w-6 h-6" />
          </Link>
          <h1 className={`text-xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Feed
          </h1>
        </div>

        {/* Main Post - Expanded View */}
        <div className="mb-6 relative">
          {/* Show "Replying to" if this caw is a reply */}
          {caw.parent && (
            <div className="px-4 py-2 mb-2">
              <Link
                to={`/caws/${caw.parent.id}`}
                className={`text-sm transition-colors duration-300 hover:underline ${
                  isDark ? 'text-gray-400 hover:text-gray-300' : 'text-gray-600 hover:text-gray-700'
                }`}
              >
                Replying to @{caw.parent.user.username}
              </Link>
            </div>
          )}

          <div className="relative z-10">
            <FeedItem
              item={{
                id:            caw.id,
                user:          caw.user,
                content:       caw.content,
                timestamp:     caw.timestamp,
                likeCount:     caw.likeCount,
                viewCount:     caw.viewCount || 0,  // Include viewCount
                hasLiked:      caw.hasLiked,
                hasRecawed:    caw.hasRecawed,
                commentCount:  caw.commentCount,
                recawCount:    caw.recawCount,
                cawonce:       caw.cawonce,
                userId:        caw.user.tokenId,
                originalCaw:   caw.originalCaw,
                status:        caw.status,  // Include status field
                imageData:     caw.imageData,  // Include imageData
                hasImage:      caw.hasImage,  // Include hasImage
                videoData:     caw.videoData,  // Include videoData
                hasVideo:      caw.hasVideo,  // Include hasVideo
              }}
              isMainPost={true}
            />
          </div>
        </div>

        {/* Reply Form */}
        <div className="border-b border-white/20 mb-2">
          <PostForm
            replyTo={caw}
            onSuccess={refreshComments}
          />
        </div>

        {/* Comments Section */}
        <div className="space-y-0 relative">
          {/* Continuous vertical line connecting all comment avatars */}
          {comments.length > 0 && (
            <div
              className="absolute w-px bg-white/20 z-0"
              style={{
                left: '23px',
                top: '34px',
                height: `${comments.length * 80 - 40}px` // Height for remaining avatars
              }}
            ></div>
          )}
          
          {comments.map((comm, index) => (
            <div key={comm.id} className="relative">
              <FeedItem
                item={comm}
                isReply={true}
                onLikeStateChange={(cawId, likePending) => {
                  console.log('[CawPage] Like state changed for reply', cawId, 'pending:', likePending)
                  setComments(current =>
                    current.map(item =>
                      item.id === cawId ? { ...item, likePending } : item
                    )
                  )
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </MainLayout>
  )
}

