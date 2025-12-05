import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { apiFetch } from '~/api/client'
import { useTheme } from '~/hooks/useTheme'
import { useActiveToken } from '~/store/tokenDataStore'
import {
  HiHeart,
  HiUserAdd,
  HiReply,
  HiRefresh,
  HiAtSymbol,
  HiBell,
  HiCheck
} from 'react-icons/hi'

interface Actor {
  tokenId: number
  username: string
  displayName?: string
  avatarUrl?: string
}

interface Notification {
  id: number
  type: 'FOLLOW' | 'LIKE' | 'REPLY' | 'REPOST' | 'QUOTE' | 'MENTION'
  actor: Actor
  additionalActors?: Actor[]
  caw?: {
    id: number
    content: string
    createdAt: string
  }
  isRead: boolean
  createdAt: string
  count?: number
  notificationIds: number[]
}

interface NotificationsResponse {
  notifications: Notification[]
  unreadCount: number
  hasMore: boolean
}

type TabType = 'all' | 'mentions'

// Helper function to format relative time
function formatRelativeTime(timestamp: string): string {
  const now = new Date()
  const time = new Date(timestamp)
  const diffInMs = now.getTime() - time.getTime()
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60))
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60))
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24))

  if (diffInMinutes < 1) {
    return 'now'
  } else if (diffInMinutes < 60) {
    return `${diffInMinutes}m`
  } else if (diffInHours < 24) {
    return `${diffInHours}h`
  } else if (diffInDays < 7) {
    return `${diffInDays}d`
  } else {
    return time.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }
}

