import { useEffect, useRef, useCallback } from 'react'
import { io, Socket } from 'socket.io-client'
import { useQueryClient } from '@tanstack/react-query'
import { useAuthStore } from '~/store/authStore'
import { useInstanceStore } from '~/store/instanceStore'
import { API_HOST } from '~/api/client'

// Resolve at connect time so we pick up the registered API host even if the
// page is served from a separate FE-only node (origin would be the FE host,
// not the API). Single-host: socket connections aren't failover-able anyway
// (the server tracks per-socket session state), so we want the same host
// apiFetch is talking to. Falls back to window.origin if neither is set.
function resolveSocketUrl(): string {
  const active = useInstanceStore.getState().activeApiHost
  if (active) return active
  if (API_HOST) return API_HOST
  return typeof window !== 'undefined' ? window.location.origin : ''
}

export type DmReactionEvent = {
  messageId: string
  userId: number
  emoji: string
  added: boolean
  id?: number
}

interface UseDmWebSocketParams {
  userId?: number
  username?: string
  enabled?: boolean
  onNewMessage?: (message: any) => void
  onReaction?: (event: DmReactionEvent) => void
  /** Group-chat lifecycle events. Each kind triggers a refresh of the
   *  active conversation participants/metadata in the inbox store. */
  onGroupEvent?: (event: { conversationId: string; kind: string; payload?: any }) => void
}

export function useDmWebSocket({ userId, username, enabled = true, onNewMessage, onReaction, onGroupEvent }: UseDmWebSocketParams) {
  const socketRef = useRef<Socket | null>(null)
  const queryClient = useQueryClient()
  const onNewMessageRef = useRef(onNewMessage)
  onNewMessageRef.current = onNewMessage
  const onReactionRef = useRef(onReaction)
  onReactionRef.current = onReaction
  const onGroupEventRef = useRef(onGroupEvent)
  onGroupEventRef.current = onGroupEvent

  const connect = useCallback(() => {
    if (!userId || !username || !enabled) return

    // Auth: the HttpOnly caw_session cookie carries the session token on
    // every same-origin connection (withCredentials: true tells Socket.IO
    // to include cookies on cross-origin handshakes too). The handshake.auth
    // payload still carries the in-memory token if any so existing browsers
    // mid-migration can still authenticate; the server accepts either path.
    // Audit fix 2026-05-14 (F1 follow-up).
    const sessionToken = useAuthStore.getState().sessionToken

    socketRef.current = io(resolveSocketUrl(), {
      path: '/dm-ws/',
      auth: { ...(sessionToken ? { sessionToken } : {}), userId, username },
      withCredentials: true,
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

    socket.on('conversation-update', (data: any) => {
      // Group lifecycle events ride this channel — kind: 'member-added' |
      // 'member-removed' | 'conversation-updated'. Handler caller is
      // responsible for refetching the active conversation; the inbox
      // refreshes via the queryClient invalidation regardless.
      if (data?.kind) {
        onGroupEventRef.current?.({ conversationId: data.conversationId || '', kind: data.kind, payload: data })
      }
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

    // Reaction add/remove from any participant in a conversation room
    // we've joined. Forwarded to the message-list hook via onReaction.
    socket.on('reaction-added', (data: { messageId: string; userId: number; emoji: string; id?: number }) => {
      onReactionRef.current?.({ ...data, added: true })
    })
    socket.on('reaction-removed', (data: { messageId: string; userId: number; emoji: string }) => {
      onReactionRef.current?.({ ...data, added: false })
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
