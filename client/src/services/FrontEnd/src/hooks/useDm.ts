import { useCallback, useEffect, useRef, useState } from 'react'
import { useWalletClient } from 'wagmi'
import { apiFetch, API_HOST } from '~/api/client'
import { useAuthStore } from '~/store/authStore'
import { useVerifyWallet } from '~/hooks/useVerifyWallet'
import {
  deriveKeyPair,
  computeSharedSecret,
  encrypt,
  decrypt,
  hasCachedKeyPair,
  getCachedPrivateKey,
  clearKeyCache
} from '~/services/DmCryptoService'

type UiConversation = {
  id: string
  type: 'DM'
  participants: Array<{
    userId: number
    identity: {
      user: {
        username: string
        displayName?: string
        image?: string
        address?: string
        tokenId: number
      }
    }
  }>
  lastMessageAt?: string
  lastMessagePreview?: string // decrypted preview of last message
  lastMessageSenderId?: number
  unreadCount: number
}

type UiMessage = {
  id: string
  content: string
  senderId: number
  createdAt: string
  status: string
  conversationId: string
  isFromCurrentUser: boolean
  sender?: {
    user: {
      username: string
      displayName?: string
      avatarUrl?: string
      tokenId: number
    }
  }
}

// Module-level private key reference (never in state to avoid serialization)
let privateKeyRef: Uint8Array | null = null

