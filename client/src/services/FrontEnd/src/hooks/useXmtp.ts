import { useState, useEffect, useCallback } from 'react'
import { useAccount } from 'wagmi'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

const API_BASE = import.meta.env.VITE_API_BASE_URL || 'http://localhost:4000/api'

interface XmtpIdentity {
  userId: number
  walletAddress: string
  installationId: string
  registrationId: number
}

interface Conversation {
  id: string
  type: 'DM' | 'GROUP'
  topic: string
  name?: string
  description?: string
  lastMessageAt?: string
  unreadCount: number
  participants: Array<{
    userId: number
    identity: {
      user: {
        username: string
        image?: string
      }
    }
  }>
}

interface Message {
  id: string
  conversationId: string
  senderId: number
  content: string
  contentType: string
  createdAt: string
  editedAt?: string
  deletedAt?: string
  sender: {
    user: {
      username: string
      image?: string
    }
  }
}

export function useXmtpIdentity(userId?: number) {
  const { address } = useAccount()
  const queryClient = useQueryClient()

  const { data: identity, isLoading } = useQuery<XmtpIdentity | null>({
    queryKey: ['xmtp-identity', userId],
    queryFn: async () => {
      if (!userId) return null
      const response = await fetch(`${API_BASE}/xmtp/identity/${userId}`)
      if (!response.ok) {
        if (response.status === 404) return null
        throw new Error('Failed to fetch XMTP identity')
      }
      const data = await response.json()
      return data.identity
    },
    enabled: !!userId
  })

  const registerIdentity = useMutation({
    mutationFn: async ({ tokenId }: { tokenId: number }) => {
      if (!address) throw new Error('Wallet not connected')

      const response = await fetch(`${API_BASE}/xmtp/identity/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokenId, walletAddress: address })
      })

      if (!response.ok) throw new Error('Failed to register XMTP identity')
      return response.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['xmtp-identity'] })
    }
  })

  return {
    identity,
    isLoading,
    registerIdentity: registerIdentity.mutate,
    isRegistering: registerIdentity.isPending
  }
}

export function useConversations(userId?: number) {
  const { data: conversations = [], isLoading } = useQuery<Conversation[]>({
    queryKey: ['conversations', userId],
    queryFn: async () => {
      if (!userId) return []
      const response = await fetch(`${API_BASE}/xmtp/conversations?userId=${userId}`)
      if (!response.ok) throw new Error('Failed to fetch conversations')
      const data = await response.json()
      return data.conversations
    },
    enabled: !!userId,
    refetchInterval: 10000 // Poll every 10 seconds for new messages
  })

  return { conversations, isLoading }
}

export function useMessages(conversationId: string, userId?: number) {
  const queryClient = useQueryClient()

  const { data: messages = [], isLoading, refetch } = useQuery<Message[]>({
    queryKey: ['messages', conversationId, userId],
    queryFn: async () => {
      if (!userId) return []
      const response = await fetch(
        `${API_BASE}/xmtp/conversations/${conversationId}/messages?userId=${userId}`
      )
      if (!response.ok) throw new Error('Failed to fetch messages')
      const data = await response.json()
      return data.messages
    },
    enabled: !!userId && !!conversationId,
    refetchInterval: 5000 // Poll every 5 seconds for new messages
  })

  const sendMessage = useMutation({
    mutationFn: async ({ content, contentType = 'text' }: { content: string; contentType?: string }) => {
      if (!userId) throw new Error('User not authenticated')

      const response = await fetch(`${API_BASE}/xmtp/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId,
          senderId: userId,
          content,
          contentType
        })
      })

      if (!response.ok) throw new Error('Failed to send message')
      return response.json()
    },
    onSuccess: () => {
      // Refetch messages and conversations
      queryClient.invalidateQueries({ queryKey: ['messages', conversationId] })
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    }
  })

  const markAsRead = useCallback(async (messageIds: string[]) => {
    if (!userId) return

    await fetch(`${API_BASE}/xmtp/messages/read`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds, userId })
    })

    queryClient.invalidateQueries({ queryKey: ['conversations'] })
  }, [userId, queryClient])

  return {
    messages,
    isLoading,
    sendMessage: sendMessage.mutate,
    isSending: sendMessage.isPending,
    markAsRead,
    refetch
  }
}

export function useCreateConversation() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      creatorId,
      participantIds,
      type = 'DM' as 'DM' | 'GROUP',
      name,
      description
    }: {
      creatorId: number
      participantIds: number[]
      type?: 'DM' | 'GROUP'
      name?: string
      description?: string
    }) => {
      const response = await fetch(`${API_BASE}/xmtp/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          creatorId,
          participantIds,
          type,
          name,
          description
        })
      })

      if (!response.ok) throw new Error('Failed to create conversation')
      return response.json()
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['conversations'] })
    }
  })
}

export function useCanMessage(walletAddress?: string, userId?: number) {
  const { data: canMessage, isLoading } = useQuery({
    queryKey: ['can-message', walletAddress, userId],
    queryFn: async () => {
      if (!walletAddress || !userId) return false

      const response = await fetch(
        `${API_BASE}/xmtp/can-message/${walletAddress}?userId=${userId}`
      )

      if (!response.ok) return false
      const data = await response.json()
      return data.canMessage
    },
    enabled: !!walletAddress && !!userId
  })

  return { canMessage, isLoading }
}