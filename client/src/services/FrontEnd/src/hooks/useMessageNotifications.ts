import { useEffect, useRef } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { io, Socket } from 'socket.io-client'
import { generateToken } from '~/api/auth'

const SOCKET_URL = import.meta.env.VITE_API_HOST || 'http://localhost:4000'

interface Message {
  id: string
  content: string
  senderId: number
  conversationId: string
  createdAt: string
  sender?: {
    user: {
      username: string
      image?: string
    }
  }
}

interface UseMessageNotificationsParams {
  userId?: number
  username?: string
  enabled?: boolean
  onNewMessage?: (message: Message) => void
}

export function useMessageNotifications({
  userId,
  username,
  enabled = true,
  onNewMessage
}: UseMessageNotificationsParams) {
  const socketRef = useRef<Socket | null>(null)
  const queryClient = useQueryClient()
  const notificationPermissionRef = useRef<NotificationPermission>('default')

  // Request notification permission
  useEffect(() => {
    if (!enabled || !('Notification' in window)) return

    if (Notification.permission === 'default') {
      Notification.requestPermission().then(permission => {
        notificationPermissionRef.current = permission
      })
    } else {
      notificationPermissionRef.current = Notification.permission
    }
  }, [enabled])

  // Show browser notification
  const showNotification = (message: Message) => {
    if (notificationPermissionRef.current !== 'granted') return
    if (document.hasFocus()) return // Don't show if user is on the page

    const title = message.sender?.user.username || 'New Message'
    const body = message.content.length > 100
      ? message.content.substring(0, 100) + '...'
      : message.content

    const notification = new Notification(title, {
      body,
      icon: message.sender?.user.image || '/logo.png',
      tag: message.id, // Prevent duplicate notifications
      requireInteraction: false
    })

    // Handle click on notification
    notification.onclick = () => {
      window.focus()
      // Navigate to the message
      window.location.href = `/messages?conversation=${message.conversationId}`
      notification.close()
    }

    // Auto close after 5 seconds
    setTimeout(() => notification.close(), 5000)
  }

  // Play notification sound
  const playNotificationSound = () => {
    try {
      const audio = new Audio('/sounds/message-notification.mp3')
      audio.volume = 0.3
      audio.play().catch(console.error)
    } catch (error) {
      console.error('Failed to play notification sound:', error)
    }
  }

  useEffect(() => {
    if (!userId || !username || !enabled) {
      console.log('[MessageNotifications] Skipping WebSocket connection:', { userId, username, enabled })
      return
    }

    console.log('[MessageNotifications] Connecting WebSocket for user:', username, userId)

    // Generate auth token for WebSocket
    const token = generateToken({ userId, username })

    // Connect to WebSocket for real-time notifications
    socketRef.current = io(SOCKET_URL, {
      path: '/xmtp-ws/',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    })

    const socket = socketRef.current

    console.log('[MessageNotifications] WebSocket instance created')

    // Listen for new messages
    socket.on('new-message', (message: Message) => {
      // Don't notify for own messages
      if (message.senderId === userId) return

      console.log('[Notification] New message received:', message)

      // Show browser notification
      showNotification(message)

      // Play sound
      playNotificationSound()

      // Call custom handler
      onNewMessage?.(message)

      // Update unread count in UI
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    // Listen for typing indicators
    socket.on('user-typing', (data: { conversationId: string, userId: number, isTyping: boolean }) => {
      if (data.userId === userId) return

      // Update typing state in UI
      queryClient.setQueryData(
        ['typing', data.conversationId],
        data.isTyping ? data.userId : null
      )
    })

    return () => {
      console.log('[MessageNotifications] Cleanup: Disconnecting WebSocket')
      socket.disconnect()
    }
    // Intentionally omit onNewMessage from dependencies to avoid reconnection loops
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, username, enabled, queryClient])

  // Check if notifications are enabled
  const areNotificationsEnabled = () => {
    return notificationPermissionRef.current === 'granted'
  }

  // Request permission manually
  const requestPermission = async () => {
    if (!('Notification' in window)) {
      console.warn('Browser does not support notifications')
      return false
    }

    const permission = await Notification.requestPermission()
    notificationPermissionRef.current = permission
    return permission === 'granted'
  }

  return {
    areNotificationsEnabled,
    requestPermission,
    isConnected: socketRef.current?.connected || false
  }
}

// Hook to get typing status for a conversation
export function useTypingStatus(conversationId: string) {
  const queryClient = useQueryClient()

  const typingUserId = queryClient.getQueryData<number | null>(['typing', conversationId])

  return {
    isTyping: !!typingUserId,
    typingUserId
  }
}