export function useDmClient(tokenId?: number) {
  const { data: walletClient } = useWalletClient()
  const { verify } = useVerifyWallet()

  const [isInitialized, setIsInitialized] = useState(false)
  const [needsKeyDerivation, setNeedsKeyDerivation] = useState(false) // identity exists but keys not in memory
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<Error | null>(null)
  const [conversations, setConversations] = useState<UiConversation[]>([])
  const checkedTokenIdRef = useRef<number | undefined>(undefined) // tracks which tokenId the current state belongs to

  // Check if already initialized on mount or when tokenId changes
  useEffect(() => {
    // Reset state for new account
    checkedTokenIdRef.current = tokenId
    setIsInitialized(false)
    setNeedsKeyDerivation(false)
    setIsLoading(true)
    setConversations([])

    if (!tokenId) {
      setIsLoading(false)
      return
    }

    // Always verify server has the identity — cached keys alone aren't enough
    // (user may have derived keys but registration may have failed)
    let cancelled = false
    fetch(`${API_HOST}/api/dm/identity/${tokenId}`)
      .then(r => r.json())
      .then(data => {
        if (cancelled) return
        if (data.hasIdentity) {
          if (hasCachedKeyPair(tokenId)) {
            // Keys in cache + server identity = fully ready
            privateKeyRef = getCachedPrivateKey()
            setIsInitialized(true)
            loadConversations()
          } else {
            // Server has identity but keys not in memory — need re-derivation
            setIsInitialized(true)
            setNeedsKeyDerivation(true)
            loadConversations()
          }
        }
        // If !hasIdentity, leave isInitialized=false so setup view shows
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setIsLoading(false) })

    return () => { cancelled = true }
  }, [tokenId])

  const loadConversations = useCallback(async () => {
    if (!tokenId) return

    try {
      const data = await apiFetch<{ conversations: any[] }>(`/api/dm/conversations?userId=${tokenId}`)

      const uiConversations: UiConversation[] = await Promise.all(
        (data.conversations || []).map(async (conv: any) => {
          const otherParticipants = conv.participants.filter(
            (p: any) => p.userId !== tokenId
          )

          // Try to decrypt last message preview
          let lastMessagePreview: string | undefined
          let lastMessageSenderId: number | undefined
          if (conv.lastMessage?.encryptedPayload && privateKeyRef) {
            lastMessageSenderId = conv.lastMessage.senderId
            try {
              const sharedSecret = await getOrComputeSharedSecret(conv.id, tokenId)
              if (sharedSecret) {
                const decrypted = await decrypt(conv.lastMessage.encryptedPayload, sharedSecret)
                lastMessagePreview = decrypted.length > 80 ? decrypted.slice(0, 80) + '…' : decrypted
              }
            } catch {
              // Can't decrypt — leave as undefined
            }
          }

          return {
            id: conv.id,
            type: 'DM' as const,
            participants: otherParticipants.map((p: any) => ({
              userId: p.userId,
              identity: {
                user: {
                  username: p.identity?.user?.username || 'Unknown',
                  displayName: p.identity?.user?.displayName,
                  image: p.identity?.user?.avatarUrl,
                  address: p.identity?.user?.address,
                  tokenId: p.userId
                }
              }
            })),
            lastMessageAt: conv.lastMessageAt,
            lastMessagePreview,
            lastMessageSenderId,
            unreadCount: conv.unreadCount || 0
          }
        })
      )

      setConversations(uiConversations)
    } catch (err) {
      console.error('[DM] Failed to load conversations:', err)
    }
  }, [tokenId])

  const initializeClient = useCallback(async () => {
    console.log('[DM] initializeClient called, walletClient:', !!walletClient, 'tokenId:', tokenId)
    if (!walletClient || !tokenId) {
      const err = new Error('Wallet not connected')
      console.log('[DM] No wallet client or tokenId, throwing')
      setError(err)
      throw err
    }

    if (hasCachedKeyPair(tokenId)) {
      console.log('[DM] Keys already cached for this tokenId, skipping setup')
      setIsInitialized(true)
      await loadConversations()
      return
    }

    setIsLoading(true)
    setError(null)
    try {
      console.log('[DM] Deriving key pair...')
      const signMessage = async (message: string) => {
        console.log('[DM] Requesting wallet signature for key derivation...')
        const sig = await walletClient.signMessage({
          account: walletClient.account,
          message
        })
        return sig
      }

      const { privateKey, publicKeyHex } = await deriveKeyPair(signMessage, tokenId)
      privateKeyRef = privateKey
      console.log('[DM] Key pair derived, needsKeyDerivation:', needsKeyDerivation)

      // If identity already exists on server, just re-derive keys — no need to
      // re-register or re-verify auth (avoids logging out the other account)
      if (!needsKeyDerivation) {
        // Fresh setup — need auth and server registration
        console.log('[DM] Fresh setup — checking auth, isTokenAuthorized:', useAuthStore.getState().isTokenAuthorized(tokenId))
        if (!useAuthStore.getState().isTokenAuthorized(tokenId)) {
          try {
            console.log('[DM] Trying auth refresh...')
            const res = await apiFetch<{ authorizedTokenIds: number[], authorizedAddresses: string[] }>(
              '/api/auth/refresh', { method: 'POST' }
            )
            useAuthStore.getState().addAuthorization(res.authorizedTokenIds, res.authorizedAddresses)
            console.log('[DM] Auth refresh succeeded, isTokenAuthorized:', useAuthStore.getState().isTokenAuthorized(tokenId))
          } catch (e) {
            console.log('[DM] Auth refresh failed:', e)
          }

          if (!useAuthStore.getState().isTokenAuthorized(tokenId)) {
            console.log('[DM] Still not authorized, calling verify()...')
            await verify()
            if (!useAuthStore.getState().isTokenAuthorized(tokenId)) {
              throw new Error('Wallet verification failed — please try again')
            }
          }
        }

        // Register public key on backend
        console.log('[DM] Registering public key on backend...')
        await apiFetch('/api/dm/identity', {
          method: 'POST',
          body: JSON.stringify({
            userId: tokenId,
            walletAddress: walletClient.account.address,
            publicKey: publicKeyHex
          })
        })
        console.log('[DM] Public key registered successfully')
      }

      setIsInitialized(true)
      setNeedsKeyDerivation(false)
      await loadConversations()
      console.log('[DM] Initialization complete')
    } catch (err) {
      console.error('[DM] initializeClient error:', err)
      setError(err as Error)
      throw err
    } finally {
      setIsLoading(false)
    }
  }, [walletClient, tokenId, loadConversations])

  const startConversation = useCallback(async (peerUserId: number) => {
    if (!tokenId) throw new Error('Not initialized')

    // Check peer has DM identity
    const peerData = await apiFetch<{ publicKey: string | null; hasIdentity: boolean }>(
      `/api/dm/identity/${peerUserId}`
    )
    if (!peerData.hasIdentity) {
      throw new Error('This user has not enabled DMs yet')
    }

    // Create/get conversation
    const conversation = await apiFetch('/api/dm/conversations', {
      method: 'POST',
      body: JSON.stringify({ userId: tokenId, peerUserId })
    })

    // Compute shared secret for this conversation if we have the private key
    if (privateKeyRef && peerData.publicKey) {
      await computeSharedSecret(privateKeyRef, peerData.publicKey, conversation.id)
    }

    // Reload conversations to get updated list
    await loadConversations()

    return conversation
  }, [tokenId, loadConversations])

  const clearUnreadCount = useCallback((conversationId: string) => {
    setConversations(prev => prev.map(c =>
      c.id === conversationId ? { ...c, unreadCount: 0 } : c
    ))
  }, [])

  return {
    isInitialized,
    needsKeyDerivation: needsKeyDerivation && checkedTokenIdRef.current === tokenId,
    isLoading,
    error,
    initializeClient,
    conversations,
    startConversation,
    clearUnreadCount,
    refreshConversations: loadConversations
  }
}

