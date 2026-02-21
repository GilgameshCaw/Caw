import { useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { generateToken } from '~/api/auth'

const SOCKET_URL = import.meta.env.VITE_API_HOST || 'http://localhost:4000'

interface UseXmtpWebSocketParams {
  userId?: number
  username?: string
  enabled?: boolean
}

export function useXmtpWebSocket({ userId, username, enabled = true }: UseXmtpWebSocketParams) {
  const socketRef = useRef<Socket | null>(null)
  const queryClient = useQueryClient()

  const connect = useCallback(() => {
    if (!userId || !username || !enabled) return

    // Generate auth token for WebSocket
    const token = generateToken({ userId, username })

    console.log('[XMTP-WS Client] Connecting to:', SOCKET_URL, 'with path: /xmtp-ws/')
    console.log('[XMTP-WS Client] Token:', token)

    socketRef.current = io(SOCKET_URL, {
      path: '/xmtp-ws/',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    })

    console.log('[XMTP-WS Client] Socket.IO instance created')

    const socket = socketRef.current

    // Connection events
    socket.on('connect', () => {
      console.log('[XMTP-WS] Connected to WebSocket server')
    })

    socket.on('disconnect', () => {
      console.log('[XMTP-WS] Disconnected from WebSocket server')
    })

    socket.on('connect_error', (error) => {
      console.error('[XMTP-WS] Connection error:', error.message)
    })

    // Message events
    socket.on('new-message', (message) => {
      console.log('[XMTP-WS] New message received:', message)

      // Update messages query cache
      queryClient.setQueryData(
        ['messages', message.conversationId, userId],
        (oldData: any) => {
          if (!oldData) return [message]
          return [...oldData, message]
        }
      )

      // Update conversations list
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    // Conversation events
    socket.on('conversation-update', (update) => {
      console.log('[XMTP-WS] Conversation updated:', update)
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    socket.on('new-conversation', (conversation) => {
      console.log('[XMTP-WS] New conversation created:', conversation)
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    // Read receipt events
    socket.on('message-read', (data) => {
      console.log('[XMTP-WS] Message read:', data)

      // Update message status in cache
      queryClient.setQueryData(
        ['messages', data.conversationId, userId],
        (oldData: any) => {
          if (!oldData) return oldData
          return oldData.map((msg: any) =>
            data.messageIds.includes(msg.id)
              ? { ...msg, status: 'READ' }
              : msg
          )
        }
      )
    })

    // Typing indicator events
    socket.on('user-typing', (data) => {
      console.log('[XMTP-WS] User typing:', data)

      // Could store typing state in a separate store or context
      // For now, just log it
    })

    return socket
  }, [userId, username, enabled, queryClient])

  const disconnect = useCallback(() => {
    if (socketRef.current) {
      socketRef.current.disconnect()
      socketRef.current = null
    }
  }, [])

  const joinConversation = useCallback((conversationId: string) => {
    if (socketRef.current) {
      socketRef.current.emit('join-conversation', conversationId)
    }
  }, [])

  const leaveConversation = useCallback((conversationId: string) => {
    if (socketRef.current) {
      socketRef.current.emit('leave-conversation', conversationId)
    }
  }, [])

  const sendTyping = useCallback((conversationId: string, isTyping: boolean) => {
    if (socketRef.current) {
      socketRef.current.emit('typing', { conversationId, isTyping })
    }
  }, [])

  const markMessagesRead = useCallback((messageIds: string[]) => {
    if (socketRef.current) {
      socketRef.current.emit('mark-read', { messageIds })
    }
  }, [])

  useEffect(() => {
    const socket = connect()

    return () => {
      disconnect()
    }
  }, [connect, disconnect])

  return {
    isConnected: socketRef.current?.connected || false,
    socket: socketRef.current,
    joinConversation,
    leaveConversation,
    sendTyping,
    markMessagesRead
  }
}