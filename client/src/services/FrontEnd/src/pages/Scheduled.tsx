import React, { useState } from 'react'
import MainLayout from '~/layouts/MainLayout'
import { useTheme } from '~/hooks/useTheme'
import { useAccount } from "wagmi"
import { useConnectModal } from "@rainbow-me/rainbowkit"
import { HiOutlineClock, HiOutlineTrash, HiOutlineCheck, HiOutlineXCircle } from "react-icons/hi"
import { useActiveToken } from '~/store/tokenDataStore'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '~/api/client'
import { useAuthStore } from '~/store/authStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import { formatDistanceToNow, format, isPast } from 'date-fns'

interface ScheduledCaw {
  id: number
  userId: number
  content: string
  scheduledAt: string
  status: 'pending' | 'published' | 'failed' | 'cancelled'
  publishedId: number | null
  hasImage: boolean
  createdAt: string
  user: {
    tokenId: number
    username: string
    displayName?: string
    avatarUrl?: string
  }
}

const ScheduledPage: React.FC = () => {
  const { isDark } = useTheme()
  const [activeTab, setActiveTab] = useState<'pending' | 'published' | 'failed'>('pending')
  const { isConnected } = useAccount()
  const { openConnectModal } = useConnectModal()
  const activeToken = useActiveToken()
  const queryClient = useQueryClient()
  const authorizedTokenIds = useAuthStore(s => s.authorizedTokenIds)
  const { verify, isVerifying, error: verifyError } = useVerifyWallet()
  const isAuthorized = activeToken?.tokenId !== undefined && authorizedTokenIds.includes(activeToken.tokenId)

  const { data: scheduledData, isLoading } = useQuery({
    queryKey: ['scheduled', activeToken?.tokenId, activeTab],
    queryFn: async () => {
      if (!activeToken?.tokenId) return { items: [] }
      const response = await apiFetch(`/api/scheduled?status=${activeTab}`, {
        headers: { 'x-user-id': activeToken.tokenId.toString() }
      })
      return response as { items: ScheduledCaw[], nextCursor?: number }
    },
    enabled: !!activeToken?.tokenId,
    refetchInterval: 30000, // Refresh every 30 seconds
  })

  const cancelMutation = useMutation({
    mutationFn: async (id: number) => {
      await apiFetch(`/api/scheduled/${id}`, {
        method: 'DELETE',
        headers: { 'x-user-id': activeToken!.tokenId.toString() }
      })
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['scheduled'] })
    }
  })

  const tabs = [
    { id: 'pending' as const, label: 'Scheduled', count: 0 },
    { id: 'published' as const, label: 'Published', count: 0 },
    { id: 'failed' as const, label: 'Failed', count: 0 },
  ]

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'pending':
        return <HiOutlineClock className="w-4 h-4 text-yellow-500" />
      case 'published':
        return <HiOutlineCheck className="w-4 h-4 text-green-500" />
      case 'failed':
        return <HiOutlineXCircle className="w-4 h-4 text-red-500" />
      default:
        return null
    }
  }

  const getStatusText = (item: ScheduledCaw) => {
    const scheduledDate = new Date(item.scheduledAt)

    switch (item.status) {
      case 'pending':
        if (isPast(scheduledDate)) {
          return 'Processing...'
        }
        return `Scheduled for ${format(scheduledDate, 'MMM d, yyyy h:mm a')}`
      case 'published':
        return `Published ${formatDistanceToNow(scheduledDate, { addSuffix: true })}`
      case 'failed':
        return 'Failed to publish'
      case 'cancelled':
        return 'Cancelled'
      default:
        return ''
    }
  }

  if (!isConnected) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className={`text-center py-16 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <HiOutlineClock className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h2 className={`text-xl font-semibold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
              Connect your wallet
            </h2>
            <p className="mb-4">Connect your wallet to view your scheduled posts.</p>
            <button
              onClick={openConnectModal}
              className="px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-medium rounded-full transition-colors"
            >
              Connect Wallet
            </button>
          </div>
        </div>
      </MainLayout>
    )
  }

  if (!isAuthorized) {
    return (
      <MainLayout>
        <div className="max-w-2xl mx-auto px-6 py-4">
          <div className={`text-center py-16 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <HiOutlineClock className="w-16 h-16 mx-auto mb-4 opacity-50" />
            <h2 className={`text-xl font-semibold mb-2 ${isDark ? 'text-white' : 'text-black'}`}>
              Verify your address
            </h2>
            <p className="mb-4">You must verify your address to view scheduled posts.</p>
            {verifyError && (
              <p className="mb-4 text-red-500 text-sm">{verifyError}</p>
            )}
            <button
              onClick={verify}
              disabled={isVerifying}
              className={`px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-medium rounded-full transition-colors cursor-pointer ${
                isVerifying ? 'opacity-50 cursor-not-allowed' : ''
              }`}
            >
              {isVerifying ? 'Signing...' : 'Verify Address'}
            </button>
          </div>
        </div>
      </MainLayout>
    )
  }

  return (
    <MainLayout>
      <div className="max-w-2xl mx-auto px-6 py-4">
        {/* Page Header */}
        <div className="mb-6">
          <h1 className={`text-2xl font-bold transition-colors duration-300 ${
            isDark ? 'text-white' : 'text-black'
          }`}>
            Scheduled Posts
          </h1>
          <p className={`mt-1 text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            Manage your scheduled and past posts
          </p>
        </div>

        {/* Tabs */}
        <div className={`flex border-b mb-4 ${isDark ? 'border-white/10' : 'border-gray-200'}`}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-3 font-medium text-sm transition-colors relative ${
                activeTab === tab.id
                  ? isDark ? 'text-white' : 'text-black'
                  : isDark ? 'text-gray-400 hover:text-gray-200' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
              {activeTab === tab.id && (
                <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-yellow-500" />
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        {isLoading ? (
          <div className={`text-center py-8 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            Loading...
          </div>
        ) : !scheduledData?.items?.length ? (
          <div className={`text-center py-16 ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
            <HiOutlineClock className="w-12 h-12 mx-auto mb-4 opacity-50" />
            <p>
              {activeTab === 'pending' && "No scheduled posts yet. Schedule a post to see it here."}
              {activeTab === 'published' && "No published scheduled posts."}
              {activeTab === 'failed' && "No failed posts."}
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {scheduledData.items.map((item) => (
              <div
                key={item.id}
                className={`p-4 rounded-xl border transition-colors ${
                  isDark
                    ? 'bg-white/5 border-white/10 hover:bg-white/10'
                    : 'bg-white border-gray-200 hover:bg-gray-50'
                }`}
              >
                {/* Post Content */}
                <div className={`mb-3 ${isDark ? 'text-white' : 'text-black'}`}>
                  <p className="whitespace-pre-wrap break-words">{item.content}</p>
                  {item.hasImage && (
                    <span className={`inline-block mt-2 text-xs px-2 py-1 rounded ${
                      isDark ? 'bg-white/10 text-gray-400' : 'bg-gray-100 text-gray-600'
                    }`}>
                      Has image attachment
                    </span>
                  )}
                </div>

                {/* Status & Actions */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    {getStatusIcon(item.status)}
                    <span className={`text-sm ${isDark ? 'text-gray-400' : 'text-gray-600'}`}>
                      {getStatusText(item)}
                    </span>
                  </div>

                  {item.status === 'pending' && (
                    <button
                      onClick={() => cancelMutation.mutate(item.id)}
                      disabled={cancelMutation.isPending}
                      className={`flex items-center gap-1 px-3 py-1.5 rounded-full text-sm transition-colors ${
                        isDark
                          ? 'text-red-400 hover:bg-red-500/20'
                          : 'text-red-600 hover:bg-red-50'
                      } ${cancelMutation.isPending ? 'opacity-50 cursor-not-allowed' : ''}`}
                    >
                      <HiOutlineTrash className="w-4 h-4" />
                      Cancel
                    </button>
                  )}

                  {item.status === 'published' && item.publishedId && (
                    <a
                      href={`/caws/${item.publishedId}`}
                      className={`text-sm px-3 py-1.5 rounded-full transition-colors ${
                        isDark
                          ? 'text-yellow-400 hover:bg-yellow-500/20'
                          : 'text-yellow-600 hover:bg-yellow-50'
                      }`}
                    >
                      View Post
                    </a>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </MainLayout>
  )
}

export default ScheduledPage