export function useDmMessages(conversationId: string, tokenId?: number) {
  const [messages, setMessages] = useState<UiMessage[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSending, setIsSending] = useState(false)
  const [peerLastReadAt, setPeerLastReadAt] = useState<string | null>(null)

  // Load and decrypt messages
  useEffect(() => {
    if (!conversationId || !tokenId) return

    let cancelled = false

    const load = async () => {
      setIsLoading(true)
      try {
        const data = await apiFetch<{ messages: any[], peerLastReadAt: string | null }>(
          `/api/dm/conversations/${conversationId}/messages?userId=${tokenId}`
        )

        if (cancelled) return

        setPeerLastReadAt(data.peerLastReadAt || null)

        // Get peer's public key for this conversation
        const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId)

        if (!sharedSecret) {
          // Can't decrypt yet — show encrypted messages as-is
          setMessages(data.messages.map((msg: any) => ({
            id: msg.id,
            content: '[Encrypted]',
            senderId: msg.senderId,
            createdAt: msg.createdAt,
            status: msg.status,
            conversationId: msg.conversationId,
            isFromCurrentUser: msg.senderId === tokenId,
            sender: msg.sender ? {
              user: {
                username: msg.sender.user?.username || 'Unknown',
                displayName: msg.sender.user?.displayName,
                avatarUrl: msg.sender.user?.avatarUrl,
                tokenId: msg.senderId
              }
            } : undefined
          })))
          return
        }

        // Decrypt each message
        const decryptedMessages: UiMessage[] = []
        for (const msg of data.messages) {
          let content: string
          try {
            content = await decrypt(msg.encryptedPayload, sharedSecret)
          } catch {
            content = '[Unable to decrypt]'
          }

          decryptedMessages.push({
            id: msg.id,
            content,
            senderId: msg.senderId,
            createdAt: msg.createdAt,
            status: msg.status,
            conversationId: msg.conversationId,
            isFromCurrentUser: msg.senderId === tokenId,
            sender: msg.sender ? {
              user: {
                username: msg.sender.user?.username || 'Unknown',
                displayName: msg.sender.user?.displayName,
                avatarUrl: msg.sender.user?.avatarUrl,
                tokenId: msg.senderId
              }
            } : undefined
          })
        }

        if (!cancelled) setMessages(decryptedMessages)
      } catch (err) {
        console.error('[DM] Failed to load messages:', err)
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    load()
    return () => { cancelled = true }
  }, [conversationId, tokenId])

  const sendMessage = useCallback(async (content: string) => {
    if (!conversationId || !tokenId) return

    setIsSending(true)
    try {
      const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId)
      if (!sharedSecret) throw new Error('Cannot encrypt: shared secret not available. Try re-enabling DMs.')

      const encryptedPayload = await encrypt(content, sharedSecret)

      const msg = await apiFetch('/api/dm/messages', {
        method: 'POST',
        body: JSON.stringify({
          conversationId,
          senderId: tokenId,
          encryptedPayload,
          contentType: 'text'
        })
      })

      // Add decrypted message to local state optimistically
      setMessages(prev => [...prev, {
        id: msg.id,
        content,
        senderId: tokenId,
        createdAt: msg.createdAt,
        status: 'SENT',
        conversationId,
        isFromCurrentUser: true,
        sender: msg.sender ? {
          user: {
            username: msg.sender.user?.username || 'Unknown',
            displayName: msg.sender.user?.displayName,
            avatarUrl: msg.sender.user?.avatarUrl,
            tokenId
          }
        } : undefined
      }])
    } finally {
      setIsSending(false)
    }
  }, [conversationId, tokenId])

  const markAsRead = useCallback(async () => {
    if (!tokenId || messages.length === 0) return

    const unreadIds = messages
      .filter(m => !m.isFromCurrentUser)
      .map(m => m.id)

    if (unreadIds.length === 0) return

    try {
      await apiFetch('/api/dm/messages/read', {
        method: 'POST',
        body: JSON.stringify({ messageIds: unreadIds, userId: tokenId })
      })
    } catch (err) {
      console.error('[DM] Failed to mark messages as read:', err)
    }
  }, [tokenId, messages])

  // Handle incoming WebSocket messages
  const addIncomingMessage = useCallback(async (encryptedMsg: any) => {
    if (encryptedMsg.conversationId !== conversationId) return
    if (encryptedMsg.senderId === tokenId) return // Skip own messages

    try {
      const sharedSecret = await getOrComputeSharedSecret(conversationId, tokenId!)
      let content = '[Encrypted]'
      if (sharedSecret) {
        try {
          content = await decrypt(encryptedMsg.encryptedPayload, sharedSecret)
        } catch {
          content = '[Unable to decrypt]'
        }
      }

      setMessages(prev => {
        if (prev.some(m => m.id === encryptedMsg.id)) return prev
        return [...prev, {
          id: encryptedMsg.id,
          content,
          senderId: encryptedMsg.senderId,
          createdAt: encryptedMsg.createdAt,
          status: encryptedMsg.status || 'SENT',
          conversationId: encryptedMsg.conversationId,
          isFromCurrentUser: false,
          sender: encryptedMsg.sender ? {
            user: {
              username: encryptedMsg.sender.user?.username || 'Unknown',
              displayName: encryptedMsg.sender.user?.displayName,
              avatarUrl: encryptedMsg.sender.user?.avatarUrl,
              tokenId: encryptedMsg.senderId
            }
          } : undefined
        }]
      })
    } catch (err) {
      console.error('[DM] Failed to process incoming message:', err)
    }
  }, [conversationId, tokenId])

  const getSharedSecret = useCallback(async (): Promise<CryptoKey | null> => {
    if (!conversationId || !tokenId) return null
    return getOrComputeSharedSecret(conversationId, tokenId)
  }, [conversationId, tokenId])

  return { messages, isLoading, isSending, sendMessage, markAsRead, addIncomingMessage, peerLastReadAt, getSharedSecret }
}

/**
 * Get or compute the shared secret for a conversation.
 * Fetches the peer's public key if needed.
 */
async function getOrComputeSharedSecret(
  conversationId: string,
  currentUserId: number
): Promise<CryptoKey | null> {
  if (!privateKeyRef) return null

  try {
    // Fetch conversation participants to find the peer
    const data = await apiFetch<{ conversations: any[] }>(`/api/dm/conversations?userId=${currentUserId}`)
    const conv = data.conversations?.find((c: any) => c.id === conversationId)
    if (!conv) return null

    const peer = conv.participants.find((p: any) => p.userId !== currentUserId)
    if (!peer) return null

    // Get peer's public key
    const peerData = await fetch(`${API_HOST}/api/dm/identity/${peer.userId}`).then(r => r.json())
    if (!peerData.publicKey) return null

    return computeSharedSecret(privateKeyRef, peerData.publicKey, conversationId)
  } catch (err) {
    console.error('[DM] Failed to compute shared secret:', err)
    return null
  }
}
