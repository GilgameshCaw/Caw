import { useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { generateToken } from '~/api/auth'

const SOCKET_URL = import.meta.env.VITE_API_HOST || 'http://localhost:4000'

interface UseDmWebSocketParams {
  userId?: number
  username?: string
  enabled?: boolean
  onNewMessage?: (message: any) => void
}

export function useDmWebSocket({ userId, username, enabled = true, onNewMessage }: UseDmWebSocketParams) {
  const socketRef = useRef<Socket | null>(null)
  const queryClient = useQueryClient()
  const onNewMessageRef = useRef(onNewMessage)
  onNewMessageRef.current = onNewMessage

  const connect = useCallback(() => {
    if (!userId || !username || !enabled) return

    const token = generateToken({ userId, username })

    socketRef.current = io(SOCKET_URL, {
      path: '/dm-ws/',
      auth: { token },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 5,
      reconnectionDelay: 1000
    })

    const socket = socketRef.current

    socket.on('connect', () => {
      console.log('[DM-WS] Connected')
    })

    socket.on('disconnect', () => {
      console.log('[DM-WS] Disconnected')
    })

    socket.on('connect_error', (error) => {
      console.error('[DM-WS] Connection error:', error.message)
    })

    socket.on('new-message', (message) => {
      onNewMessageRef.current?.(message)
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    socket.on('conversation-update', () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    socket.on('new-conversation', () => {
      queryClient.invalidateQueries({ queryKey: ['conversations', userId] })
    })

    socket.on('message-read', (data) => {
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

    socket.on('user-typing', (data) => {
      queryClient.setQueryData(
        ['typing', data.conversationId],
        data.isTyping ? data.userId : null
      )
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
    socketRef.current?.emit('join-conversation', conversationId)
  }, [])

  const leaveConversation = useCallback((conversationId: string) => {
    socketRef.current?.emit('leave-conversation', conversationId)
  }, [])

  const sendTyping = useCallback((conversationId: string, isTyping: boolean) => {
    socketRef.current?.emit('typing', { conversationId, isTyping })
  }, [])

  const markMessagesRead = useCallback((messageIds: string[]) => {
    socketRef.current?.emit('mark-read', { messageIds })
  }, [])

  useEffect(() => {
    connect()
    return () => { disconnect() }
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