const Notifications: React.FC = () => {
  const navigate = useNavigate()
  const { isDark } = useTheme()
  const activeToken = useActiveToken()
  const [activeTab, setActiveTab] = useState<TabType>('all')
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [unreadCount, setUnreadCount] = useState(0)
  const [hasMore, setHasMore] = useState(false)
  const [offset, setOffset] = useState(0)

  const fetchNotifications = useCallback(async (reset = false) => {
    if (!activeToken) return

    try {
      setLoading(true)
      setError(null)

      const currentOffset = reset ? 0 : offset
      const type = activeTab === 'mentions' ? 'mentions' : 'all'

      const data = await apiFetch<NotificationsResponse>(
        `/api/notifications?userId=${activeToken.tokenId}&type=${type}&limit=50&offset=${currentOffset}`
      )

      if (reset) {
        setNotifications(data.notifications)
      } else {
        setNotifications(prev => [...prev, ...data.notifications])
      }

      setUnreadCount(data.unreadCount)
      setHasMore(data.hasMore)
      setOffset(currentOffset + data.notifications.length)

      // Mark notifications as read after displaying them
      if (data.notifications.length > 0) {
        const unreadIds = data.notifications
          .filter(n => !n.isRead)
          .flatMap(n => n.notificationIds)

        if (unreadIds.length > 0) {
          await markAsRead(unreadIds)
        }
      }
    } catch (err) {
      console.error('Failed to fetch notifications:', err)
      setError('Failed to load notifications')
    } finally {
      setLoading(false)
    }
  }, [activeToken, activeTab, offset])

  const markAsRead = async (notificationIds?: number[]) => {
    if (!activeToken) return

    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({
          userId: activeToken.tokenId,
          notificationIds
        })
      })
    } catch (err) {
      console.error('Failed to mark notifications as read:', err)
    }
  }

  const markAllAsRead = async () => {
    if (!activeToken) return

    try {
      await apiFetch('/api/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ userId: activeToken.tokenId })
      })

      // Update UI to reflect all notifications as read
      setNotifications(prev => prev.map(n => ({ ...n, isRead: true })))
      setUnreadCount(0)
    } catch (err) {
      console.error('Failed to mark all as read:', err)
    }
  }

  const deleteNotification = async (notificationId: number) => {
    if (!activeToken) return

    try {
      await apiFetch(`/api/notifications/${notificationId}?userId=${activeToken.tokenId}`, {
        method: 'DELETE'
      })

      // Remove from UI
      setNotifications(prev => prev.filter(n => n.id !== notificationId))
    } catch (err) {
      console.error('Failed to delete notification:', err)
    }
  }

  const getNotificationIcon = (type: Notification['type']) => {
    switch (type) {
      case 'FOLLOW':
        return <HiUserAdd className="w-5 h-5 text-blue-500" />
      case 'LIKE':
        return <HiHeart className="w-5 h-5 text-red-500" />
      case 'REPLY':
        return <HiReply className="w-5 h-5 text-green-500" />
      case 'REPOST':
        return <HiRefresh className="w-5 h-5 text-purple-500" />
      case 'QUOTE':
        return <HiReply className="w-5 h-5 text-indigo-500" />
      case 'MENTION':
        return <HiAtSymbol className="w-5 h-5 text-orange-500" />
      default:
        return <HiBell className="w-5 h-5 text-gray-500" />
    }
  }

  const getNotificationText = (notification: Notification) => {
    const { type, actor, additionalActors, count = 1 } = notification

    let text = ''

    if (count > 1 && additionalActors && additionalActors.length > 0) {
      // Grouped notification
      const othersCount = count - 1
      text = `${actor.displayName || actor.username} and ${othersCount} other${othersCount > 1 ? 's' : ''}`
    } else {
      // Single notification
      text = actor.displayName || actor.username
    }

    switch (type) {
      case 'FOLLOW':
        return `${text} followed you`
      case 'LIKE':
        return `${text} liked your caw`
      case 'REPLY':
        return `${text} replied to your caw`
      case 'REPOST':
        return `${text} recawed your caw`
      case 'QUOTE':
        return `${text} quoted your caw`
      case 'MENTION':
        return `${text} mentioned you`
      default:
        return text
    }
  }

  const handleNotificationClick = (notification: Notification) => {
    if (notification.type === 'FOLLOW') {
      navigate(`/users/${notification.actor.username}`)
    } else if (notification.caw) {
      navigate(`/caws/${notification.caw.id}`)
    }
  }

  useEffect(() => {
    setOffset(0)
    fetchNotifications(true)
  }, [activeTab])

  useEffect(() => {
    // Set up polling for new notifications
    const interval = setInterval(() => {
      if (activeToken) {
        apiFetch<{ unreadCount: number }>(
          `/api/notifications/unread-count?userId=${activeToken.tokenId}`
        ).then(data => {
          if (data.unreadCount > unreadCount) {
            // New notifications available, refresh
            fetchNotifications(true)
          }
        }).catch(console.error)
      }
    }, 30000) // Poll every 30 seconds

    return () => clearInterval(interval)
  }, [activeToken, unreadCount])

  if (!activeToken) {
    return (
      <div className="max-w-2xl mx-auto px-6 py-8 text-center">
        <p className={isDark ? 'text-white/60' : 'text-gray-600'}>
          Please sign in to view notifications
        </p>
      </div>
    )
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h1 className={`text-2xl font-bold ${isDark ? 'text-white' : 'text-gray-900'}`}>
          Notifications
        </h1>
        {unreadCount > 0 && (
          <button
            onClick={markAllAsRead}
            className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg transition ${
              isDark
                ? 'bg-white/10 hover:bg-white/20 text-white'
                : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
            }`}
          >
            <HiCheck className="w-4 h-4" />
            <span className="text-sm">Mark all read</span>
          </button>
        )}
      </div>

      {/* Tabs */}
      <div className={`flex space-x-1 mb-6 border-b ${isDark ? 'border-white/20' : 'border-gray-200'}`}>
        <button
          onClick={() => setActiveTab('all')}
          className={`px-4 py-3 transition-all ${
            activeTab === 'all'
              ? isDark
                ? 'border-b-2 border-blue-500 text-white'
                : 'border-b-2 border-blue-500 text-gray-900'
              : isDark
                ? 'text-white/60 hover:text-white'
                : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          All
          {unreadCount > 0 && activeTab !== 'all' && (
            <span className="ml-2 px-2 py-0.5 text-xs rounded-full bg-red-500 text-white">
              {unreadCount}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab('mentions')}
          className={`px-4 py-3 transition-all flex items-center space-x-2 ${
            activeTab === 'mentions'
              ? isDark
                ? 'border-b-2 border-blue-500 text-white'
                : 'border-b-2 border-blue-500 text-gray-900'
              : isDark
                ? 'text-white/60 hover:text-white'
                : 'text-gray-600 hover:text-gray-900'
          }`}
        >
          <HiAtSymbol className="w-4 h-4" />
          <span>Mentions</span>
        </button>
      </div>

      {/* Notifications List */}
      {loading && notifications.length === 0 ? (
        <div className="space-y-4">
          {[...Array(5)].map((_, i) => (
            <div
              key={i}
              className={`animate-pulse h-20 rounded-lg ${
                isDark ? 'bg-white/10' : 'bg-gray-100'
              }`}
            />
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-8">
          <p className="text-red-500">{error}</p>
        </div>
      ) : notifications.length === 0 ? (
        <div className="text-center py-12">
          <HiBell className={`w-12 h-12 mx-auto mb-4 ${
            isDark ? 'text-white/20' : 'text-gray-300'
          }`} />
          <p className={isDark ? 'text-white/60' : 'text-gray-600'}>
            {activeTab === 'mentions'
              ? 'No mentions yet'
              : 'No notifications yet'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {notifications.map(notification => (
            <div
              key={notification.id}
              className={`p-4 rounded-lg transition cursor-pointer ${
                !notification.isRead
                  ? isDark
                    ? 'bg-blue-500/10 hover:bg-blue-500/20'
                    : 'bg-blue-50 hover:bg-blue-100'
                  : isDark
                    ? 'bg-white/5 hover:bg-white/10'
                    : 'bg-gray-50 hover:bg-gray-100'
              }`}
              onClick={() => handleNotificationClick(notification)}
            >
              <div className="flex items-start space-x-3">
                <div className="mt-1">
                  {getNotificationIcon(notification.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className={`text-sm ${isDark ? 'text-white' : 'text-gray-900'}`}>
                    <span className="font-semibold">
                      {getNotificationText(notification)}
                    </span>
                  </p>
                  {notification.caw && (
                    <p className={`text-sm mt-1 truncate ${
                      isDark ? 'text-white/60' : 'text-gray-600'
                    }`}>
                      {notification.caw.content}
                    </p>
                  )}
                  <p className={`text-xs mt-1 ${
                    isDark ? 'text-white/40' : 'text-gray-500'
                  }`}>
                    {formatRelativeTime(notification.createdAt)}
                  </p>
                </div>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteNotification(notification.id)
                  }}
                  className={`p-1 rounded transition ${
                    isDark
                      ? 'hover:bg-white/10 text-white/40 hover:text-white'
                      : 'hover:bg-gray-200 text-gray-400 hover:text-gray-600'
                  }`}
                >
                  ×
                </button>
              </div>
            </div>
          ))}

          {hasMore && (
            <button
              onClick={() => fetchNotifications()}
              className={`w-full py-3 text-center rounded-lg transition ${
                isDark
                  ? 'bg-white/10 hover:bg-white/20 text-white'
                  : 'bg-gray-100 hover:bg-gray-200 text-gray-900'
              }`}
              disabled={loading}
            >
              {loading ? 'Loading...' : 'Load more'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default Notifications