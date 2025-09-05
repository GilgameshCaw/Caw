import React, { useEffect, useState } from 'react'
import { useParams, Link } from 'react-router-dom'
import PostForm from "~/components/PostForm";
import MainLayout from '~/layouts/MainLayout'
import FeedItem from '~/components/FeedItem'
import ReplyItem from '~/components/ReplyItem'
import { apiFetch } from '~/api/client'
import type { CawItem } from '~/types'
import { useTheme } from '~/hooks/useTheme'
import { HiArrowLeft } from 'react-icons/hi'

export const CawPage: React.FC = () => {
  const { id } = useParams<{ id: string }>()
  const [caw, setCaw]           = useState<CawItem | null>(null)
  const [comments, setComments] = useState<CawItem[]>([])
  const [loading, setLoading]   = useState(true)
  const [error, setError]       = useState<string | null>(null)
  const { isDark } = useTheme()

  useEffect(() => {
    (async () => {
      try {
        setLoading(true)
        setError(null)
        
        // Try to fetch from API first
        try {
          const { caw: fetched, comments: fetchedComments } =
            await apiFetch<{ caw: CawItem; comments: CawItem[] }>(`/api/caws/${id}`)
          setCaw(fetched)
          setComments(fetchedComments)
        } catch (apiError) {
          console.log('API not available, using mock data for caw:', id)
          
          // Fallback to mock data
          const mockCaw: CawItem = {
            id: id || 'mock-1',
            user: { tokenId: 1, username: 'cawuser1' },
            content: 'Just discovered the amazing potential of decentralized social media! The Caw Protocol is revolutionizing how we connect online. This is the future of social networking! 🚀',
            timestamp: new Date().toISOString(),
            likeCount: 89,
            hasLiked: false,
            hasRecawed: false,
            commentCount: 15,
            recawCount: 28,
            cawonce: 1,
            userId: 1,
            originalCaw: undefined
          }
          
          const mockComments: CawItem[] = [
            {
              id: 'comment-1',
              user: { tokenId: 2, username: 'blockchaindev' },
              content: 'Absolutely agree! The staking rewards are incredible too.',
              timestamp: new Date(Date.now() - 3600000).toISOString(),
              likeCount: 12,
              hasLiked: false,
              hasRecawed: false,
              commentCount: 3,
              recawCount: 5,
              cawonce: 2,
              userId: 2,
              originalCaw: undefined
            },
            {
              id: 'comment-2',
              user: { tokenId: 3, username: 'cryptoenthusiast' },
              content: 'Been following this project since day one. Amazing work!',
              timestamp: new Date(Date.now() - 7200000).toISOString(),
              likeCount: 8,
              hasLiked: false,
              hasRecawed: false,
              commentCount: 1,
              recawCount: 2,
              cawonce: 3,
              userId: 3,
              originalCaw: undefined
            }
          ]
          
          setCaw(mockCaw)
          setComments(mockComments)
        }
      } catch (err) {
        console.error('Error loading caw:', err)
        setError('Failed to load post')
      } finally {
        setLoading(false)
      }
    })()
  }, [id])

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
          
          <div className="relative z-10">
            <FeedItem 
              item={{
                id:            caw.id,
                user:          caw.user,
                content:       caw.content,
                timestamp:     caw.timestamp,
                likeCount:     caw.likeCount,
                hasLiked:      caw.hasLiked,
                hasRecawed:    caw.hasRecawed,
                commentCount:  caw.commentCount,
                recawCount:    caw.recawCount,
                cawonce:       caw.cawonce,
                userId:        caw.user.tokenId,
                originalCaw:   caw.originalCaw,
              }}
              isMainPost={true}
            />
          </div>
        </div>

        {/* Reply Form */}
        <div className="border-b border-white/20 mb-2">
          <PostForm
            replyTo={caw}
          />
        </div>

        {/* Comments Section */}
        <div className="space-y-0 relative">
          {/* Continuous vertical line connecting all comment avatars */}
          {comments.length > 0 && (
            <div 
              className="absolute w-px bg-white/20 z-0"
              style={{
                left: '32px', // Perfect center of comment avatars (16px padding + 20px avatar center)
                top: '20px', // Start from center of first avatar
                height: `${comments.length * 80 - 40}px` // Height for remaining avatars
              }}
            ></div>
          )}
          
          {comments.map((comm, index) => (
            <div key={comm.id} className="relative z-10">
              <ReplyItem
                item={{
                  id:           comm.id,
                  user:         comm.user,
                  content:      comm.content,
                  timestamp:    comm.timestamp,
                  likeCount:    comm.likeCount,
                  hasLiked:     comm.hasLiked,
                  hasRecawed:   comm.hasRecawed,
                  commentCount: comm.commentCount,
                  recawCount:   comm.recawCount,
                  cawonce:      comm.cawonce,
                  userId:       comm.user.tokenId,
                  originalCaw:  comm.originalCaw,
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </MainLayout>
  )
}

